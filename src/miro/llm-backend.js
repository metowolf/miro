/**
 * miro agent loop 使用的 LLM backend 契约。
 *
 * backend 只负责把一次模型请求翻译成统一的异步事件流，**并自行负责该请求的
 * 重试**；工具循环、消息历史与权限仍由 agent-loop.js 负责。这样协议适配可以
 * 替换，而 agent loop 不需要知道底层是哪种协议。
 *
 * 三条 miro 协议都走 pi-ai：它在建立连接阶段自行退避重试，流一旦开始产出
 * 就不再重放。withStreamRetry 留给自身不带重试的注入实现（单测、将来的自定义
 * backend），对 agent loop 呈现同样的结果——要么拿到一条完整流，要么抛错。
 *
 * 事件契约：
 * - connected: 请求已经建立
 * - text: { text }，可见正文增量
 * - reasoning: { text }，思考增量
 * - reasoning_end: { thinking, thinkingSignature, redacted }，一块思考结束
 * - tool_calls: { calls: [{ id, name, arguments, thoughtSignature? }] }
 * - finish: { reason }，本次模型输出的结束原因
 * - usage: { usage: { inputTokens, outputTokens, totalTokens, thoughtTokens, cost, ... } }
 * - done: 流已结束
 */
import {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_STREAM_MAX_RETRIES,
  backoffDelay,
  isRetryableError,
  sleep,
} from "./llm-provider.js";
import {
  CHAT_COMPLETIONS_PROTOCOL,
  PI_AI_PROTOCOLS,
  anthropicMessagesBackend,
  chatCompletionsBackend,
  openAIResponsesBackend,
  createPiAiBackend,
  piApiForProtocol,
  piProviderForProtocol,
} from "./pi-ai-backend.js";

export { chatCompletionsBackend, piApiForProtocol, piProviderForProtocol };

export const LLM_BACKEND_EVENT_TYPES = Object.freeze([
  "connected",
  "text",
  "reasoning",
  "reasoning_end",
  "tool_calls",
  "finish",
  "usage",
  "done",
]);

export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export class LlmRequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LlmRequestTimeoutError";
    this.code = "LLM_REQUEST_TIMEOUT";
    this.retryable = false;
    this.timeoutMs = timeoutMs;
  }
}

/** 包住一次完整 stream 调用（含 backend 内部重试），统一限制总墙钟。 */
export function withRequestTimeout(streamFn) {
  return async function* streamWithRequestTimeout(requestOptions = {}) {
    const timeoutMs = Number.isFinite(requestOptions.requestTimeoutMs)
      ? Math.max(1, requestOptions.requestTimeoutMs)
      : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    const externalSignal = requestOptions.signal ?? null;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new LlmRequestTimeoutError(timeoutMs));
    }, timeoutMs);

    try {
      for await (const event of streamFn({
        ...requestOptions,
        signal: controller.signal,
        timeoutMs,
      })) {
        if (externalSignal?.aborted) return;
        yield event;
      }
      if (timedOut) throw new LlmRequestTimeoutError(timeoutMs);
    } catch (error) {
      if (externalSignal?.aborted) return;
      if (timedOut) throw new LlmRequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

/** 一旦向外发过这些事件，本轮就不能重来，否则会重复输出。 */
const COMMITTING_EVENT_TYPES = new Set(["text", "reasoning", "reasoning_end", "tool_calls"]);

/**
 * 给自身不带重试的 backend 包一层流重试。
 *
 * 重试的前提是「这一轮还没有产出任何可见内容」：一旦正文/思考已经流给了
 * UI 或工具调用已经攒了一半，重连就意味着重复输出，此时只能把错误抛出去，
 * 于是把「已送出事件」作为不可重试的边界。
 *
 * 重试预算与进度上报从 requestOptions 读取（agent-loop 透传配置与 onRetry），
 * 这样包装层不持有跨轮状态，也不会和为单测注入的裸 stream 冲突。
 */
export function withStreamRetry(streamFn) {
  return async function* streamWithRetry(requestOptions) {
    const {
      maxRetries = DEFAULT_STREAM_MAX_RETRIES,
      retryBaseDelayMs = DEFAULT_RETRY_BASE_MS,
      onRetry = () => {},
      signal = null,
    } = requestOptions ?? {};

    let attempt = 0;

    for (;;) {
      // 只要向外发过一个事件，这一轮就不能重来。
      let committed = false;
      let retryNoticePending = attempt > 0;

      try {
        for await (const event of streamFn(requestOptions)) {
          if (signal?.aborted) return;

          // 连接恢复就收起提示，不能等整条响应流结束；自定义 stream 没有
          // connected 事件时也在首个增量兜底。上限只约束连续失败，恢复后
          // 次数与指数退避一起归零，后续断连从第一次重试重新开始。
          if (retryNoticePending) {
            retryNoticePending = false;
            attempt = 0;
            onRetry(null);
          }

          if (COMMITTING_EVENT_TYPES.has(event.type)) committed = true;
          yield event;
        }
        // 空流没有首个事件，仍需在成功结束时清理一次。
        if (retryNoticePending) onRetry(null);
        return;
      } catch (error) {
        // 取消会中断底层请求并抛出 AbortError，这是预期结局而非失败。
        if (signal?.aborted) return;

        const retryable = isRetryableError(error) && !committed && attempt < maxRetries;
        if (!retryable) {
          onRetry(null);
          throw error;
        }

        attempt += 1;
        // 服务端明确给了等待时间就照办（429 尤其重要），否则指数退避。
        const retryAfterMs = error?.retryAfterMs;
        const delay =
          typeof retryAfterMs === "number" && retryAfterMs >= 0
            ? retryAfterMs
            : backoffDelay(attempt, retryBaseDelayMs);

        // 把重试进度暴露给 UI，避免用户盯着一个看似卡死的界面。
        onRetry({
          attempt,
          maxRetries,
          delayMs: delay,
          status: error?.status ?? null,
          message: error?.message ?? String(error),
        });

        try {
          await sleep(delay, signal);
        } catch {
          return;
        }
      }
    }
  };
}

export function backendForProtocol(protocol) {
  if (protocol === PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES) return anthropicMessagesBackend;
  if (protocol === PI_AI_PROTOCOLS.OPENAI_RESPONSES) return openAIResponsesBackend;
  if (protocol === PI_AI_PROTOCOLS.OPENAI_CODEX_RESPONSES) return createPiAiBackend(protocol);
  if (protocol === PI_AI_PROTOCOLS.OPENAI_COMPLETIONS || protocol === CHAT_COMPLETIONS_PROTOCOL) {
    return chatCompletionsBackend;
  }
  return chatCompletionsBackend;
}

/**
 * 检查 backend 是否满足 agent loop 的最小接口。
 *
 * stream 与 estimateTokens 是唯二必需的成员；重试、退避与错误分类都属于
 * backend 内部实现，不再进入契约。
 */
export function assertLlmBackend(backend) {
  if (!backend || typeof backend.stream !== "function") {
    throw new TypeError("LLM backend must provide a stream(requestOptions) function");
  }
  if (typeof backend.estimateTokens !== "function") {
    throw new TypeError("LLM backend must provide an estimateTokens(text) function");
  }
  return backend;
}
