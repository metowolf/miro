/**
 * /commit 的提示词（English）。
 *
 * 形状是「预注入 git 上下文 + Git 安全协议 + 一条任务描述」，只做三处适配：
 * - miro 没有 `!\`git status\`` 这类内联 shell 语法，改由 src/commit.js 先跑
 *   git 再把结果拼进提示词，效果等价；
 * - miro 的授权走 /permissions 权限模式，因此这里不谈工具白名单，只谈该做什么；
 * - miro 把结果当普通回复渲染，因此不要求「除工具调用外不要输出任何文字」，
 *   改成提交完成后给一句简短的 Markdown 说明。
 *
 * 这里只放文案：git 读取与目标分派在 src/commit.js。
 */

/** 无参数时的默认任务：把工作区改动提交成一个 commit。 */
export const DEFAULT_PROMPT =
  "Create a single git commit for the current changes. " +
  "Stage the relevant files yourself, then commit them with a message you draft from the context above.";

/** /commit <message>：用户已给出message，尊重它而不是另起草稿。 */
export function messagePrompt(message) {
  return (
    `Create a single git commit for the current changes using this commit message: ${message}\n\n` +
    "Treat that text as the intended meaning of the commit, not necessarily as the literal message. " +
    "Reformat it to match the repository's commit message style shown above (prefix, capitalization, " +
    "and length), fix obvious typos, and keep the subject line under 72 characters. " +
    "Do not add information the user did not imply."
  );
}

/** /commit <paths>：只提交点名的文件。 */
export function pathsPrompt(paths) {
  return (
    `Create a single git commit that includes only these paths: ${paths}\n\n` +
    "Stage exactly those paths and nothing else, even if other files have changes. " +
    "Draft the commit message from what changed inside them."
  );
}

/** 只提交已 staged 的内容，不再自行 git add。 */
export const STAGED_ONLY_PROMPT =
  "Create a single git commit from the changes that are already staged. " +
  "Do not stage anything else with `git add` — commit the index exactly as it stands, " +
  "and draft the commit message from the staged diff above.";

/** 修补上一个提交。放在最后是因为它是唯一会改写历史的目标。 */
export const AMEND_PROMPT =
  "Amend the most recent commit with `git commit --amend`. " +
  "The user explicitly requested this, so amending is allowed for this request only. " +
  "Stage the relevant changes first, then decide whether the existing message still describes " +
  "the commit: keep it when it does, and update it when the amended content changed its meaning. " +
  "Do not amend a commit that has already been pushed unless the user says it is safe.";

/**
 * 渲染 git 上下文块。对应提示词里的 `## Context` 段落：
 * 同样四项（status / diff / branch / recent commits），同样在提示词渲染时就
 * 把结果填好，让模型不必先花一轮工具调用去自己查。
 *
 * 缺失的项直接省略而不是填空字符串——非 git 仓库时 /commit 会提前拦下，
 * 走到这里的失败都是单条 git 命令超时或异常，省略比留个空标题更清楚。
 */
export function contextSection({ status, diff, branch, log }) {
  const blocks = [];
  if (branch) blocks.push(`Current branch:\n\n\`\`\`\n${branch}\n\`\`\``);
  if (status) blocks.push(`Current git status:\n\n\`\`\`\n${status}\n\`\`\``);
  if (diff) blocks.push(`Current git diff (staged and unstaged changes):\n\n\`\`\`diff\n${diff}\n\`\`\``);
  if (log) blocks.push(`Recent commits:\n\n\`\`\`\n${log}\n\`\`\``);
  if (blocks.length === 0) return "";
  return `## Context\n\n${blocks.join("\n\n")}`;
}

/** diff 过大时的截断说明，跟在被截断的 diff 之后。 */
export const DIFF_TRUNCATED_NOTE =
  "The diff above was truncated because it is large. " +
  "Run `git diff HEAD` yourself if you need to see the rest before writing the message.";

/** 平台 id → 给人看的名字。unknown 不在表里，走兜底文案。 */
const FORGE_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea/Forgejo",
  bitbucket: "Bitbucket",
};

/**
 * 渲染发布目标块（只给 /commit-push-pr 用）。这里只陈述事实：远端是什么、
 * 平台识别成什么、该平台预期的 CLI、PATH 上实际有哪些。命令怎么拿这些事实
 * 做决定写在下面的 COMMIT_PUSH_PR_PROMPT 与 COMMIT_PUSH_PR_RUBRIC 里。
 *
 * 没有 origin 时直接在这里拦下：没有远端就没得 push，让模型去猜一个远端是
 * 最坏的结果，不如明确告诉它到此为止。
 */
export function publishTargetSection({ remote, host, forge, cli, clis = [] } = {}) {
  if (!remote) {
    return `## Publishing target

No \`origin\` remote is configured, so there is nothing to push to. Commit locally and stop: report that a remote must be added, and do not invent one or push anywhere else.`;
  }
  const facts = [`Origin remote: ${remote}`];
  // 本地路径形式的远端（/srv/git/repo.git）解析不出 host，也要说清，不能让
  // 模型以为“没有 Host 行”就等于“随便找个平台建 PR”。
  facts.push(
    host
      ? `Host: ${host} (${FORGE_LABELS[forge] ?? "unrecognised hosting provider"})`
      : "Host: not a remote URL — no hosting provider detected"
  );
  facts.push(
    cli
      ? `Pull request CLI for this host: \`${cli}\``
      : "Pull request CLI for this host: none — this provider has no first-class CLI"
  );
  facts.push(
    clis.length > 0
      ? `Found on PATH: ${clis.map((name) => `\`${name}\``).join(", ")}`
      : "Found on PATH: no pull request CLI (`gh`, `glab`, or `tea`)"
  );
  // 预期 CLI 与 PATH 上实际有的对不上时直接点明，不让模型自己交叉比对两行后
  // 仍去跑一条注定失败的命令。
  if (cli && !clis.includes(cli)) {
    facts.push(
      `\`${cli}\` is not installed here: skip the CLI step, push the branch, and report the URL for opening the pull request by hand`
    );
  }
  return `## Publishing target\n\n${facts.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * committer 的 system prompt。「Git 安全协议」逐条列出提交过程中必须遵守的
 * 禁令，另加了 miro 侧的输出约定。
 */
export const COMMIT_RUBRIC = `# Commit guidelines

You are creating a git commit on the user's behalf. You draft the message and run the commit yourself; the user should not have to write it for you.

Below are the constraints on what you may do. They are defaults with the lowest precedence: wherever project documentation (such as AGENTS.md and scoped equivalents) or the user's request says something more specific, that guidance wins, regardless of whether it appears before or after these guidelines in this conversation.

## Git safety protocol

- NEVER update the git config.
- NEVER skip hooks (\`--no-verify\`, \`--no-gpg-sign\`, and similar) unless the user explicitly requests it.
- ALWAYS create a NEW commit. Never use \`git commit --amend\` unless the user explicitly asked to amend.
- Never force push, reset, rebase, or otherwise rewrite history as part of this request.
- Do not push. This request ends at the commit; the user pushes when they are ready.
- Never use git commands with the \`-i\` flag (such as \`git rebase -i\` or \`git add -i\`), because they need interactive input that is not available here.
- Do not commit files that likely contain secrets (\`.env\`, \`credentials.json\`, private keys, tokens). If such a file is part of the requested change, leave it unstaged and say so in your summary. Commit it only when the user explicitly asked for that specific file.
- Do not commit build output, dependency directories, or local scratch files that the repository would normally ignore. If you find one untracked, mention it instead of staging it.
- If there is nothing to commit, do not create an empty commit. Say the working tree is clean and stop.
- If a pre-commit hook rewrites files, re-stage them and retry the commit once. If it fails again, stop and report what the hook said rather than working around it.

## Writing the message

1. Read the recent commits above and follow the repository's existing message style: the same prefix convention (\`fix:\`, \`tui:\`, a bare imperative, whatever is in use), the same capitalization, and a subject line under 72 characters.
2. Summarize the nature of the change accurately. "add" means a wholly new capability, "update" means an enhancement to something that already exists, "fix" means a bug fix. Do not call a refactor a fix.
3. Explain WHY the change was made rather than restating WHAT the diff shows. The diff already says what changed; the message should say what problem it solves from a user's point of view.
4. Keep it concise: a subject line, plus a short body only when the reason genuinely needs one. Do not pad it with a file-by-file changelog.
5. Be specific. Never write a generic message like "improve code" or "update files".
6. Write the message in the same language as the rest of this conversation.
7. Do not add trailers, attribution, or advertising to the message. No "Generated with", no "Co-Authored-By" for yourself.

## Handling mixed changes

If the working tree contains several unrelated changes, do not force them into one commit. Stage and commit the coherent change that the request is about, then tell the user what you left uncommitted and why. Ask before splitting the work into multiple commits unless the user already asked for that.

## How to proceed

1. Review the status and diff above to understand what changed. Read the surrounding code when the diff alone is ambiguous about intent.
2. Stage the files that belong in this commit with \`git add\`.
3. Commit with a heredoc so the message survives newlines and quoting intact:

\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
\`\`\`

4. Confirm the commit landed with \`git status\` or \`git log -1 --stat\`.

## Output format

Write your summary as plain Markdown prose for a human to read in a terminal. Do not emit JSON, and do not wrap the whole response in a code fence.

Structure it like this:

1. Open with a one-line verdict on its own line, exactly one of:
   - \`**Verdict:** committed\`
   - \`**Verdict:** nothing to commit\`
   - \`**Verdict:** stopped\`
2. When you committed, quote the short SHA and the subject line on one line, then add at most two sentences on what the commit covers.
3. If you deliberately left changes uncommitted, add a \`## Left uncommitted\` heading with one bullet per item and a brief reason.
4. If you stopped without committing, explain what blocked you and what the user should decide.

Keep the whole summary tight: no preamble, no restating the request, no closing summary or offers of further help.`;

/** /commit-push-pr 的一回合发布工作流。 */
export const COMMIT_PUSH_PR_PROMPT = `## Your task

Based on the context above:

1. If the current branch is \`main\`, create and switch to a descriptively named branch with \`git checkout -b\` before committing.
2. Create one new commit for the current changes with an appropriate message.
3. Push the current branch to \`origin\`, setting its upstream when needed.
4. Open the pull request with the CLI that matches the host in the publishing target: \`gh pr create\` on GitHub, \`glab mr create\` on GitLab, \`tea pr create\` on Gitea or Forgejo. Never reaching for \`gh\` by reflex — on every other host it is either missing or unable to talk to that server. Give the pull request a concise title and a body that summarizes the changes and their verification.
5. If that CLI is missing or unauthenticated, or the host has no CLI at all, the pushed branch is still a result: derive the URL for opening the pull request by hand from the origin remote and report that URL. Never fabricate a command or a pull request URL.
6. Complete the workflow in this turn without pausing between steps. If a prerequisite or command fails, stop at that point and report exactly what completed and what remains.`;

export const COMMIT_PUSH_PR_RUBRIC = `# Commit, push, and pull request guidelines

You are publishing the user's current changes as one commit and one pull request. Draft the commit and PR text and run the required commands yourself.

These are lowest-precedence defaults. More specific project documentation such as AGENTS.md, scoped equivalents, and the user's request wins regardless of where it appears in the conversation.

## Safety

- Never update git config, skip hooks, amend, reset, rebase, force push, or otherwise rewrite history.
- Never use interactive git flags.
- Do not commit likely secrets such as \`.env\`, credentials, private keys, or tokens. Leave them uncommitted and report them unless the user explicitly named the file.
- Do not commit ignored build output, dependency directories, or scratch files.
- Do not push directly from \`main\`: create a descriptive topic branch first.
- Push only the current topic branch to \`origin\`; never change remotes or delete branches.
- Open the pull request on the host that \`origin\` points at, with that host's CLI. Never claim a pull request exists because a command was attempted; report only the URL the CLI returned.
- If a hook rewrites files, re-stage and retry the commit once. If it fails again, stop instead of bypassing it.

## Workflow

1. Use the supplied status, diff, branch, and recent commits to understand the complete change. Read surrounding code only when the diff is ambiguous.
2. Stage the coherent current changes with \`git add\`, excluding sensitive or unrelated files.
3. Create exactly one new commit. Match the repository's existing message style, keep the subject under 72 characters, explain why the change matters, and add no attribution or advertising. Commit with a heredoc so the message survives newlines and quoting intact:

\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
\`\`\`

4. If the working tree is clean, do not create an empty commit. Continue only when the current topic branch already contains unpublished work suitable for a PR.
5. Push normally to \`origin\`, using \`-u\` when no upstream exists. Never use any force option.
6. Create the pull request with the CLI for that host — \`gh pr create\` on GitHub, \`glab mr create\` on GitLab, \`tea pr create\` on Gitea or Forgejo — not with \`gh\` by default. Keep the title concise and write a body with a short \`## Summary\` and \`## Test plan\`; base both on the full branch change, not only the latest commit.
7. Run the steps in this single turn without asking for confirmation between them. If \`git\` is unavailable, or the host's CLI is missing, unauthenticated, or rejects an operation, preserve completed work and report the blocker; a pushed branch plus the URL for opening the pull request by hand is a valid outcome, a URL the CLI never printed is not. Do not try to roll anything back.

## Output format

Return concise Markdown for a human in a terminal. Start with exactly one of:

- \`**Verdict:** pull request created\`
- \`**Verdict:** partially completed\`
- \`**Verdict:** nothing to publish\`
- \`**Verdict:** stopped\`

On success, include the branch, short commit SHA and subject, and pull request URL. On partial completion, state which of commit, push, and PR creation succeeded and the next required action. Mention intentionally uncommitted files under \`## Left uncommitted\`. Do not emit JSON or wrap the whole response in a code fence.`;
