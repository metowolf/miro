import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMiroProvider, PROVIDERS } from "./config.js";
import { readSystemSettings } from "./settings-file.js";

/** PATH 探测，不 spawn。 */

function binExists(bin) {
  if (bin.includes(path.sep)) return existsSync(bin);
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return dirs.some((dir) => dir !== "" && existsSync(path.join(dir, bin)));
}

/** session/new 的 `_meta` 必须是普通对象；数组/标量无法按 ACP 扩展字段发送。 */
export function normalizeSessionMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

/** 将 settings.json 中的单个 provider 定义归一化。 */
function normalizeCustomProvider(id, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  const command = definition.command ?? definition.bin;
  if (typeof command !== "string" || command.trim().length === 0) return null;
  const args = Array.isArray(definition.args)
    ? definition.args.filter((arg) => typeof arg === "string")
    : [];
  const name =
    typeof definition.name === "string" && definition.name.trim().length > 0 ? definition.name : id;
  const sessionMeta = normalizeSessionMeta(definition.sessionMeta);
  return sessionMeta != null
    ? { id, name, bin: command.trim(), args, sessionMeta }
    : { id, name, bin: command.trim(), args };
}

/** 解析 settings 的 providers 字段。 */
export function readCustomProviders(settings = readSystemSettings()) {
  const raw = settings?.providers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .map(([id, definition]) => normalizeCustomProvider(id, definition))
    .filter((provider) => provider != null);
}

/**
 * 合并内置与自定义 provider；同名 id 以自定义定义为准。
 *
 * 顺序是「自定义 → 内置 → miro」；启动默认固定 miro，不依赖这个顺序。
 */
export function loadProviders(settings = readSystemSettings()) {
  const custom = readCustomProviders(settings);
  if (custom.length === 0) return PROVIDERS;
  const builtin = PROVIDERS.filter(
    (provider) => !custom.some((entry) => entry.id === provider.id),
  );
  return [...custom, ...builtin];
}

/** Miro 自带实现，没有二进制可探测，恒为可用。 */
function providerAvailable(provider) {
  if (isMiroProvider(provider)) return true;
  return binExists(provider.bin ?? "");
}

export function detectProviders(providers = loadProviders()) {
  return providers.filter((provider) => providerAvailable(provider));
}
