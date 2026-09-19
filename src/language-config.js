/**
 * 本地配置项：language。
 *
 * /config 的其他项都来自 ACP 的 configOptions，由 provider 通过
 * session/set_config 应答；language 是 miro 自己的偏好（只影响内置工作流
 * 提示词），因此在这里合成一个同构的 select 选项挂到面板上，让用户用同一个
 * 入口修改，写入 ~/.miro/settings.json。
 */

import { LANGUAGES, normalizeLanguage } from "./prompts/language.js";

export const LANGUAGE_OPTION_ID = "language";

/** 合成一个与 ACP select 选项同构的 language 项。 */
export function languageConfigOption(language) {
  return {
    id: LANGUAGE_OPTION_ID,
    name: "Language",
    type: "select",
    category: "miro",
    description: "Language of miro's built-in workflow prompts",
    currentValue: normalizeLanguage(language),
    options: LANGUAGES.map((item) => ({ value: item.value, name: item.name })),
    local: true,
  };
}

export function isLanguageOption(option) {
  return option?.id === LANGUAGE_OPTION_ID;
}

/**
 * 把 language 追加到 ACP 选项列表末尾。
 * provider 若自己也报了同 id 的选项，则以 provider 的为准，不重复插入。
 */
export function withLanguageOption(options, language) {
  const listed = Array.isArray(options) ? options : [];
  if (listed.some((option) => option?.id === LANGUAGE_OPTION_ID)) return listed;
  return [...listed, languageConfigOption(language)];
}
