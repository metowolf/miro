/**
 * 内置提示词的语言标识与归一化。
 *
 * 只影响 miro 自带的工作流提示词，不改变 ACP 会话本身的配置：语言存在
 * ~/.miro/settings.json 的 language 字段，取值为 LANGUAGE_IDS 之一。
 */

/** 默认语言：保持与历史行为一致，内置提示词仍用英文。 */
export const DEFAULT_LANGUAGE = "english";

/** 可选语言，顺序即 /config 面板里的展示顺序。 */
export const LANGUAGES = [
  { value: "english", name: "English" },
  { value: "chinese", name: "Chinese" },
  { value: "cantonese", name: "Cantonese" },
];

export const LANGUAGE_IDS = LANGUAGES.map((item) => item.value);

/** 别名 → 语言 id；便于 `/config language zh` 这类简写。 */
const ALIASES = new Map([
  ["english", "english"],
  ["en", "english"],
  ["en-us", "english"],
  ["chinese", "chinese"],
  ["zh", "chinese"],
  ["zh-cn", "chinese"],
  ["中文", "chinese"],
  ["cantonese", "cantonese"],
  ["yue", "cantonese"],
  ["zh-hk", "cantonese"],
  ["zh-yue", "cantonese"],
  ["粤语", "cantonese"],
  ["粵語", "cantonese"],
]);

/**
 * 归一化语言取值；无法识别（含缺省、非字符串）时返回 DEFAULT_LANGUAGE。
 * 这里刻意宽松：配置文件被手改坏也不该让 /init 直接失败。
 */
export function normalizeLanguage(value) {
  if (typeof value !== "string") return DEFAULT_LANGUAGE;
  const key = value.trim().toLowerCase();
  if (key.length === 0) return DEFAULT_LANGUAGE;
  return ALIASES.get(key) ?? DEFAULT_LANGUAGE;
}

/** 语言 id → 展示名，用于 /config 面板与提示信息。 */
export function languageDisplayName(value) {
  const id = normalizeLanguage(value);
  return LANGUAGES.find((item) => item.value === id)?.name ?? id;
}
