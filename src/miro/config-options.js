/**
 * Miro 内置 agent 的 configOptions。
 *
 * 结构与 ACP 的 select 选项同构，好让 src/acp/model.js 的
 * category → id → name 三级匹配、src/acp/config-options.js 的模糊匹配
 * 与 ConfigPanel 都无需区分来源。
 *
 * 模型目录优先读 ~/.miro/models.json（providers 表）；文件为空
 * 时才回退 settings.miro.models。选中某条目录模型会带上它自己的
 * baseUrl / api / apiKey，不能再靠全局 protocol 开关去改上游。
 */

import { DEFAULT_RETRY_BASE_MS, DEFAULT_STREAM_MAX_RETRIES } from "./llm-provider.js";
import { findCatalogModel } from "./models-file.js";
import { normalizePermissionMode } from "./permission-mode.js";
import { MIRO_PROVIDER_ID } from "../config.js";
import {
  normalizeDisabledTools,
  readEffortPreference,
  readModelPreference,
} from "../settings.js";
import { activeToolDefinitions } from "./tools/index.js";

export const MIRO_PROTOCOL_CHOICES = [
  { value: "chat-completions", name: "OpenAI Chat Completions" },
  { value: "openai-responses", name: "OpenAI Responses" },
  { value: "openai-codex-responses", name: "OpenAI Codex Responses" },
  { value: "anthropic-messages", name: "Anthropic Messages" },
];

export const DEFAULT_MIRO_PROTOCOL = MIRO_PROTOCOL_CHOICES[0].value;

export function normalizeMiroProtocol(value) {
  if (value === "openai-completions") return DEFAULT_MIRO_PROTOCOL;
  return MIRO_PROTOCOL_CHOICES.some((choice) => choice.value === value)
    ? value
    : DEFAULT_MIRO_PROTOCOL;
}

export function defaultBaseUrlForProtocol(protocol) {
  return protocol === "anthropic-messages"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1";
}

/** settings.miro 的兼容档位；目录模型则按 thinkingLevelMap 动态生成。 */
export const EFFORT_CHOICES = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

const CATALOG_EFFORT_CHOICES = [
  { value: "minimal", name: "Minimal" },
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra High" },
  { value: "max", name: "Max" },
];
const STANDARD_CATALOG_LEVELS = new Set(["minimal", "low", "medium", "high"]);

/** 默认模型表；~/.miro/models.json 与 settings.miro.models 都缺时才用。 */
export const DEFAULT_MIRO_MODELS = [
  { id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128_000 },
  { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 64_000 },
];

function selectOption({ id, name, category, currentValue, options }) {
  return {
    id,
    name,
    category,
    type: "select",
    currentValue,
    options,
  };
}

function toolDisplayName(name) {
  return name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function modelPickerOption(entry) {
  return {
    value: entry.key ?? entry.id,
    name: entry.name ?? entry.id,
    id: entry.id,
  };
}

function modelPickerOptions(models) {
  const grouped = models.some((entry) => entry.fromCatalog && entry.provider);
  if (!grouped) {
    return models.map(modelPickerOption);
  }

  const groups = [];
  const index = new Map();
  for (const entry of models) {
    const group = entry.provider || "miro";
    if (!index.has(group)) {
      const item = { name: group, options: [] };
      index.set(group, item);
      groups.push(item);
    }
    index.get(group).options.push(modelPickerOption(entry));
  }
  return groups;
}

function selectedModelEntry(models, model) {
  return findCatalogModel(models, model);
}

/**
 * thinkingLevelMap 是稀疏三态表：
 * - string：支持，并把标准档位映射成这个上游值；
 * - null：不支持，从 picker 隐藏；
 * - 缺省：minimal..high 使用同名默认映射，xhigh / max 不支持。
 */
export function effortChoicesForModel(models, model) {
  const entry = selectedModelEntry(models, model);
  if (!entry?.fromCatalog) return EFFORT_CHOICES;
  if (!entry.reasoning) return [];

  const map = entry.thinkingLevelMap ?? {};
  return CATALOG_EFFORT_CHOICES.filter(({ value }) => {
    if (Object.hasOwn(map, value)) return typeof map[value] === "string";
    return STANDARD_CATALOG_LEVELS.has(value);
  });
}

export function normalizeEffortForModel(models, model, effort) {
  const choices = effortChoicesForModel(models, model);
  if (choices.some((choice) => choice.value === effort)) return effort;
  return choices.find((choice) => choice.value === "medium")?.value
    ?? choices[0]?.value
    ?? null;
}

/** 把 UI / settings 使用的标准档位换成模型声明的上游值。 */
export function mappedEffortForModel(models, model, effort) {
  const normalized = normalizeEffortForModel(models, model, effort);
  if (normalized == null) return null;
  const entry = selectedModelEntry(models, model);
  const mapped = entry?.thinkingLevelMap?.[normalized];
  return typeof mapped === "string" ? mapped : normalized;
}

/** 从模型定义表构造 configOptions。 */
export function buildConfigOptions({
  models,
  model,
  effort,
  thinking,
  disabledTools = [],
  sandboxEnabled = false,
  protocol = DEFAULT_MIRO_PROTOCOL,
  includeProtocol = true,
}) {
  const options = [];
  if (includeProtocol) {
    options.push(selectOption({
      id: "protocol",
      name: "API Protocol",
      category: "api",
      currentValue: normalizeMiroProtocol(protocol),
      options: MIRO_PROTOCOL_CHOICES,
    }));
  }
  options.push(
    selectOption({
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: modelPickerOptions(models),
    }),
    selectOption({
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      currentValue: effort,
      options: effortChoicesForModel(models, model),
    }),
    selectOption({
      id: "enable_thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: thinking ? "on" : "off",
      options: [
        { value: "off", name: "Off" },
        { value: "on", name: "On" },
      ],
    }),
    selectOption({
      id: "sandbox",
      name: "Sandbox",
      category: "tools",
      currentValue: sandboxEnabled ? "on" : "off",
      options: [
        { value: "off", name: "Off" },
        { value: "on", name: "On" },
      ],
    }),
  );
  const disabled = new Set(normalizeDisabledTools(disabledTools));
  const definitions = activeToolDefinitions(sandboxEnabled);
  const disabledCount = definitions.filter((definition) => disabled.has(definition.name)).length;
  options.push({
    id: "tools",
    name: "Tools",
    category: "tools",
    type: "tools",
    currentValue: disabledCount === 0 ? "All enabled" : `${disabledCount} disabled`,
    tools: definitions.map((definition) => selectOption({
      id: `tool:${definition.name}`,
      name: toolDisplayName(definition.name),
      category: "tools",
      currentValue: disabled.has(definition.name) ? "disabled" : "enabled",
      options: [
        { value: "enabled", name: "Enabled" },
        { value: "disabled", name: "Disabled" },
      ],
    })),
  });
  return options;
}

function withModelKeys(entries) {
  return entries.map((entry) => ({
    ...entry,
    key: entry.key ?? entry.id,
    fromCatalog: Boolean(entry.fromCatalog),
  }));
}

/** 归一化模型定义表；空表回退到默认表，避免会话里出现无模型可切。 */
export function normalizeModels(models) {
  if (!Array.isArray(models)) return withModelKeys(DEFAULT_MIRO_MODELS.map((entry) => ({ ...entry })));
  const parsed = models
    .filter((entry) => typeof entry === "string" || typeof entry?.id === "string")
    .map((entry) =>
      typeof entry === "string"
        ? { id: entry, name: entry, contextWindow: null }
        : {
            id: entry.id,
            name: typeof entry.name === "string" ? entry.name : entry.id,
            contextWindow: Number.isFinite(entry.contextWindow) ? entry.contextWindow : null,
          },
    );
  const source = parsed.length > 0 ? parsed : DEFAULT_MIRO_MODELS.map((entry) => ({ ...entry }));
  return withModelKeys(source);
}

function fallbackConnection(config, protocol, env) {
  const configuredBaseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim().length > 0
    ? config.baseUrl.trim()
    : env.MIRO_BASE_URL ?? null;
  const configuredApiKey = typeof config.apiKey === "string" && config.apiKey.trim().length > 0
    ? config.apiKey.trim()
    : env.MIRO_API_KEY ?? null;
  const protocolApiKey = protocol === "anthropic-messages"
    ? env.ANTHROPIC_API_KEY
    : env.OPENAI_API_KEY;

  return {
    protocol,
    baseUrl: configuredBaseUrl ?? defaultBaseUrlForProtocol(protocol),
    apiKey: configuredApiKey ?? protocolApiKey ?? "",
    apiKeyRaw: configuredApiKey ?? protocolApiKey ?? "",
    baseUrlExplicit: configuredBaseUrl != null,
    apiKeyExplicit: configuredApiKey != null,
    headers: null,
    compat: null,
    maxTokens: null,
    samplingParams: null,
  };
}

function connectionFromCatalog(entry) {
  return {
    protocol: normalizeMiroProtocol(entry.api),
    baseUrl: entry.baseUrl,
    apiKey: "",
    apiKeyRaw: entry.apiKey ?? "",
    baseUrlExplicit: true,
    apiKeyExplicit: typeof entry.apiKey === "string" && entry.apiKey.length > 0,
    headers: entry.headers,
    compat: entry.compat,
    maxTokens: entry.maxTokens ?? null,
    samplingParams: entry.samplingParams,
  };
}

/** 按当前选中的模型条目覆写连接参数。 */
export function applyModelConnection(config, entry) {
  if (!entry) return config;
  const connection = entry.fromCatalog ? connectionFromCatalog(entry) : {
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    apiKeyRaw: config.apiKeyRaw ?? config.apiKey,
    baseUrlExplicit: config.baseUrlExplicit,
    apiKeyExplicit: config.apiKeyExplicit,
    headers: null,
    compat: null,
    maxTokens: null,
    samplingParams: null,
  };
  config.model = entry.key;
  config.apiModel = entry.id;
  Object.assign(config, connection);
  config.effort = normalizeEffortForModel(config.models, entry.key, config.effort);
  return config;
}

/**
 * 从 settings 读取 miro 配置：连接参数 / 模型表 / 默认选择。
 *
 * `catalog` 来自 models.json；非空时它就是模型表，settings.miro.models 不再
 * 参与。selectedModel 用于 /model 切换后重读目录仍对准同一条。
 */
export function readMiroConfig(settings = {}, { catalog = [], env = process.env, selectedModel = null } = {}) {
  const miro = settings?.miro;
  const config = miro && typeof miro === "object" && !Array.isArray(miro) ? miro : {};
  const protocol = normalizeMiroProtocol(config.protocol ?? env.MIRO_PROTOCOL);
  const fromFile = Array.isArray(catalog) && catalog.length > 0;
  const models = fromFile ? catalog : normalizeModels(config.models);

  // 顶层 model / effort 就是 miro 的持久偏好（saveModel / withPreference 写在顶层）。
  // 目录模型的 key 固定为 provider/id，和 settings 里记下的值对齐。启动选择必须
  // 读它：否则新建会话要等 App 补一次 setModel，而恢复会话（刻意不套偏好）会静默
  // 停在目录的第一个模型上。偏好匹配不到目录条目时才退回 miro.model。
  const preferredModel = readModelPreference(settings, MIRO_PROVIDER_ID);
  const requestedModel = selectedModel
    ?? (preferredModel != null && findCatalogModel(models, preferredModel) ? preferredModel : null)
    ?? (typeof config.model === "string" ? config.model : null);
  const selected = findCatalogModel(models, requestedModel) ?? models[0];

  const requestedEffort = readEffortPreference(settings, MIRO_PROVIDER_ID)
    ?? (typeof config.effort === "string" ? config.effort : null);

  const result = {
    ...fallbackConnection(config, protocol, env),
    models,
    model: selected.key,
    apiModel: selected.id,
    effort: requestedEffort ?? "medium",
    thinking: config.thinking !== false,
    permissionMode: normalizePermissionMode(config.permissionMode),
    sandboxEnabled: config.sandbox?.enabled === true,
    // 默认不限轮次：上下文由自动压缩兜底，硬上限只会把正常的长任务报成
    // max_turns。想止损的用户自己在 settings 里写数字。
    maxToolRounds: Number.isFinite(config.maxToolRounds) ? config.maxToolRounds : Infinity,
    // 只有显式写 false 才关闭：缺省和写坏都视为开启，否则一次配置手误
    // 会让长会话静默地一路撞到上下文上限。
    autoCompact: config.autoCompact !== false,
    // 没有这两个默认值，agent-loop 会把 undefined 原样透传下去（它刻意
    // 「不填默认值、交给 backend 决定」），于是 settings 里调多少都不生效。
    streamMaxRetries: Number.isFinite(config.streamMaxRetries)
      ? config.streamMaxRetries
      : DEFAULT_STREAM_MAX_RETRIES,
    retryBaseDelayMs: Number.isFinite(config.retryBaseDelayMs)
      ? config.retryBaseDelayMs
      : DEFAULT_RETRY_BASE_MS,
    temperature: Number.isFinite(config.temperature) ? config.temperature : null,
    disabledTools: normalizeDisabledTools(settings?.disableTools),
  };
  applyModelConnection(result, selected);
  return result;
}

/** 取模型的上下文窗口，未知时回退到 128k。 */
export function contextWindowOf(models, modelId, fallback = 128_000) {
  const hit = models.find((entry) => entry.key === modelId || entry.id === modelId);
  return hit?.contextWindow ?? fallback;
}
