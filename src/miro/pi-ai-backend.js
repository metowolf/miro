/**
 * 基于 pi-ai 的协议 backend。
 *
 * 这里故意只使用 pi-ai 的 API 适配层，不引入它的 agent loop、工具执行器
 * 或 TUI。miro 仍然拥有消息历史、权限和工具循环；pi-ai 只负责把同一份
 * Context 发给 Chat Completions / Anthropic Messages / OpenAI Responses
 * 并翻译流式事件。
 */
import { createHash } from "node:crypto";

import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

import { isContextOverflowError } from "./compaction.js";
import {
  DEFAULT_STREAM_MAX_RETRIES,
  estimateTokens,
  isRetryableError,
  parseRetryAfterMs,
} from "./llm-provider.js";
import { logUsageDebug, usageDebugEnabled } from "./usage-debug.js";
import { normalizeOutboundMessages } from "./outbound-messages.js";

export const PI_AI_PROTOCOLS = Object.freeze({
  OPENAI_COMPLETIONS: "openai-completions",
  ANTHROPIC_MESSAGES: "anthropic-messages",
  OPENAI_RESPONSES: "openai-responses",
  OPENAI_CODEX_RESPONSES: "openai-codex-responses",
});

/** settings /config 里的历史 id；内部协议名是 openai-completions。 */
export const CHAT_COMPLETIONS_PROTOCOL = "chat-completions";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function piApiForProtocol(protocol) {
  if (protocol === PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES) return PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES;
  if (protocol === PI_AI_PROTOCOLS.OPENAI_RESPONSES) return PI_AI_PROTOCOLS.OPENAI_RESPONSES;
  if (protocol === PI_AI_PROTOCOLS.OPENAI_CODEX_RESPONSES) return PI_AI_PROTOCOLS.OPENAI_CODEX_RESPONSES;
  return PI_AI_PROTOCOLS.OPENAI_COMPLETIONS;
}

export function piProviderForProtocol(protocol) {
  return piApiForProtocol(protocol) === PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES ? "anthropic" : "openai";
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
    .join("\n");
}

function toolArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { _raw: value };
  }
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...ZERO_COST, total: 0 },
  };
}

function thinkingBlocksOf(message) {
  if (Array.isArray(message.thinking_blocks) && message.thinking_blocks.length > 0) {
    return message.thinking_blocks.filter((block) => block && typeof block === "object");
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    return [{ thinking: message.reasoning_content }];
  }
  return [];
}

function toPiAssistantMessage(message, index, model) {
  const content = [];
  // Anthropic 要求 thinking 出现在正文和 tool_call 之前；其它协议不在意顺序。
  for (const block of thinkingBlocksOf(message)) {
    const thinking = typeof block.thinking === "string" ? block.thinking : "";
    const thinkingSignature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : "";
    if (thinking.length === 0 && thinkingSignature.length === 0) continue;
    content.push({
      type: "thinking",
      thinking,
      ...(thinkingSignature.length > 0 ? { thinkingSignature } : {}),
      ...(block.redacted ? { redacted: true } : {}),
    });
  }

  const text = textContent(message.content);
  if (text.length > 0) content.push({ type: "text", text });

  for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
    const name = call?.function?.name ?? call?.name ?? "";
    if (!name) continue;
    const thoughtSignature = call.thought_signature ?? call.thoughtSignature;
    content.push({
      type: "toolCall",
      id: call.id || `miro-history-${index}-${callIndex}`,
      name,
      arguments: toolArguments(call?.function?.arguments ?? call.arguments),
      ...(typeof thoughtSignature === "string" && thoughtSignature.length > 0
        ? { thoughtSignature }
        : {}),
    });
  }

  const api = message.pi_api ?? model.api;
  const provider = message.pi_provider ?? model.provider;
  const modelId = message.pi_model ?? model.id;

  return {
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    api,
    provider,
    model: modelId,
    usage: zeroUsage(),
    stopReason: message.tool_calls?.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/**
 * Anthropic 要求 tool id 匹配 ^[a-zA-Z0-9_-]{1,64}$。
 * Responses 常给出带 `|` 的超长 id；切协议时必须改写成稳定短 id，
 * 并让对应的 toolResult 一起改，否则下一轮直接 400。
 */
function normalizeToolCallId(id, model) {
  const raw = String(id ?? "");
  if (model.api !== PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES) return raw;
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return raw;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 48);
  return `id_${digest}`;
}

function toPiContext(messages, tools, model) {
  const system = [];
  const converted = [];
  const toolNames = new Map();

  for (const [index, message] of normalizeOutboundMessages(messages).entries()) {
    if (message?.role === "system") {
      const text = textContent(message.content);
      if (text.length > 0) system.push(text);
      continue;
    }

    if (message?.role === "user") {
      converted.push({
        role: "user",
        content: typeof message.content === "string" ? message.content : textContent(message.content),
        timestamp: Date.now(),
      });
      continue;
    }

    if (message?.role === "assistant") {
      const assistant = toPiAssistantMessage(message, index, model);
      for (const block of assistant.content) {
        if (block.type === "toolCall") toolNames.set(block.id, block.name);
      }
      converted.push(assistant);
      continue;
    }

    if (message?.role === "tool") {
      const toolCallId = String(message.tool_call_id ?? `miro-tool-${index}`);
      converted.push({
        role: "toolResult",
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? "unknown_tool",
        content: [{ type: "text", text: textContent(message.content) }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  const convertedTools = (tools ?? [])
    .map((schema) => schema?.function)
    .filter((tool) => tool?.name && tool?.parameters)
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters,
    }));

  return {
    ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
    messages: transformMessages(converted, model, normalizeToolCallId),
    ...(convertedTools.length > 0 ? { tools: convertedTools } : {}),
  };
}

function stripKnownSuffix(url, suffix) {
  return url.endsWith(suffix) ? url.slice(0, -suffix.length) : url;
}

function normalizeBaseUrl(protocol, configuredBaseUrl) {
  const url = String(configuredBaseUrl ?? "").replace(/\/+$/, "");
  if (protocol === PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES) {
    // Anthropic SDK 自己会拼 /v1/messages；settings 里常见的 /v1 不能再留。
    return stripKnownSuffix(url, "/v1");
  }
  if (protocol === PI_AI_PROTOCOLS.OPENAI_COMPLETIONS) {
    return stripKnownSuffix(url, "/chat/completions");
  }
  if (protocol === PI_AI_PROTOCOLS.OPENAI_RESPONSES) {
    return stripKnownSuffix(url, "/responses");
  }
  return url;
}

/**
 * 官方 OpenAI 走 SDK 默认 compat；其它 endpoint（vLLM / DeepSeek 网关 / 桩服务）
 * 拒绝 store、strict、max_completion_tokens 这些字段的概率更高，按旧手写
 * 客户端的最小请求体对齐。
 */
function completionsCompat(baseUrl) {
  if (baseUrl.includes("api.openai.com")) return null;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
    supportsUsageInStreaming: true,
  };
}

function mergeCompat(protocol, baseUrl, configured) {
  const auto = protocol === PI_AI_PROTOCOLS.OPENAI_COMPLETIONS ? completionsCompat(baseUrl) : null;
  const override = configured && typeof configured === "object" && !Array.isArray(configured)
    ? configured
    : null;
  if (!auto && !override) return null;
  return { ...(auto ?? {}), ...(override ?? {}) };
}

function modelFor(protocol, requestOptions) {
  const provider = piProviderForProtocol(protocol);
  const baseUrl = normalizeBaseUrl(protocol, requestOptions.baseUrl);
  const compat = mergeCompat(protocol, baseUrl, requestOptions.compat);
  const headers = requestOptions.headers && typeof requestOptions.headers === "object"
    ? requestOptions.headers
    : null;
  const cost = requestOptions.cost && typeof requestOptions.cost === "object"
    ? requestOptions.cost
    : { ...ZERO_COST };
  return {
    id: requestOptions.model,
    name: requestOptions.model,
    api: protocol,
    provider,
    baseUrl,
    reasoning: Boolean(requestOptions.effort) || requestOptions.reasoning === true,
    ...(requestOptions.thinkingLevelMap ? { thinkingLevelMap: requestOptions.thinkingLevelMap } : {}),
    input: ["text"],
    cost: { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 },
    contextWindow: requestOptions.contextWindow ?? 128_000,
    // Anthropic 请求体必须带 max_tokens；其它协议把这个当模型能力上限。
    maxTokens: requestOptions.maxTokens ?? 8_192,
    ...(requestOptions.samplingParams ? { samplingParams: requestOptions.samplingParams } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(compat ? { compat } : {}),
  };
}

/**
 * 把 pi-ai 的 error 事件转成带分类信息的异常。
 *
 * retryable 不能只信上游那个字段：兼容网关经常把限流标成别的类型（见过
 * 429 配 `"type":"requestAuthError"` 的），照抄就会把该重试的限流当成
 * 凭据错误一次性抛掉。status 是握在手里的事实，所以拿到 status 时按
 * isRetryableError 的同一套规则自行判定，与上游的 true 取并集。
 *
 * 只在 status 存在时才覆核：isRetryableError 对「无 status」返回 true
 * （fetch 的网络错误归传输层），但 pi-ai 已经把 HTTP 响应解析过一遍，
 * 走到这里还没有 status 的是它自己的请求构造/解析错误，重试只会重复失败。
 */
function errorFromPiEvent(event) {
  const source = event?.error;
  const error = new Error(source?.errorMessage ?? "pi-ai provider request failed");
  const status = typeof source?.status === "number" ? source.status : null;
  if (status != null) error.status = status;
  if (source?.retryable === true || (status != null && isRetryableError(error))) {
    error.retryable = true;
  }
  // 上下文超窗要压过上游的 retryable：原样重发的请求还是同样长，重试只会
  // 把预算烧完，而 agent-loop 需要看到这个信号去做一次压缩再重来。
  if (isContextOverflowError(error)) {
    error.retryable = false;
    error.contextOverflow = true;
  }
  const retryAfterMs = retryAfterFromPiError(source);
  if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
  return error;
}

/**
 * 捞服务端给的等待时间。
 *
 * pi-ai 的 error 事件不一定带 Headers 对象，所以先看结构化字段，再退回
 * 正文文案。parseRetryAfterMs 的正文正则只认英文（`try again in 1.5s`），
 * 中文网关的「请稍后再试」匹配不上，那种情况返回 null 交给指数退避。
 */
function retryAfterFromPiError(source) {
  if (!source) return null;
  const headers = source.headers;
  // Headers 实例有 get()；普通对象要自己包一层再喂给 parseRetryAfterMs。
  const lookup = typeof headers?.get === "function"
    ? headers
    : headers && typeof headers === "object"
      ? { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null }
      : null;
  return parseRetryAfterMs(lookup, source.errorMessage ?? "");
}

function apiFor(protocol) {
  if (protocol === PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES) return anthropicMessagesApi();
  if (protocol === PI_AI_PROTOCOLS.OPENAI_RESPONSES) return openAIResponsesApi();
  if (protocol === PI_AI_PROTOCOLS.OPENAI_CODEX_RESPONSES) return openAICodexResponsesApi();
  return openAICompletionsApi();
}

function streamOptionsFor(protocol, requestOptions) {
  const headers = requestOptions.headers && typeof requestOptions.headers === "object"
    ? requestOptions.headers
    : null;
  const options = {
    // 本地网关经常不需要 key；pi-ai 缺 key 会直接抛，用占位符保住旧行为。
    apiKey: requestOptions.apiKey || "unused",
    signal: requestOptions.signal,
    fetch: requestOptions.fetchImpl,
    ...(Number.isFinite(requestOptions.timeoutMs) ? { timeoutMs: requestOptions.timeoutMs } : {}),
    ...(typeof requestOptions.temperature === "number" ? { temperature: requestOptions.temperature } : {}),
    ...(requestOptions.samplingParams ? { samplingParams: requestOptions.samplingParams } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    maxRetries: typeof requestOptions.maxRetries === "number"
      ? requestOptions.maxRetries
      : DEFAULT_STREAM_MAX_RETRIES,
  };

  if (protocol === PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES) {
    const thinking = requestOptions.compat?.supportsReasoningEffort === false
      ? false
      : Boolean(requestOptions.effort);
    options.thinkingEnabled = thinking;
    if (thinking && requestOptions.effort) options.effort = requestOptions.effort;
    return options;
  }

  if (requestOptions.effort && requestOptions.compat?.supportsReasoningEffort !== false) {
    options.reasoningEffort = requestOptions.effort;
  }
  if (protocol === PI_AI_PROTOCOLS.OPENAI_RESPONSES) {
    options.reasoningSummary = requestOptions.effort ? "auto" : null;
  }
  return options;
}

function usageFromPi(usage) {
  if (!usage || typeof usage !== "object") return null;
  const totalCost = usage.cost?.total;
  const normalized = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
    thoughtTokens: typeof usage.reasoning === "number" ? usage.reasoning : null,
    cost: typeof totalCost === "number" && totalCost > 0
      ? { amount: totalCost, currency: "USD" }
      : null,
  };
  // 原始 pi-ai usage 也一并打出：归一化只留这六个字段，网关多给的字段
  // （例如 prompt_tokens_details 没被 pi-ai 认识的键）只能靠原样看。
  logUsageDebug("backend", { raw: usage, normalized });
  return normalized;
}

/**
 * 调试用：把 SSE 响应体读全，挑出带 usage 的分片打到 stderr，再原样放回一个
 * 新的 Response。会牺牲流式（正文等响应结束才吐），只在 MIRO_DEBUG_USAGE 打开
 * 时启用，用来确认网关到底上报了哪些字段。
 */
function withUsageLogging(fetchImpl) {
  const base = fetchImpl ?? globalThis.fetch;
  return async (url, init) => {
    const response = await base(url, init);
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) return response;
    const text = await response.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]" || !data.includes('"usage"')) continue;
      logUsageDebug("sse", data);
    }
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function finishReasonFromDone(event) {
  const raw = event.message?.rawStopReason;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (event.reason === "toolUse") return "tool_calls";
  return event.reason;
}

function thinkingBlockAt(event) {
  const block = event.partial?.content?.[event.contentIndex];
  return block?.type === "thinking" ? block : null;
}

async function* streamPiAi(protocol, requestOptions) {
  // 订阅 provider 必须通过它原始的 Models 实例发请求：这里会取出、必要时刷新
  // OAuth token，并保留 provider 专属 headers/baseUrl。自定义 models.json 仍走下方
  // 的临时 API-key provider，兼容原有行为。
  const oauthModel = requestOptions.oauthProvider && requestOptions.oauthModels
    ? requestOptions.oauthModels.getModel(requestOptions.oauthProvider, requestOptions.model)
    : null;
  if (oauthModel) {
    const options = streamOptionsFor(protocol, requestOptions);
    // Models.applyAuth 规定显式 apiKey 优先；不能把旧兼容路径的 "unused"
    // 占位符传给同时支持 API key 的 OAuth provider，否则会绕开 OAuth refresh。
    delete options.apiKey;
    if (usageDebugEnabled()) options.fetch = withUsageLogging(options.fetch);
    const stream = requestOptions.oauthModels.stream(
      oauthModel,
      toPiContext(requestOptions.messages, requestOptions.tools, oauthModel),
      options,
    );
    for await (const event of stream) yield* translatePiEvent(event);
    return;
  }
  const model = modelFor(protocol, requestOptions);
  const provider = createProvider({
    id: model.provider,
    name: model.provider,
    baseUrl: model.baseUrl,
    ...(model.headers ? { headers: model.headers } : {}),
    auth: { apiKey: envApiKeyAuth("Miro API key", []) },
    models: [model],
    api: { [protocol]: apiFor(protocol) },
  });
  const models = createModels();
  models.setProvider(provider);

  const streamOptions = streamOptionsFor(protocol, requestOptions);
  if (usageDebugEnabled()) streamOptions.fetch = withUsageLogging(streamOptions.fetch);
  const stream = models.stream(
    model,
    toPiContext(requestOptions.messages, requestOptions.tools, model),
    streamOptions,
  );
  for await (const event of stream) yield* translatePiEvent(event);
}

function* translatePiEvent(event) {
    switch (event.type) {
      case "start":
        yield { type: "connected" };
        break;
      case "text_delta":
        if (event.delta) yield { type: "text", text: event.delta };
        break;
      case "thinking_delta":
        if (event.delta) yield { type: "reasoning", text: event.delta };
        break;
      case "thinking_end": {
        const block = thinkingBlockAt(event);
        yield {
          type: "reasoning_end",
          thinkingSignature: typeof block?.thinkingSignature === "string" ? block.thinkingSignature : "",
          redacted: Boolean(block?.redacted),
          thinking: typeof event.content === "string" ? event.content : block?.thinking ?? "",
        };
        break;
      }
      case "toolcall_end":
        yield {
          type: "tool_calls",
          calls: [{
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments ?? {}),
            ...(typeof event.toolCall.thoughtSignature === "string" && event.toolCall.thoughtSignature.length > 0
              ? { thoughtSignature: event.toolCall.thoughtSignature }
              : {}),
          }],
        };
        break;
      case "done": {
        yield { type: "finish", reason: finishReasonFromDone(event) };
        const usage = usageFromPi(event.message?.usage);
        if (usage) yield { type: "usage", usage };
        yield { type: "done" };
        break;
      }
      case "error":
        throw errorFromPiEvent(event);
    }
}

export function createPiAiBackend(protocol) {
  if (!Object.values(PI_AI_PROTOCOLS).includes(protocol)) {
    throw new Error(`unsupported pi-ai protocol: ${protocol}`);
  }
  return Object.freeze({
    id: `pi-ai:${protocol}`,
    stream: (requestOptions) => streamPiAi(protocol, requestOptions),
    estimateTokens,
  });
}

export const openAICompletionsBackend = createPiAiBackend(PI_AI_PROTOCOLS.OPENAI_COMPLETIONS);
export const anthropicMessagesBackend = createPiAiBackend(PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES);
export const openAIResponsesBackend = createPiAiBackend(PI_AI_PROTOCOLS.OPENAI_RESPONSES);
/** settings 仍写 chat-completions，实现就是 Completions 这条 pi-ai 协议。 */
export const chatCompletionsBackend = openAICompletionsBackend;
