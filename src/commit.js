/**
 * /commit 与 /commit-push-pr 的领域逻辑：git 上下文读取 + 目标分派 + prompt 构造。
 *
 * 命令形状是「预注入 git 上下文 + Git 安全协议 + 一条任务描述」：这里先把四项
 * git 上下文（status / diff / branch / recent commits）跑出来拼进提示词，模型
 * 因此不用先花一轮工具调用去自己查。
 *
 * 与 /review、/simplify 的分工保持一致：
 * - git 读取函数复用 src/review.js，不再复制一份；
 * - 这里只做纯函数与 git 读取，UI 交互留给 App；
 * - 文案按语言放在 src/prompts/<language>/commit.js。
 *
 * /commit-push-pr 不假设托管平台：远端 host 先探测成平台，再连同 PATH 上真实
 * 存在的建 PR 工具一起注入提示词，非 GitHub 仓库因此不会拿到一条注定失败的
 * `gh` 命令。
 *
 * 斜杠命令带参数是常态，因此目标分几种形状：
 * - default：提交工作区改动；
 * - message：用户已给出 message，模型只做风格对齐而不另起草稿；
 * - paths：只提交点名的文件；
 * - staged：只提交已 staged 的内容，不再自行 git add；
 * - amend：修补上一个提交。用一个独立目标把「用户明确要求 amend」表达出来，
 *   rubric 的默认禁令保持原样。
 */

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import { commitPrompts } from "./prompts/index.js";
import { DEFAULT_LANGUAGE } from "./prompts/language.js";
import { looksLikePaths } from "./simplify.js";
import { readLanguageSetting } from "./settings-file.js";

const GIT_TIMEOUT_MS = 3000;

/** 最近提交条数（`git log --oneline -10`）。 */
export const LOG_LIMIT = 10;

/**
 * diff 注入上限。miro 是把 diff 拼进一条 prompt 直接发出去的，超大改动会顶
 * 爆上下文窗口，因此这里留个上限：超了就截断并附一句说明，让模型自己去跑
 * git diff 看剩下的部分。
 */
export const DIFF_LIMIT = 24000;

/** 执行 git 并返回 stdout；失败一律返回 null 而不抛错。 */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

/** 空白无内容时归一成 null，方便 contextSection 直接省略该项。 */
function trimmedOrNull(text) {
  const value = text?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * 截断超长 diff。按行切而不是按字符切：半行 diff 会让模型误读补丁结构。
 * 返回 { text, truncated }，truncated 为真时调用方追加截断说明。
 */
export function truncateDiff(diff, limit = DIFF_LIMIT) {
  const text = diff ?? "";
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const lastNewline = cut.lastIndexOf("\n");
  return { text: lastNewline > 0 ? cut.slice(0, lastNewline) : cut, truncated: true };
}

/**
 * 读取四项 git 上下文，对应提示词里的 `## Context` 段落。
 * 四条命令互不依赖，并发跑；任一条失败只让对应项缺失，不影响整体。
 *
 * diff 用 `git diff HEAD`：它同时覆盖 staged 与 unstaged，比 `git diff` +
 * `git diff --cached` 两条更省 token 也更少歧义。staged 目标是唯一的例外
 * ——它只关心索引，所以改用 `--cached`。
 *
 * remote 只被 /commit-push-pr 使用，但一起读掉：它同样是「一条命令就能问清、
 * 让模型省一轮工具调用」的上下文，且没有 origin 时返回 null 正好表达缺省。
 */
export async function readCommitContext(cwd, { staged = false } = {}) {
  const diffArgs = staged ? ["diff", "--cached"] : ["diff", "HEAD"];
  const [status, diff, branch, log, remote] = await Promise.all([
    git(["status", "--porcelain=v1"], cwd),
    git(diffArgs, cwd),
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["log", `--oneline`, `-${LOG_LIMIT}`], cwd),
    git(["remote", "get-url", "origin"], cwd),
  ]);
  return {
    status: trimmedOrNull(status),
    diff: trimmedOrNull(diff),
    branch: trimmedOrNull(branch),
    log: trimmedOrNull(log),
    remote: trimmedOrNull(remote),
  };
}

/** 工作区是否有已 staged 的内容。staged 目标靠它提前拦下空提交。 */
export async function hasStagedChanges(cwd) {
  const out = await git(["diff", "--cached", "--name-only"], cwd);
  return out != null && out.trim().length > 0;
}

/** 仓库是否已有提交。amend 目标靠它拦下「还没有提交可修补」。 */
export async function hasCommits(cwd) {
  const out = await git(["rev-parse", "--verify", "HEAD"], cwd);
  return out != null && out.trim().length > 0;
}

/**
 * 远端 host → 托管平台。判据是域名子串而不是精确域名：GitHub Enterprise 与
 * 自建 GitLab 的域名里同样带 github / gitlab 字样，精确匹配会把它们都漏成
 * unknown，反而退化回「不知道该用哪个 CLI」。
 */
const FORGE_RULES = [
  { id: "github", pattern: /github/i },
  { id: "gitlab", pattern: /gitlab/i },
  { id: "gitea", pattern: /(gitea|forgejo|codeberg)/i },
  { id: "bitbucket", pattern: /bitbucket/i },
];

/** 各平台建 PR/MR 的 CLI。Bitbucket 没有官方 CLI，因此刻意不在表里。 */
export const FORGE_CLIS = { github: "gh", gitlab: "glab", gitea: "tea" };

/** 探测建 PR 工具的候选顺序。顺序固定，注入提示词的列表才稳定可测。 */
export const FORGE_CLI_CANDIDATES = ["gh", "glab", "tea"];

/** Windows 上可执行文件带后缀，POSIX 上直接是文件名。 */
const CLI_SUFFIXES = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

/**
 * 远端 URL → host。三种写法都要认：
 * scp 形式 `git@github.com:acme/repo.git`、带 scheme 的
 * `https://gitlab.com/acme/repo.git`、带端口的 `ssh://git@git.example.com:2222/a/b.git`。
 * 解析不出来时返回 null，调用方按「未识别」处理。
 */
export function parseRemoteHost(url) {
  const text = typeof url === "string" ? url.trim() : "";
  if (text.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const host = new URL(text).hostname;
      return host ? host.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(text);
  return scp ? scp[1].toLowerCase() : null;
}

/** 远端 URL → 平台 id（github / gitlab / gitea / bitbucket / unknown / null）。 */
export function detectForge(remoteUrl) {
  const host = parseRemoteHost(remoteUrl);
  if (!host) return null;
  return FORGE_RULES.find((rule) => rule.pattern.test(host))?.id ?? "unknown";
}

/** 判断候选路径是否是可直接执行的命令。目录也有 x 位，因此还要确认是文件、
 * 而不是同名目录；查不到一律当作不存在。 */
function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * PATH 上真实存在的建 PR 工具。
 *
 * 先探测再注入，是为了不让模型靠 `command -v` 试错：非 GitHub 仓库上 `gh`
 * 通常是缺的，提示词里不说，模型就会先跑一条注定失败的命令，白烧一轮往返。
 * pathEnv / suffixes / exists 可注入，测试因此不依赖运行机器的 PATH。
 */
export function availableForgeClis({
  pathEnv = process.env.PATH,
  suffixes = CLI_SUFFIXES,
  exists = isExecutableFile,
} = {}) {
  const dirs = String(pathEnv ?? "")
    .split(path.delimiter)
    .filter((dir) => dir.length > 0);
  return FORGE_CLI_CANDIDATES.filter((name) =>
    dirs.some((dir) => suffixes.some((suffix) => exists(path.join(dir, `${name}${suffix}`))))
  );
}

/**
 * 组装「发布目标」事实：远端、平台、该平台预期的 CLI、PATH 上可用的 CLI。
 * 只给事实不给措辞：怎么用这些事实写在 src/prompts/<language>/commit.js。
 */
export function publishTarget(context, clis = availableForgeClis()) {
  const remote = context?.remote ?? null;
  const host = parseRemoteHost(remote);
  const forge = host ? detectForge(remote) : null;
  return { remote, host, forge, cli: (forge && FORGE_CLIS[forge]) || null, clis };
}

/**
 * 目标 → 发给 committer 的用户提示（只含任务描述，不含 git 上下文）。
 * 与 reviewPrompt / simplifyPrompt 同构，便于三个命令共用同一套接入方式。
 */
export function commitTaskPrompt(target, language = readLanguageSetting()) {
  const prompts = commitPrompts(language);
  switch (target?.kind) {
    case "default":
      return prompts.DEFAULT_PROMPT;
    case "message": {
      const message = (target.message ?? "").trim();
      if (message.length === 0) throw new Error("Commit message cannot be empty.");
      return prompts.messagePrompt(message);
    }
    case "paths": {
      const paths = (target.paths ?? "").trim();
      if (paths.length === 0) throw new Error("Commit paths cannot be empty.");
      return prompts.pathsPrompt(paths);
    }
    case "staged":
      return prompts.STAGED_ONLY_PROMPT;
    case "amend":
      return prompts.AMEND_PROMPT;
    default:
      throw new Error(`Unknown commit target: ${target?.kind}`);
  }
}

/**
 * 目标 → 完整的用户提示：git 上下文 + 任务描述。
 * 需要跑 git，因此是异步的。language 省略时读 ~/.miro/settings.json。
 */
export async function commitPrompt(target, cwd, language = readLanguageSetting()) {
  const prompts = commitPrompts(language);
  const task = commitTaskPrompt(target, language);
  const context = await readCommitContext(cwd, { staged: target?.kind === "staged" });
  const { text, truncated } = truncateDiff(context.diff);
  const section = prompts.contextSection({ ...context, diff: text });
  const blocks = [section, truncated ? prompts.DIFF_TRUNCATED_NOTE : null, task].filter(
    (block) => typeof block === "string" && block.length > 0
  );
  return blocks.join("\n\n");
}

/**
 * /commit-push-pr 复用同一份预读取上下文，但使用独立任务文案；不能复用
 * /commit 的完整请求，因为后者明确把 push 排除在工作流之外。
 *
 * 比 /commit 多注入一段发布目标：只有这条命令要为「远端是谁、建 PR 该用哪个
 * CLI」做决定，而这两件事都能在拼提示词时就查清。
 */
export async function commitPushPrPrompt(cwd, language = readLanguageSetting()) {
  const prompts = commitPrompts(language);
  const context = await readCommitContext(cwd);
  const { text, truncated } = truncateDiff(context.diff);
  const section = prompts.contextSection({ ...context, diff: text });
  const target = prompts.publishTargetSection(publishTarget(context));
  const blocks = [
    section,
    truncated ? prompts.DIFF_TRUNCATED_NOTE : null,
    target,
    prompts.COMMIT_PUSH_PR_PROMPT,
  ].filter((block) => typeof block === "string" && block.length > 0);
  return blocks.join("\n\n");
}

/** transcript 里展示的一句话摘要。 */
export function userFacingHint(target) {
  switch (target?.kind) {
    case "default":
      return "current changes";
    case "message":
      return (target.message ?? "").trim();
    case "paths":
      return (target.paths ?? "").trim();
    case "staged":
      return "staged changes";
    case "amend":
      return "amend of the last commit";
    default:
      return "current changes";
  }
}

/**
 * committer 的 system prompt（默认语言 English）。
 * 「Git 安全协议」逐条列出提交过程中必须遵守的禁令。
 */
export const COMMIT_RUBRIC = commitPrompts(DEFAULT_LANGUAGE).COMMIT_RUBRIC;

/** 取指定语言的 rubric。 */
export function commitRubricFor(language) {
  return commitPrompts(language).COMMIT_RUBRIC;
}

/** /commit-push-pr 使用独立 rubric，避免继承 /commit 的「禁止 push」。 */
export const COMMIT_PUSH_PR_RUBRIC =
  commitPrompts(DEFAULT_LANGUAGE).COMMIT_PUSH_PR_RUBRIC;

export function commitPushPrRubricFor(language) {
  return commitPrompts(language).COMMIT_PUSH_PR_RUBRIC;
}

/**
 * 组装发给 committer 的完整提示：rubric + git 上下文 + 本次目标。
 * language 省略时读取 ~/.miro/settings.json 的 language 字段。
 */
export function buildCommitRequest(prompt, language = readLanguageSetting()) {
  return `${commitRubricFor(language)}\n\n---\n\n${prompt}`;
}

/** 组装提交、推送与建 PR 工作流的完整请求。 */
export function buildCommitPushPrRequest(prompt, language = readLanguageSetting()) {
  return `${commitPushPrRubricFor(language)}\n\n---\n\n${prompt}`;
}

/**
 * /commit <args> 的参数分流。三条互斥的判据，从最明确的往后排：
 * - 关键词 staged / amend 单独成词时按对应目标处理；
 * - 全是路径按 paths（判据复用 /simplify 的 looksLikePaths，两处对
 *   「什么算路径」的定义必须一致，否则同样的输入在两个命令里行为不同）；
 * - 其余当 commit message。
 *
 * message 兜底而非 paths 兜底，是因为 /commit 最常见的带参用法就是直接给
 * 一句 message；想提交指定文件的人会写出带 / 或 . 的路径，会被上一条接住。
 */
export function parseCommitArgs(args) {
  const text = String(args ?? "").trim();
  if (text.length === 0) return { kind: "default" };
  const lower = text.toLowerCase();
  if (lower === "staged" || lower === "--staged") return { kind: "staged" };
  if (lower === "amend" || lower === "--amend") return { kind: "amend" };
  if (looksLikePaths(text)) return { kind: "paths", paths: text };
  return { kind: "message", message: text };
}
