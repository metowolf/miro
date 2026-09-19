/**
 * /init 提示词的语言无关入口。
 *
 * 具体文案按语言放在 src/prompts/<language>/init.js，这里只负责按当前
 * 语言设置取用并拼接用户追加的指令。INIT_PROMPT 保留为英文原文，
 * 作为默认语言下的稳定引用。
 */

import { initPrompts } from "./prompts/index.js";
import { DEFAULT_LANGUAGE } from "./prompts/language.js";
import { readLanguageSetting } from "./settings-file.js";

/** 默认语言（English）的 /init 提示词。 */
export const INIT_PROMPT = initPrompts(DEFAULT_LANGUAGE).INIT_PROMPT;

/** 取指定语言的 /init 基础提示词。 */
export function initPromptFor(language) {
  return initPrompts(language).INIT_PROMPT;
}

/**
 * 无参数返回该语言的原文；有参数则追加到末尾。
 * language 省略时读取 ~/.miro/settings.json 的 language 字段。
 */
export function buildInitPrompt(args = "", language = readLanguageSetting()) {
  const { INIT_PROMPT: base, INIT_EXTRA_HEADING } = initPrompts(language);
  const extra = String(args ?? "").trim();
  if (extra.length === 0) return base;
  return `${base}\n\n${INIT_EXTRA_HEADING}\n${extra}`;
}
