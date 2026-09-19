/**
 * /simplify 的领域逻辑：目标解析 + prompt 构造。
 *
 * miro 的斜杠命令不会自动触发（miro 下它确实跑在独立上下文里，但那仍是
 * 一次显式命令），因此把「最近改过的代码」显式化成可选的目标类型，复用
 * /review 已有的那套 git 定位：
 * - uncommitted：工作区改动，默认范围；
 * - base-branch / commit：把范围放大到一个 PR 或一个提交；
 * - paths：不依赖 git，直接点名文件或目录；
 * - custom：自由指令。
 *
 * git 读取函数直接复用 src/review.js，不再复制一份：两个命令对
 * 「当前分支 / 本地分支 / 最近提交」的定义完全一致。
 * 这里只做纯函数与 git 读取，UI 交互留给 App。
 * 具体文案按语言放在 src/prompts/<language>/simplify.js。
 */

import { simplifyPrompts } from "./prompts/index.js";
import { DEFAULT_LANGUAGE } from "./prompts/language.js";
import { mergeBaseWithHead } from "./review.js";
import { readLanguageSetting } from "./settings-file.js";

/**
 * 目标 → 发给 simplifier 的用户提示。
 * base-branch 需要 git 查询，因此整体是异步的。
 * language 省略时读取 ~/.miro/settings.json 的 language 字段。
 */
export async function simplifyPrompt(target, cwd, language = readLanguageSetting()) {
  const prompts = simplifyPrompts(language);
  switch (target?.kind) {
    case "uncommitted":
      return prompts.UNCOMMITTED_PROMPT;
    case "base-branch": {
      const sha = await mergeBaseWithHead(cwd, target.branch);
      return prompts.baseBranchPrompt(target.branch, sha);
    }
    case "commit":
      return prompts.commitPrompt(target.sha, target.title);
    case "paths": {
      const paths = (target.paths ?? "").trim();
      if (paths.length === 0) throw new Error("Simplify paths cannot be empty.");
      return prompts.pathsPrompt(paths);
    }
    case "custom": {
      const instructions = (target.instructions ?? "").trim();
      if (instructions.length === 0) throw new Error("Simplify instructions cannot be empty.");
      return instructions;
    }
    default:
      throw new Error(`Unknown simplify target: ${target?.kind}`);
  }
}

/** transcript 里展示的一句话摘要。 */
export function userFacingHint(target) {
  switch (target?.kind) {
    case "uncommitted":
      return "current changes";
    case "base-branch":
      return `changes against '${target.branch}'`;
    case "commit": {
      const shortSha = String(target.sha ?? "").slice(0, 7);
      return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
    }
    case "paths":
      return (target.paths ?? "").trim();
    case "custom":
      return (target.instructions ?? "").trim();
    default:
      return "changes";
  }
}

/**
 * simplifier 的 system prompt（默认语言 English）。保留「五条约束 +
 * 不该做什么」骨架，输出为 Markdown 正文。
 */
export const SIMPLIFY_RUBRIC = simplifyPrompts(DEFAULT_LANGUAGE).SIMPLIFY_RUBRIC;

/** 取指定语言的 rubric。 */
export function simplifyRubricFor(language) {
  return simplifyPrompts(language).SIMPLIFY_RUBRIC;
}

/**
 * 组装发给 simplifier 的完整提示：rubric + 本次目标。
 * language 省略时读取 ~/.miro/settings.json 的 language 字段。
 */
export function buildSimplifyRequest(prompt, language = readLanguageSetting()) {
  return `${simplifyRubricFor(language)}\n\n---\n\n${prompt}`;
}

/**
 * /simplify <args> 的参数分流：看起来像路径就当 paths，否则当自由指令。
 * 判据刻意保守——只有「每个 token 都像路径」才算 paths，
 * 含空格的自然语言（"the parser in src"）会落到 custom。
 */
export function looksLikePaths(args) {
  const text = String(args ?? "").trim();
  if (text.length === 0) return false;
  const tokens = text.split(/\s+/);
  return tokens.every((token) => /^[\w./@~-]+$/.test(token) && /[./]/.test(token));
}
