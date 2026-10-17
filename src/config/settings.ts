import {
  writeSystemSettings,
  writeSystemSettingsField,
  readSystemSettings,
  readLanguageSetting,
  SYSTEM_SETTINGS_FILE,
} from "./settings-file.ts";
import { readAcpProviders, writeAcpProviders } from "./acp-file.ts";
import { MIRO_PROVIDER_ID } from "./config.ts";
import { normalizeLanguage } from "../commands/prompts/language.ts";

/** 系统配置文件路径：~/.miro/settings.json。 */
export const HOME_SETTINGS_FILE = SYSTEM_SETTINGS_FILE;

/** miro 的 model / effort 偏好与系统设置，来自 ~/.miro/settings.json。 */
export function readHomeSettings() {
  return readSystemSettings();
}

/**
 * model / effort 偏好按 provider 分别记忆：
 * - miro 没有可供写入的 provider 定义（进程内实现），偏好留在 settings 顶层；
 * - ACP provider 写进 ~/.miro/acp.json 的同一条目，与它的 command / args 并列。
 *
 * 两个位置共用同一套字段名，读回时不要求条目带 command：内置 provider
 * （pi / cursor / claude / codex）用户不会为它们写定义，但同样要记住上次
 * 选的模型。反过来，只有偏好、没有 command 的条目会被 providers.ts 的
 * 归一化忽略，仍然使用内置定义。
 */
const isMiroSettingsKey = (providerId) =>
  providerId == null || providerId === MIRO_PROVIDER_ID;

function normalizePreference(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function readAcpEntry(definitions, providerId) {
  const entry = definitions?.[providerId];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

/** 从 acp.json 的定义表里读某个 provider 的偏好；条目缺失或值非法时返回 null。 */
export function readAcpPreference(definitions, providerId, key) {
  return normalizePreference(readAcpEntry(definitions, providerId)?.[key]);
}

/**
 * 某个 provider 记下的 model 偏好；没记过返回 null（不跨 provider 借用）。
 *
 * acpProviders 只在 ACP provider 上用到，省略时读 ~/.miro/acp.json。
 */
export function readModelPreference(
  settings = readSystemSettings(),
  providerId = MIRO_PROVIDER_ID,
  acpProviders?,
) {
  return isMiroSettingsKey(providerId)
    ? normalizePreference(settings?.model)
    : readAcpPreference(acpProviders ?? readAcpProviders(), providerId, "model");
}

/** 某个 provider 记下的 effort 偏好；没记过返回 null。 */
export function readEffortPreference(
  settings = readSystemSettings(),
  providerId = MIRO_PROVIDER_ID,
  acpProviders?,
) {
  return isMiroSettingsKey(providerId)
    ? normalizePreference(settings?.effort)
    : readAcpPreference(acpProviders ?? readAcpProviders(), providerId, "effort");
}

/**
 * 写出偏好后的新 settings 对象（纯函数，便于脱盘单测）。
 *
 * 只处理 miro 的顶层偏好；ACP 的偏好落在 acp.json，见 withAcpPreference。
 */
export function withMiroPreference(settings, key, value) {
  return { ...settings, [key]: value };
}

/**
 * 写出偏好后的新 acp.json 定义表（纯函数）。
 *
 * 刻意是「保留同一条目里的其他字段」的合并写入：provider 定义里的
 * command / args / sessionMeta 不能被偏好覆盖掉。
 */
export function withAcpPreference(definitions, providerId, key, value) {
  const current =
    definitions && typeof definitions === "object" && !Array.isArray(definitions)
      ? definitions
      : {};
  return {
    ...current,
    [providerId]: { ...(readAcpEntry(current, providerId) ?? {}), [key]: value },
  };
}

function savePreference(providerId, key, value) {
  if (isMiroSettingsKey(providerId)) {
    writeSystemSettings(withMiroPreference(readSystemSettings(), key, value));
    return;
  }
  writeAcpProviders(withAcpPreference(readAcpProviders(), providerId, key, value));
}

/** providerId 省略时写 miro 的顶层偏好。 */
export async function saveModel(value, providerId = MIRO_PROVIDER_ID) {
  savePreference(providerId, "model", value);
}

export async function saveEffort(value, providerId = MIRO_PROVIDER_ID) {
  savePreference(providerId, "effort", value);
}

export async function saveThinkingDisplay(value) {
  writeSystemSettingsField("thinkingDisplay", value);
}

/** 内置工作流提示词语言，归一化后返回。 */
export function readLanguage() {
  return readLanguageSetting();
}

export async function saveLanguage(value) {
  writeSystemSettingsField("language", normalizeLanguage(value));
}
