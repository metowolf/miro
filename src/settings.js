import {
  writeSystemSettings,
  writeSystemSettingsField,
  readSystemSettings,
  readLanguageSetting,
  SYSTEM_SETTINGS_FILE,
} from "./settings-file.js";
import { MIRO_PROVIDER_ID } from "./config.js";
import { normalizeLanguage } from "./prompts/language.js";

/** 系统配置文件路径：~/.miro/settings.json。 */
export const HOME_SETTINGS_FILE = SYSTEM_SETTINGS_FILE;

/** provider / model / effort 偏好，来自 ~/.miro/settings.json。 */
export function readHomeSettings() {
  return readSystemSettings();
}

/**
 * model / effort 偏好按 provider 分别记忆：
 * - miro 没有可供写入的 `providers.<id>` 定义（进程内实现），偏好留在
 *   settings 顶层；
 * - ACP provider 写进 `providers.<id>`，与它自己的 command / args 同一条。
 *
 * 两个位置共用同一套字段名，读回时不要求条目带 command：内置 provider
 * （pi / cursor / claude / codex）用户不会为它们写定义，但同样要记住上次
 * 选的模型。反过来，只有偏好、没有 command 的条目会被 providers.js 的
 * 归一化忽略，仍然使用内置定义。
 */
const isMiroSettingsKey = (providerId) =>
  providerId == null || providerId === MIRO_PROVIDER_ID;

function readProviderEntry(settings, providerId) {
  const providers = settings?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  const entry = providers[providerId];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

function readPreference(settings, providerId, key) {
  const raw = isMiroSettingsKey(providerId)
    ? settings?.[key]
    : readProviderEntry(settings, providerId)?.[key];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/** 某个 provider 记下的 model 偏好；没记过返回 null（不跨 provider 借用）。 */
export function readModelPreference(settings = readSystemSettings(), providerId = MIRO_PROVIDER_ID) {
  return readPreference(settings, providerId, "model");
}

/** 某个 provider 记下的 effort 偏好；没记过返回 null。 */
export function readEffortPreference(settings = readSystemSettings(), providerId = MIRO_PROVIDER_ID) {
  return readPreference(settings, providerId, "effort");
}

/**
 * 写出偏好后的新 settings 对象（纯函数，便于脱盘单测）。
 *
 * ACP 侧刻意是「保留同一条目里的其他字段」的合并写入：provider 定义里的
 * command / args / sessionMeta 不能被偏好覆盖掉。
 */
export function withPreference(settings, providerId, key, value) {
  if (isMiroSettingsKey(providerId)) return { ...settings, [key]: value };
  const rawProviders = settings?.providers;
  const providers =
    rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)
      ? { ...rawProviders }
      : {};
  return {
    ...settings,
    providers: {
      ...providers,
      [providerId]: { ...(readProviderEntry(settings, providerId) ?? {}), [key]: value },
    },
  };
}

/** providerId 省略时写 miro 的顶层偏好。 */
export async function saveModel(value, providerId = MIRO_PROVIDER_ID) {
  writeSystemSettings(withPreference(readSystemSettings(), providerId, "model", value));
}

export async function saveEffort(value, providerId = MIRO_PROVIDER_ID) {
  writeSystemSettings(withPreference(readSystemSettings(), providerId, "effort", value));
}

export async function saveThinkingDisplay(value) {
  writeSystemSettingsField("thinkingDisplay", value);
}

/**
 * miro 工具禁用表；未知名称也保留，方便升级后的工具继续沿用旧设置。
 *
 * `run_command` 是命令工具的曾用名（现在统一叫 `terminal`）：旧设置里存的名字归一
 * 成新名字，否则升级后用户禁用的那个工具会自己重新启用。
 */
export function normalizeDisabledTools(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name) continue;
    seen.add(name === "run_command" ? "terminal" : name);
  }
  return [...seen];
}

/** 保存 miro 工具禁用表，同时保留 settings.json 的其它字段。 */
export async function saveDisabledTools(value) {
  writeSystemSettings({
    ...readSystemSettings(),
    disableTools: normalizeDisabledTools(value),
  });
}

/** 内置工作流提示词语言，归一化后返回。 */
export function readLanguage() {
  return readLanguageSetting();
}

export async function saveLanguage(value) {
  writeSystemSettingsField("language", normalizeLanguage(value));
}
