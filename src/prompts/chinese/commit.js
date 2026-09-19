/**
 * /commit 的提示词（Chinese）。
 *
 * 形状是「预注入 git 上下文 + Git 安全协议 + 一条任务描述」，只做三处适配：
 * - miro 没有 `!\`git status\`` 这类内联 shell 语法，改由 src/commit.js 先跑
 *   git 再把结果拼进提示词，效果等价；
 * - miro 的授权走 /permissions 权限模式，因此这里不谈工具白名单，只谈该做什么；
 * - miro 把结果当普通回复渲染，因此不要求「除工具调用外不要输出任何文字」，
 *   改成提交完成后给一句简短的 Markdown 说明。
 *
 * 这里只放文案：git 读取与目标分派在 src/commit.js。
 *
 * /commit-push-pr 不假设远端是 GitHub：平台与建 PR 用的 CLI 由
 * src/commit.js 探测后注入，本文件只负责措辞（publishTargetSection）。
 */

/** 无参数时的默认任务：把工作区改动提交成一个 commit。 */
export const DEFAULT_PROMPT =
  "为当前改动创建一个 git 提交。" +
  "自己把相关文件加入暂存区，然后用你根据上面上下文起草的提交信息提交它们。";

/** /commit <message>：用户已给出message，尊重它而不是另起草稿。 */
export function messagePrompt(message) {
  return (
    `用这条提交信息为当前改动创建一个 git 提交：${message}\n\n` +
    "把这段文字当作提交想表达的意思，而不一定是字面上的提交信息。" +
    "按上面展示的仓库提交信息风格重新组织它（前缀、大小写和长度），" +
    "修掉明显的拼写错误，并让标题行保持在 72 个字符以内。" +
    "不要添加用户没有暗示的信息。"
  );
}

/** /commit <paths>：只提交点名的文件。 */
export function pathsPrompt(paths) {
  return (
    `创建一个只包含这些路径的 git 提交：${paths}\n\n` +
    "只暂存这些路径，别的一律不动，即使其他文件也有改动。" +
    "根据这些路径内部的变化起草提交信息。"
  );
}

/** 只提交已 staged 的内容，不再自行 git add。 */
export const STAGED_ONLY_PROMPT =
  "用已经暂存的改动创建一个 git 提交。" +
  "不要再用 `git add` 暂存任何其他东西——就按暂存区当前的样子提交，" +
  "并根据上面的暂存 diff 起草提交信息。";

/** 修补上一个提交。放在最后是因为它是唯一会改写历史的目标。 */
export const AMEND_PROMPT =
  "用 `git commit --amend` 修补最近的一次提交。" +
  "这是用户明确要求的，因此仅本次请求允许修补。" +
  "先暂存相关改动，然后判断现有的提交信息是否仍然贴切：" +
  "贴切就保留，如果修补后的内容改变了它的含义就更新它。" +
  "除非用户说明这样做是安全的，不要修补已经推送过的提交。";

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
  if (branch) blocks.push(`当前分支：\n\n\`\`\`\n${branch}\n\`\`\``);
  if (status) blocks.push(`当前 git status：\n\n\`\`\`\n${status}\n\`\`\``);
  if (diff) blocks.push(`当前 git diff（已暂存与未暂存的改动）：\n\n\`\`\`diff\n${diff}\n\`\`\``);
  if (log) blocks.push(`最近的提交：\n\n\`\`\`\n${log}\n\`\`\``);
  if (blocks.length === 0) return "";
  return `## Context\n\n${blocks.join("\n\n")}`;
}

/** diff 过大时的截断说明，跟在被截断的 diff 之后。 */
export const DIFF_TRUNCATED_NOTE =
  "上面的 diff 因为太大被截断了。" +
  "如果在写提交信息之前需要看完剩下的部分，自己跑一次 `git diff HEAD`。";

/** 平台 id → 给人看的名字。unknown 不在表里，走兜底文案。 */
const FORGE_LABELS = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea/Forgejo",
  bitbucket: "Bitbucket",
};

/**
 * 渲染发布目标块（只给 /commit-push-pr 用）。这里只陈述事实：远端是什么、
 * 平台识别成什么、该平台预期的 CLI、PATH 上实际有哪些。怎么用这些事实做决定
 * 写在下面的 COMMIT_PUSH_PR_PROMPT 与 COMMIT_PUSH_PR_RUBRIC 里。
 *
 * 没有 origin 时直接在这里拦下：没有远端就没得 push，让模型去猜一个远端是
 * 最坏的结果，不如明确告诉它到此为止。
 */
export function publishTargetSection({ remote, host, forge, cli, clis = [] } = {}) {
  if (!remote) {
    return `## 发布目标\n\n没有配置 \`origin\` 远端，无处可推。在本地提交后停下：说明必须先添加远端，不要自己编一个远端，也不要推到别的地方。`;
  }
  const facts = [`origin 远端：${remote}`];
  // 本地路径形式的远端（/srv/git/repo.git）解析不出 host，也要说清，不能让
  // 模型以为「没有 Host 行」就等于「随便找个平台建 PR」。
  facts.push(
    host
      ? `托管平台：${host}（${FORGE_LABELS[forge] ?? "未识别的平台"}）`
      : "托管平台：远端不是 URL，识别不出平台"
  );
  facts.push(
    cli
      ? `该平台的拉取请求 CLI：\`${cli}\``
      : "该平台的拉取请求 CLI：无——这个平台没有官方 CLI"
  );
  facts.push(
    clis.length > 0
      ? `PATH 上可用：${clis.map((name) => `\`${name}\``).join("、")}`
      : "PATH 上可用：没有拉取请求 CLI（`gh`、`glab` 或 `tea`）"
  );
  // 预期 CLI 与 PATH 上实际有的对不上时直接点明，不让模型自己交叉比对两行后
  // 仍去跑一条注定失败的命令。
  if (cli && !clis.includes(cli)) {
    facts.push(
      `这里没有安装 \`${cli}\`：跳过 CLI 这一步，推送分支，并报告手动创建拉取请求的 URL`
    );
  }
  return `## 发布目标\n\n${facts.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * committer 的 system prompt。「Git 安全协议」逐条列出提交过程中必须遵守的
 * 禁令，另加了 miro 侧的输出约定。
 */
export const COMMIT_RUBRIC = `# 提交准则

你正在代表用户创建一个 git 提交。提交信息由你起草、提交也由你执行，不该让用户替你写。

以下是对你可以做什么的约束。它们是优先级最低的默认值：凡是项目文档（例如 AGENTS.md 及作用域内的等价文件）或用户的要求给出了更具体的说明，那些说明优先，无论它们出现在本对话中这份准则之前还是之后。

## Git 安全协议

- 绝不修改 git config。
- 绝不跳过 hook（\`--no-verify\`、\`--no-gpg-sign\` 之类），除非用户明确要求。
- 始终创建新提交。除非用户明确要求修补，绝不使用 \`git commit --amend\`。
- 本次请求中绝不 force push、reset、rebase，或以任何其他方式改写历史。
- 不要 push。本次请求到提交为止，用户准备好了自己推。
- 绝不使用带 \`-i\` 参数的 git 命令（例如 \`git rebase -i\` 或 \`git add -i\`），它们需要这里无法提供的交互输入。
- 不要提交可能含密钥的文件（\`.env\`、\`credentials.json\`、私钥、token）。如果这类文件属于本次要提交的改动，把它留在未暂存状态并在小结里说明。只有用户明确点名了该文件时才提交它。
- 不要提交构建产物、依赖目录，或仓库通常会忽略的本地临时文件。如果发现有这类未跟踪文件，提一句而不是暂存它。
- 如果没有任何可提交的东西，不要创建空提交。说明工作区是干净的，然后停下。
- 如果 pre-commit hook 改写了文件，重新暂存它们并重试一次提交。如果再次失败，停下并报告 hook 说了什么，而不是绕过它。

## 写提交信息

1. 读上面最近的提交，遵循仓库既有的信息风格：同样的前缀约定（\`fix:\`、\`tui:\`、纯祈使句，用的是哪种就跟哪种）、同样的大小写，标题行保持在 72 个字符以内。
2. 准确概括改动的性质。"add" 指全新的能力，"update" 指对已有东西的增强，"fix" 指修 bug。不要把重构说成修复。
3. 说明改动为什么要做，而不是重述 diff 里有什么。diff 已经说了改了什么；提交信息该说的是它从用户视角解决了什么问题。
4. 保持简洁：一行标题，只有理由确实需要展开时才加一小段正文。不要拿逐文件的变更清单去凑长度。
5. 要具体。绝不要写"改进代码"或"更新文件"这种泛泛的信息。
6. 用与本对话其余部分相同的语言写提交信息。
7. 不要在信息里加 trailer、署名或广告。不要写"Generated with"，也不要给自己加 "Co-Authored-By"。

## 处理混杂的改动

如果工作区里有好几处互不相关的改动，不要硬塞进一个提交。暂存并提交本次请求所针对的那一处内聚改动，然后告诉用户你留下了哪些没提交、以及为什么。除非用户已经要求，拆成多个提交之前先问一句。

## 执行步骤

1. 看上面的 status 和 diff，理解改了什么。当 diff 本身不足以说明意图时，读一读周边代码。
2. 用 \`git add\` 暂存属于这个提交的文件。
3. 用 heredoc 提交，这样换行和引号都能完整保留：

\`\`\`
git commit -m "$(cat <<'EOF'
提交信息写在这里。
EOF
)"
\`\`\`

4. 用 \`git status\` 或 \`git log -1 --stat\` 确认提交已经落地。

## 输出格式

用普通 Markdown 正文写小结，供人在终端里阅读。不要输出 JSON，也不要把整个回复包在代码块里。

按这样组织：

1. 开头单独一行给出结论，只能是以下三者之一：
   - \`**Verdict:** committed\`
   - \`**Verdict:** nothing to commit\`
   - \`**Verdict:** stopped\`
2. 提交成功时，在一行里给出短 SHA 和标题行，然后最多两句话说明这个提交覆盖了什么。
3. 如果你有意留下了一些改动没提交，加一个 \`## Left uncommitted\` 小标题，每项一个条目并附简短理由。
4. 如果你没有提交就停下了，说明是什么卡住了你、以及用户需要做什么决定。

整个小结保持紧凑：不要开场白，不要重述请求，不要收尾总结或主动提供后续帮助。`;

/** /commit-push-pr 的单回合发布工作流。 */
export const COMMIT_PUSH_PR_PROMPT = `## 你的任务

根据上面的上下文：

1. 如果当前分支是 \`main\`，先用 \`git checkout -b\` 创建并切换到一个名称清晰的分支，再提交。
2. 用合适的提交信息为当前改动创建一个新提交。
3. 把当前分支推送到 \`origin\`，需要时设置 upstream。
4. 用与发布目标里那个 host 匹配的 CLI 创建拉取请求：GitHub 用 \`gh pr create\`，GitLab 用 \`glab mr create\`，Gitea / Forgejo 用 \`tea pr create\`。不要条件反射地拿 \`gh\`——在别的平台上它要么没装，要么根本连不上那个服务器。标题要简洁，正文要概括改动及其验证情况。
5. 如果对应的 CLI 缺失、未认证，或该平台本来就没有 CLI，已推送的分支本身就是结果：根据 origin 远端推导出手动创建拉取请求的 URL 并报告它。绝不要编造命令，也不要编造拉取请求 URL。
6. 在本回合连续完成整个工作流，不要在步骤之间停下来。如果前置条件不满足或命令失败，就停在该处，并准确说明已经完成什么、还剩什么。`;

export const COMMIT_PUSH_PR_RUBRIC = `# 提交、推送与拉取请求准则

你正在把用户当前的改动发布为一个提交和一个拉取请求。提交信息与 PR 文案由你起草，所需命令也由你执行。

以下规则是优先级最低的默认值。项目文档（例如 AGENTS.md 及作用域内的等价文件）或用户要求中更具体的说明优先，无论它们出现在对话中的什么位置。

## 安全规则

- 绝不修改 git config、跳过 hook、amend、reset、rebase、force push，或以其他方式改写历史。
- 绝不使用需要交互输入的 git 参数。
- 不要提交可能包含密钥的文件，例如 \`.env\`、凭据、私钥或 token。除非用户明确点名该文件，否则将其留在未提交状态并报告。
- 不要提交被忽略的构建产物、依赖目录或临时文件。
- 不要直接从 \`main\` 推送：先创建名称清晰的主题分支。
- 只把当前主题分支推送到 \`origin\`；不要修改 remote，也不要删除分支。
- 拉取请求必须建在 \`origin\` 指向的平台上，用那个平台的 CLI。不要因为「试过一条命令」就声称拉取请求已创建；只报告 CLI 真实返回的 URL。
- 如果 hook 改写文件，重新暂存并重试一次提交；再次失败就停下，不要绕过 hook。

## 工作流

1. 用给出的 status、diff、branch 和最近提交理解完整改动。只有 diff 不能说明意图时才读取周边代码。
2. 用 \`git add\` 暂存本次内聚的改动，排除敏感或无关文件。
3. 只创建一个新提交。遵循仓库既有的提交信息风格，标题不超过 72 个字符，说明改动为何重要，并且不要添加署名或广告。用 heredoc 提交以保住换行与引号：

\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
\`\`\`

4. 如果工作区干净，不要创建空提交。只有当前主题分支已经包含适合发布但尚未发布的改动时才继续。
5. 正常推送到 \`origin\`；没有 upstream 时使用 \`-u\`。绝不使用任何 force 参数。
6. 用该平台的 CLI 创建拉取请求——GitHub 用 \`gh pr create\`，GitLab 用 \`glab mr create\`，Gitea / Forgejo 用 \`tea pr create\`——不要默认用 \`gh\`。标题保持简洁，正文包含简短的 \`## Summary\` 和 \`## Test plan\`；两者都要基于整个分支的改动，而不只是最后一个提交。
7. 在一个回合内连续执行这些步骤，不要在中途请求确认。如果 \`git\` 不可用，或该平台的 CLI 缺失、未认证、拒绝操作，保留已经完成的结果并报告阻塞原因；已推送的分支加上手动创建拉取请求的 URL 是一个有效结果，而 CLI 从未打印过的 URL 不是。不要尝试回滚。

## 输出格式

返回供人在终端阅读的简洁 Markdown。开头只能是以下一项：

- \`**Verdict:** pull request created\`
- \`**Verdict:** partially completed\`
- \`**Verdict:** nothing to publish\`
- \`**Verdict:** stopped\`

成功时给出分支、短提交 SHA 与标题，以及拉取请求 URL。部分完成时说明 commit、push 和 PR 创建分别完成到哪一步，以及下一步需要做什么。有意留下的未提交文件放在 \`## Left uncommitted\` 下。不要输出 JSON，也不要把整个回复包在代码块里。`;
