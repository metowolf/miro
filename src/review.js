/**
 * /review 的领域逻辑：git 查询 + 四类审查目标的 prompt 构造。
 *
 * - 目标分四类：uncommitted / base-branch / commit / custom；
 * - 每类各自渲染一段「祈使句 + 定位方式 + 期望产出」的用户提示；
 * - 审查请求带上 reviewer 专用的 rubric（REVIEW_RUBRIC）。
 *   这里要求模型直接输出 Markdown 正文：miro 把审查结果当普通回复渲染，
 *   不需要再解析回结构。
 * 这里只做纯函数与 git 读取，UI 交互留给 App。
 * 具体文案按语言放在 src/prompts/<language>/review.js。
 */

import { execFile } from "node:child_process";

import { reviewPrompts } from "./prompts/index.js";
import { DEFAULT_LANGUAGE } from "./prompts/language.js";
import { readLanguageSetting } from "./settings-file.js";

const GIT_TIMEOUT_MS = 3000;
/** 提交列表上限。 */
export const COMMIT_LIMIT = 100;

/** 执行 git 并返回 stdout；失败一律返回 null 而不抛错。 */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

export async function isGitRepo(cwd) {
  const out = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return out?.trim() === "true";
}

/** 当前分支名；detached HEAD 或非仓库返回 null。 */
export async function currentBranch(cwd) {
  const out = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = out?.trim();
  return branch && branch !== "HEAD" ? branch : null;
}

/** 本地分支列表，按最近提交时间倒序；当前分支被排除（自己 diff 自己没有意义）。 */
export async function localBranches(cwd) {
  const out = await git(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    cwd
  );
  if (out == null) return [];
  const current = await currentBranch(cwd);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== current);
}

/** 最近提交，返回 { sha, subject }。 */
export async function recentCommits(cwd, limit = COMMIT_LIMIT) {
  const out = await git(["log", `-n${limit}`, "--format=%H%x00%s"], cwd);
  if (out == null) return [];
  const commits = [];
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const [sha, subject] = line.split("\u0000");
    if (!sha) continue;
    commits.push({ sha: sha.trim(), subject: (subject ?? "").trim() || sha.slice(0, 7) });
  }
  return commits;
}

/** 与目标分支的 merge base；拿不到时返回 null，prompt 会退化成让模型自己求。 */
export async function mergeBaseWithHead(cwd, branch) {
  const upstream = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd);
  const candidates = [upstream?.trim(), branch].filter(
    (value) => typeof value === "string" && value.length > 0
  );
  for (const candidate of candidates) {
    const out = await git(["merge-base", "HEAD", candidate], cwd);
    const sha = out?.trim();
    if (sha) return sha;
  }
  return null;
}

/** 工作区是否有可审查的改动（含未跟踪文件）。 */
export async function hasUncommittedChanges(cwd) {
  const out = await git(["status", "--porcelain"], cwd);
  return out != null && out.trim().length > 0;
}

/**
 * 目标 → 发给 reviewer 的用户提示。
 * base-branch 需要 git 查询，因此整体是异步的。
 * language 省略时读取 ~/.miro/settings.json 的 language 字段。
 */
export async function reviewPrompt(target, cwd, language = readLanguageSetting()) {
  const prompts = reviewPrompts(language);
  switch (target?.kind) {
    case "uncommitted":
      return prompts.UNCOMMITTED_PROMPT;
    case "base-branch": {
      const sha = await mergeBaseWithHead(cwd, target.branch);
      return prompts.baseBranchPrompt(target.branch, sha);
    }
    case "commit":
      return prompts.commitPrompt(target.sha, target.title);
    case "custom": {
      const instructions = (target.instructions ?? "").trim();
      if (instructions.length === 0) throw new Error("Review instructions cannot be empty.");
      return instructions;
    }
    default:
      throw new Error(`Unknown review target: ${target?.kind}`);
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
    case "custom":
      return (target.instructions ?? "").trim();
    default:
      return "changes";
  }
}

/**
 * reviewer 的 system prompt（默认语言 English）。保留「何时算 bug」与
 * 「评论怎么写」两块骨架，输出为 Markdown 正文。
 */
export const REVIEW_RUBRIC = reviewPrompts(DEFAULT_LANGUAGE).REVIEW_RUBRIC;

/** 取指定语言的 rubric。 */
export function reviewRubricFor(language) {
  return reviewPrompts(language).REVIEW_RUBRIC;
}

/**
 * 组装发给 reviewer 的完整提示：rubric + 本次目标。
 * language 省略时读取 ~/.miro/settings.json 的 language 字段。
 */
export function buildReviewRequest(prompt, language = readLanguageSetting()) {
  return `${reviewRubricFor(language)}\n\n---\n\n${prompt}`;
}
