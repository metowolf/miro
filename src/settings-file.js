import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeLanguage } from "./prompts/language.js";
import { normalizeThinkingDisplayMode } from "./thinking.js";

/**
 * 系统配置：~/.miro/settings.json
 *
 * 唯一配置文件：provider / model / effort 偏好与 statusLine、language 等系统设置都写在这里。
 */

export const MIRO_DIR = path.join(os.homedir(), ".miro");
export const SYSTEM_SETTINGS_FILE = path.join(MIRO_DIR, "settings.json");

export const DEFAULT_STATUS_LINE_ITEMS = ["model-with-reasoning", "current-dir"];

/** 读失败、JSON 损坏或顶层不是普通对象时返回 {}。 */
export function readJsonObject(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 读取 ~/.miro/settings.json；文件缺失或非法时视为 {}。 */
export function readSystemSettings() {
  return readJsonObject(SYSTEM_SETTINGS_FILE);
}

/** 写入单个字段到 ~/.miro/settings.json。 */
export function writeSystemSettingsField(key, value) {
  writeSystemSettings({ ...readJsonObject(SYSTEM_SETTINGS_FILE), [key]: value });
}

/** 一次写入状态栏条目与颜色设置，避免两个字段出现中间状态。 */
export function writeStatusLineSettings({ items, useColors }) {
  writeSystemSettings({
    ...readJsonObject(SYSTEM_SETTINGS_FILE),
    statusLine: items,
    statusLineUseColors: useColors,
  });
}

/** 原子写：先写临时文件再 rename，避免读到半截 JSON。 */
export function writeSystemSettings(settings) {
  mkdirSync(MIRO_DIR, { recursive: true });
  const temp = `${SYSTEM_SETTINGS_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, SYSTEM_SETTINGS_FILE);
}

/**
 * 归一化 statusLine 配置。
 * - 缺省（undefined / null）→ null，调用方使用默认项
 * - 数组 → 去空白、转小写、去重后的字符串数组（[] 表示隐藏状态栏）
 * - 其他类型 → null，按缺省处理
 */
export function normalizeStatusLineConfig(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const items = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim().toLowerCase();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    items.push(id);
  }
  return items;
}

/** 状态栏配置视图：items 为 null 表示使用默认项。 */
export function readStatusLineSettings(settings = readSystemSettings()) {
  return {
    items: normalizeStatusLineConfig(settings.statusLine),
    useColors: settings.statusLineUseColors !== false,
  };
}

/** 内置提示词语言；字段缺失或非法时按默认语言处理。 */
export function readLanguageSetting(settings = readSystemSettings()) {
  return normalizeLanguage(settings.language);
}

/** thinking 的呈现与原始记录是两件事；raw 记录只有显式 true 才开启。 */
export function readThinkingSettings(settings = readSystemSettings()) {
  return {
    display: normalizeThinkingDisplayMode(settings.thinkingDisplay),
    recordRaw: settings.recordRawThinking === true,
  };
}
