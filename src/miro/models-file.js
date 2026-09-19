/**
 * miro 模型目录：~/.miro/models.json
 *
 * 按 LLM 提供方列出 baseUrl / api / apiKey / models，而不是把模型扁平成
 * settings.miro.models。ACP 的「provider」是另一回事——这里的 providers
 * 只描述 miro 直连的上游。
 *
 * 文件缺失或损坏视为空目录，回退到 settings.miro；打开 /model 时会重读，
 * 所以改文件不必重启。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { MIRO_DIR, readJsonObject } from "../settings-file.js";
import { PI_AI_PROTOCOLS } from "./pi-ai-backend.js";

export const MODELS_FILE = path.join(MIRO_DIR, "models.json");

export const SUPPORTED_MODEL_APIS = Object.freeze([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "openai-codex-responses",
]);

const COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function normalizeModelApi(value) {
  // settings 里的 protocol 写 chat-completions，目录用 api 字段的取值。
  if (value === "chat-completions") return PI_AI_PROTOCOLS.OPENAI_COMPLETIONS;
  if (SUPPORTED_MODEL_APIS.includes(value)) return value;
  return null;
}

/**
 * apiKey / headers 取值：字面量、环境变量插值、或 `!command`。
 *
 * `!` 只在整个字符串开头触发命令；`$!` / `$$` 转义。缺的环境变量
 * 让整段 unresolved，而不是塞进空字符串——否则看起来像配好了其实没 key。
 */
export function resolveConfigValue(raw, { env = process.env, execCommand = execShellCommand } = {}) {
  if (typeof raw !== "string") return { ok: false, value: "" };
  if (raw.startsWith("!")) {
    const ran = execCommand(raw.slice(1));
    if (!ran.ok) return ran;
    return { ok: true, value: ran.value };
  }
  return interpolate(raw, env);
}

export function resolveHeaders(headers, options) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const resolved = {};
  for (const [name, raw] of Object.entries(headers)) {
    if (typeof name !== "string" || name.length === 0) continue;
    const result = resolveConfigValue(raw, options);
    if (result.ok) resolved[name] = result.value;
  }
  return resolved;
}

function interpolate(text, env) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "$") {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === "$") {
      out += "$";
      i += 1;
      continue;
    }
    if (next === "!") {
      out += "!";
      i += 1;
      continue;
    }
    if (next === "{") {
      const end = text.indexOf("}", i + 2);
      if (end < 0) return { ok: false, value: "" };
      const name = text.slice(i + 2, end);
      if (!Object.hasOwn(env, name)) return { ok: false, value: "" };
      out += env[name] ?? "";
      i = end;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (!match) {
      out += "$";
      continue;
    }
    if (!Object.hasOwn(env, match[0])) return { ok: false, value: "" };
    out += env[match[0]] ?? "";
    i += match[0].length;
  }
  return { ok: true, value: out };
}

function execShellCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) return { ok: false, value: "" };
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return { ok: false, value: "" };
  return { ok: true, value: String(result.stdout ?? "").trim() };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function mergeCompat(providerCompat, modelCompat) {
  const a = asObject(providerCompat);
  const b = asObject(modelCompat);
  if (!a && !b) return null;
  return { ...(a ?? {}), ...(b ?? {}) };
}

function stringOf(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function thinkingLevelMapOf(value) {
  const source = asObject(value);
  if (!source) return null;
  const result = {};
  for (const [level, mapped] of Object.entries(source)) {
    if (!THINKING_LEVELS.has(level)) continue;
    if (mapped === null || typeof mapped === "string") result[level] = mapped;
  }
  return result;
}

/**
 * 把 models.json 展成 picker / 请求都能用的条目。
 *
 * 不在这里执行 `!command`：/model 只看目录在不在，密钥在真正发请求时再解析。
 * 不支持的 api（例如 google-generative-ai）整条丢掉，不让会话起不来。
 */
export function catalogFromModelsFile(parsed, { env = process.env } = {}) {
  const providers = asObject(parsed?.providers);
  if (!providers) return [];

  const pending = [];
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (typeof providerId !== "string" || providerId.length === 0) continue;
    const provider = asObject(rawProvider);
    if (!provider) continue;
    const providerApi = normalizeModelApi(provider.api);
    const providerBaseUrl = stringOf(provider.baseUrl);
    const models = Array.isArray(provider.models) ? provider.models : [];

    for (const rawModel of models) {
      const model = typeof rawModel === "string" ? { id: rawModel } : asObject(rawModel);
      const id = stringOf(model?.id);
      if (!id) continue;
      const api = normalizeModelApi(model.api) ?? providerApi;
      const baseUrl = stringOf(model.baseUrl) ?? providerBaseUrl;
      if (!api || !baseUrl) continue;

      const apiKey = model.apiKey ?? provider.apiKey ?? null;
      const headers = {
        ...(asObject(provider.headers) ?? {}),
        ...(asObject(model.headers) ?? {}),
      };
      pending.push({
        id,
        name: stringOf(model.name) ?? id,
        provider: providerId,
        api,
        baseUrl,
        apiKey: typeof apiKey === "string" ? apiKey : null,
        headers: Object.keys(headers).length > 0 ? headers : null,
        compat: mergeCompat(provider.compat, model.compat),
        reasoning: model.reasoning === true,
        thinkingLevelMap: thinkingLevelMapOf(model.thinkingLevelMap),
        contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : DEFAULT_CONTEXT_WINDOW,
        maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : DEFAULT_MAX_TOKENS,
        samplingParams: asObject(model.samplingParams),
        cost: asObject(model.cost),
        fromCatalog: true,
        key: catalogKey(providerId, id),
      });
    }
  }

  return pending;
}

/**
 * 目录模型的选择键：始终 `provider/id`。settings 顶层的 model 偏好、
 * /model 与 picker value 都写这个，避免两个提供方共用同一 id 时撞车。
 * id 本身可以带斜杠（例如 `deepseek/deepseek-flash`），提供方 id 不能。
 */
export function catalogKey(provider, id) {
  return typeof provider === "string" && provider.length > 0 ? `${provider}/${id}` : id;
}

/** 按 key 去重拼接目录；先出现的条目保留，后出现的同 key 丢掉。 */
export function mergeModelCatalogs(...catalogs) {
  const merged = [];
  const seen = new Set();
  for (const catalog of catalogs) {
    if (!Array.isArray(catalog)) continue;
    for (const entry of catalog) {
      if (!entry?.key || seen.has(entry.key)) continue;
      seen.add(entry.key);
      merged.push(entry);
    }
  }
  return merged;
}

export function loadMiroModelCatalog(file = MODELS_FILE, { env = process.env } = {}) {
  if (!file) return [];
  return catalogFromModelsFile(readJsonObject(file), { env });
}

export function findCatalogModel(models, requested) {
  if (!Array.isArray(models) || models.length === 0) return null;
  if (requested == null || requested === "") return models[0];
  return (
    models.find((entry) => entry.key === requested) ??
    // 旧 settings / --model / /model 可能只写了裸 id。
    models.find((entry) => entry.id === requested) ??
    null
  );
}

/** 请求前解析密钥与自定义头；命令失败时退回空值，由 backend 的占位 key 兜住。 */
export function resolveModelSecrets(entry, options) {
  if (!entry) return { apiKey: "", headers: {} };
  const apiKey = entry.apiKey == null
    ? { ok: true, value: "" }
    : resolveConfigValue(entry.apiKey, options);
  return {
    apiKey: apiKey.ok ? apiKey.value : "",
    headers: resolveHeaders(entry.headers, options),
  };
}
