/**
 * /commit 的提示词（Cantonese）。
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
  "為當前改動建立一個 git 提交。" +
  "自己將相關檔案加入暫存區，然後用你根據上面上下文起草嘅提交訊息提交佢哋。";

/** /commit <message>：用户已给出message，尊重它而不是另起草稿。 */
export function messagePrompt(message) {
  return (
    `用這條提交訊息為當前改動建立一個 git 提交：${message}\n\n` +
    "將這段文字當作提交想表達嘅意思，而唔一定係字面上嘅提交訊息。" +
    "按上面展示嘅倉庫提交訊息風格重新組織佢（前綴、大小寫同長度），" +
    "改掉明顯嘅錯別字，並且令標題行保持在 72 個字元以內。" +
    "唔好加入用戶冇暗示過嘅資訊。"
  );
}

/** /commit <paths>：只提交点名的文件。 */
export function pathsPrompt(paths) {
  return (
    `建立一個只包含這些路徑嘅 git 提交：${paths}\n\n` +
    "只暫存這些路徑，其他一律唔好動，即使其他檔案都有改動。" +
    "根據這些路徑裡面嘅變化起草提交訊息。"
  );
}

/** 只提交已 staged 的内容，不再自行 git add。 */
export const STAGED_ONLY_PROMPT =
  "用已經暫存嘅改動建立一個 git 提交。" +
  "唔好再用 `git add` 暫存任何其他嘢——就按暫存區現時嘅樣子提交，" +
  "並且根據上面嘅暫存 diff 起草提交訊息。";

/** 修补上一个提交。放在最后是因为它是唯一会改写历史的目标。 */
export const AMEND_PROMPT =
  "用 `git commit --amend` 修補最近嘅一次提交。" +
  "這係用戶明確要求嘅，所以只有本次請求准許修補。" +
  "先暫存相關改動，然後判斷現有嘅提交訊息係唔係仍然貼切：" +
  "貼切就保留，如果修補後嘅內容改變咗佢嘅含義就更新佢。" +
  "除非用戶講明咁做係安全嘅，唔好修補已經推送過嘅提交。";

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
  if (branch) blocks.push(`當前分支：\n\n\`\`\`\n${branch}\n\`\`\``);
  if (status) blocks.push(`當前 git status：\n\n\`\`\`\n${status}\n\`\`\``);
  if (diff) blocks.push(`當前 git diff（已暫存同未暫存嘅改動）：\n\n\`\`\`diff\n${diff}\n\`\`\``);
  if (log) blocks.push(`最近嘅提交：\n\n\`\`\`\n${log}\n\`\`\``);
  if (blocks.length === 0) return "";
  return `## Context\n\n${blocks.join("\n\n")}`;
}

/** diff 过大时的截断说明，跟在被截断的 diff 之后。 */
export const DIFF_TRUNCATED_NOTE =
  "上面嘅 diff 因為太大被截斷咗。" +
  "如果寫提交訊息之前需要睇完剩落嘅部分，自己跑一次 `git diff HEAD`。";

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
    return `## 發布目標\n\n冇配置 \`origin\` 遠端，無處可推。喺本地提交後停手：講明要加返個遠端，唔好自己編一個，亦唔好推到第二度。`;
  }
  const facts = [`origin 遠端：${remote}`];
  // 本地路径形式的远端（/srv/git/repo.git）解析不出 host，也要说清，不能让
  // 模型以为「没有 Host 行」就等于「随便找个平台建 PR」。
  facts.push(
    host
      ? `托管平台：${host}（${FORGE_LABELS[forge] ?? "未識別嘅平台"}）`
      : "托管平台：遠端唔係 URL，認唔到平台"
  );
  facts.push(
    cli
      ? `該平台嘅拉取請求 CLI：\`${cli}\``
      : "該平台嘅拉取請求 CLI：無——呢個平台冇官方 CLI"
  );
  facts.push(
    clis.length > 0
      ? `PATH 上可用：${clis.map((name) => `\`${name}\``).join("、")}`
      : "PATH 上可用：冇拉取請求 CLI（`gh`、`glab` 或者 `tea`）"
  );
  // 预期 CLI 与 PATH 上实际有的对不上时直接点明，不让模型自己交叉比对两行后
  // 仍去跑一条注定失败的命令。
  if (cli && !clis.includes(cli)) {
    facts.push(
      `呢度冇裝 \`${cli}\`：跳過 CLI 嗰步，推送分支，並報告手動建立拉取請求嘅 URL`
    );
  }
  return `## 發布目標\n\n${facts.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * committer 的 system prompt。「Git 安全协议」逐条列出提交过程中必须遵守的
 * 禁令，另加了 miro 侧的输出约定。
 */
export const COMMIT_RUBRIC = `# 提交準則

你正在代表用戶建立一個 git 提交。提交訊息由你起草、提交都由你執行，唔應該要用戶幫你寫。

以下係對你可以做乜嘅約束。佢哋係優先級最低嘅預設值：凡係項目文檔（例如 AGENTS.md 及作用域內嘅等價檔案）或者用戶嘅要求有更具體嘅講法，就以那些講法為準，無論佢哋出現在本對話中這份準則之前定之後。

## Git 安全協議

- 絕對唔好修改 git config。
- 絕對唔好跳過 hook（\`--no-verify\`、\`--no-gpg-sign\` 之類），除非用戶明確要求。
- 一定要建立新提交。除非用戶明確要求修補，絕對唔好用 \`git commit --amend\`。
- 本次請求中絕對唔好 force push、reset、rebase，或者用任何其他方式改寫歷史。
- 唔好 push。本次請求做到提交為止，用戶準備好就自己推。
- 絕對唔好用帶 \`-i\` 參數嘅 git 命令（例如 \`git rebase -i\` 或者 \`git add -i\`），佢哋需要這裡冇辦法提供嘅互動輸入。
- 唔好提交可能含密鑰嘅檔案（\`.env\`、\`credentials.json\`、私鑰、token）。如果這類檔案屬於本次要提交嘅改動，就將佢留在未暫存狀態並在小結裡講明。只有用戶明確點名咗該檔案時才提交佢。
- 唔好提交建置產物、依賴目錄，或者倉庫通常會忽略嘅本地臨時檔案。如果發現有這類未追蹤檔案，提一句而唔係暫存佢。
- 如果冇任何可提交嘅嘢，唔好建立空提交。講明工作區係乾淨嘅，然後停手。
- 如果 pre-commit hook 改寫咗檔案，重新暫存佢哋並重試一次提交。如果再次失敗，停手並報告 hook 講咗乜，而唔係繞過佢。

## 寫提交訊息

1. 讀上面最近嘅提交，跟隨倉庫既有嘅訊息風格：同樣嘅前綴約定（\`fix:\`、\`tui:\`、純祈使句，用嘅係邊種就跟邊種）、同樣嘅大小寫，標題行保持在 72 個字元以內。
2. 準確概括改動嘅性質。"add" 指全新嘅能力，"update" 指對已有嘢嘅增強，"fix" 指修 bug。唔好將重構講成修復。
3. 講明改動為乜要做，而唔係重述 diff 裡面有乜。diff 已經講咗改咗乜；提交訊息應該講嘅係佢從用戶角度解決咗乜問題。
4. 保持簡潔：一行標題，只有理由確實需要展開時才加一小段正文。唔好拿逐個檔案嘅變更清單去湊長度。
5. 要具體。絕對唔好寫「改進代碼」或者「更新檔案」這種空泛嘅訊息。
6. 用同本對話其餘部分一樣嘅語言寫提交訊息。
7. 唔好在訊息裡加 trailer、署名或者廣告。唔好寫「Generated with」，都唔好幫自己加 "Co-Authored-By"。

## 處理混雜嘅改動

如果工作區裡有幾處互不相關嘅改動，唔好硬塞入一個提交。暫存並提交本次請求所針對嘅那一處內聚改動，然後告訴用戶你留咗邊些冇提交、以及為乜。除非用戶已經要求，拆成多個提交之前先問一句。

## 執行步驟

1. 睇上面嘅 status 同 diff，理解改咗乜。當 diff 本身唔夠講清楚意圖時，讀一讀周邊代碼。
2. 用 \`git add\` 暫存屬於這個提交嘅檔案。
3. 用 heredoc 提交，咁樣換行同引號都可以完整保留：

\`\`\`
git commit -m "$(cat <<'EOF'
提交訊息寫在這裡。
EOF
)"
\`\`\`

4. 用 \`git status\` 或者 \`git log -1 --stat\` 確認提交已經落地。

## 輸出格式

用普通 Markdown 正文寫小結，供人在終端裡閱讀。唔好輸出 JSON，都唔好將整個回覆包在代碼塊裡。

按咁樣組織：

1. 開頭單獨一行給出結論，只可以係以下三者之一：
   - \`**Verdict:** committed\`
   - \`**Verdict:** nothing to commit\`
   - \`**Verdict:** stopped\`
2. 提交成功時，在一行裡給出短 SHA 同標題行，然後最多兩句話講明這個提交覆蓋咗乜。
3. 如果你有意留咗一些改動冇提交，加一個 \`## Left uncommitted\` 小標題，每項一個條目並附簡短理由。
4. 如果你冇提交就停手，講明係乜卡住咗你、以及用戶需要做乜決定。

整個小結保持緊湊：唔好開場白，唔好重述請求，唔好收尾總結或者主動提供後續幫助。`;

/** /commit-push-pr 嘅單回合發布工作流。 */
export const COMMIT_PUSH_PR_PROMPT = `## 你嘅任務

根據上面嘅上下文：

1. 如果當前分支係 \`main\`，先用 \`git checkout -b\` 建立並切換到一個名稱清晰嘅分支，再提交。
2. 用合適嘅提交訊息為當前改動建立一個新提交。
3. 將當前分支推送到 \`origin\`，有需要時設定 upstream。
4. 用同發布目標入面那個 host 匹配嘅 CLI 建立拉取請求：GitHub 用 \`gh pr create\`，GitLab 用 \`glab mr create\`，Gitea / Forgejo 用 \`tea pr create\`。唔好條件反射咁揀 \`gh\`——喺其他平台佢一係冇裝，一係根本連唔上嗰個伺服器。標題要簡潔，正文要概括改動同驗證情況。
5. 如果對應嘅 CLI 缺失、未認證，或者該平台本來就冇 CLI，已推送嘅分支本身就係結果：根據 origin 遠端推導出手動建立拉取請求嘅 URL 並報告佢。絕對唔好編造命令，亦唔好編造拉取請求 URL。
6. 喺本回合連續完成成個工作流，唔好喺步驟之間停低。如果前置條件唔滿足或者命令失敗，就停喺嗰度，準確講明已經完成咗乜、仲剩低乜。`;

export const COMMIT_PUSH_PR_RUBRIC = `# 提交、推送同拉取請求準則

你正將用戶當前嘅改動發布成一個提交同一個拉取請求。提交訊息同 PR 文案由你起草，需要嘅命令亦由你執行。

以下規則係優先級最低嘅預設值。項目文檔（例如 AGENTS.md 及作用域內嘅等價檔案）或者用戶要求入面更具體嘅說明優先，無論佢哋出現喺對話邊個位置。

## 安全規則

- 絕對唔好修改 git config、跳過 hook、amend、reset、rebase、force push，或者用其他方式改寫歷史。
- 絕對唔好使用需要互動輸入嘅 git 參數。
- 唔好提交可能包含密鑰嘅檔案，例如 \`.env\`、憑據、私鑰或者 token。除非用戶明確點名該檔案，否則將佢留喺未提交狀態並報告。
- 唔好提交被忽略嘅建置產物、依賴目錄或者臨時檔案。
- 唔好直接由 \`main\` 推送：先建立名稱清晰嘅主題分支。
- 只將當前主題分支推送到 \`origin\`；唔好修改 remote，亦唔好刪除分支。
- 拉取請求一定要建喺 \`origin\` 指向嘅平台，用嗰個平台嘅 CLI。唔好因為「試過一條命令」就聲稱拉取請求已經建立；只報告 CLI 真實返回嘅 URL。
- 如果 hook 改寫檔案，重新暫存並重試一次提交；再失敗就停手，唔好繞過 hook。

## 工作流

1. 用提供嘅 status、diff、branch 同最近提交理解完整改動。只有 diff 唔足以說明意圖時先讀周邊代碼。
2. 用 \`git add\` 暫存本次內聚嘅改動，排除敏感或者無關檔案。
3. 只建立一個新提交。跟隨倉庫既有嘅提交訊息風格，標題唔超過 72 個字元，講明改動點解重要，並且唔好加入署名或者廣告。用 heredoc 提交以保住換行同引號：

\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
\`\`\`

4. 如果工作區乾淨，唔好建立空提交。只有當前主題分支已經包含適合發布但尚未發布嘅改動時先繼續。
5. 正常推送到 \`origin\`；冇 upstream 時使用 \`-u\`。絕對唔好用任何 force 參數。
6. 用該平台嘅 CLI 建立拉取請求——GitHub 用 \`gh pr create\`，GitLab 用 \`glab mr create\`，Gitea / Forgejo 用 \`tea pr create\`——唔好預設用 \`gh\`。標題保持簡潔，正文包含簡短嘅 \`## Summary\` 同 \`## Test plan\`；兩者都要基於成個分支嘅改動，而唔係淨係最後一個提交。
7. 喺一個回合內連續執行呢啲步驟，唔好中途請求確認。如果 \`git\` 唔可用，或者該平台嘅 CLI 缺失、未認證、拒絕操作，保留已經完成嘅結果並報告阻塞原因；已推送嘅分支加上手動建立拉取請求嘅 URL 係一個有效結果，而 CLI 從未打印過嘅 URL 唔係。唔好嘗試回滾。

## 輸出格式

返回供人喺終端閱讀嘅簡潔 Markdown。開頭只可以係以下其中一項：

- \`**Verdict:** pull request created\`
- \`**Verdict:** partially completed\`
- \`**Verdict:** nothing to publish\`
- \`**Verdict:** stopped\`

成功時提供分支、短提交 SHA 同標題，以及拉取請求 URL。部分完成時講明 commit、push 同 PR 建立分別完成到邊一步，以及下一步要做乜。有意留下嘅未提交檔案放喺 \`## Left uncommitted\` 下面。唔好輸出 JSON，亦唔好將成個回覆包喺代碼塊入面。`;
