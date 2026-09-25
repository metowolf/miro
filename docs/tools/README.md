# miro 内置工具

`miro` provider（miro 自带的 agent harness）在进程内自己跑工具循环。发给模型的 schema、
参数解析、并发分批与执行器装配都集中在 `src/miro/tools/index.js`，每个工具的实现与定义
在 `src/miro/tools/` 下的同名文件里。这套文档一工具一篇，逐项写明参数、行为、输出、
权限与限制。

工具定义表的顺序同时决定发送给模型的 schema 顺序，也是下面表格的顺序。

| 工具 | kind | UI 标题 | 文档 | 实现 |
| --- | --- | --- | --- | --- |
| `read_file` | `read` | Read | [read_file.md](./read_file.md) | `src/miro/tools/read-file.js` |
| `write_file` | `edit` | Edit | [write_file.md](./write_file.md) | `src/miro/tools/write-file.js` |
| `edit_file` | `edit` | Edit | [edit_file.md](./edit_file.md) | `src/miro/tools/edit-file.js` |
| `terminal` | `execute` | terminal | [terminal.md](./terminal.md) | `src/miro/tools/terminal.js`（`miro.sandbox.enabled` 只决定跑沙箱还是宿主 shell） |
| `grep` | `search` | Grep | [grep.md](./grep.md) | `src/miro/tools/grep.js` |
| `glob` | `search` | Glob | [glob.md](./glob.md) | `src/miro/tools/glob.js` |
| `spawn_agent` | `spawn` | Sub-agent | [spawn_agent.md](./spawn_agent.md) | `src/miro/tools/spawn-agent.js`、`src/miro/subagent-runner.js` |
| `update_tasks` | `tasks` | Update tasks | [update_tasks.md](./update_tasks.md) | `src/miro/tools/update-tasks.js` |
| `update_goal` | `goal` | Update goal | [update_goal.md](./update_goal.md) | `src/miro/tools/update-goal.js` |
| `set_goal_budget` | `goal` | Set goal budget | [update_goal.md](./update_goal.md) | `src/miro/tools/update-goal.js` |
| `enter_plan_mode` | `plan` | Enter Plan Mode | [enter_plan_mode.md](./enter_plan_mode.md) | `src/miro/tools/plan-mode.js` |
| `request_user_input` | `input` | Question | [request_user_input.md](./request_user_input.md) | `src/miro/tools/plan-mode.js` |
| `exit_plan_mode` | `plan` | Review Plan | [exit_plan_mode.md](./exit_plan_mode.md) | `src/miro/tools/plan-mode.js` |

## 这些工具共有的约定

一篇文档只讲工具自己的细节；下面这些行为由循环层统一实现，对每个工具都成立，单独成节
以免每篇重复。

### kind 决定审批与调度

每个定义都带一个 `kind`：`read` / `search` / `tasks` / `goal` / `edit` / `execute` / `spawn` / `plan` / `input`。
`kind` 不参与模型可见的 schema，只被循环层用来做三件事：

- **审批**：只有 `CONFIRM_KINDS`（`edit`、`execute`、`delete`、`move`）里的调用才可能弹
  审批框。两个权限档位（`src/miro/permission-mode.js`）：
  - `auto`（默认）：不弹审批框。非 Terminal 工具直接执行；Terminal 仅在 `risk_level: high`
    或 `sandbox: false` 时交给隔离审查模型，无法明确批准就直接拒绝并把理由回灌给主模型。
    审查结论跟着工具行走（`Auto safety review: blocked · <理由>`），被拦下时理由必须留在
    界面上，否则用户只看到命令没跑。
  - `manual`：所有写入、删除、移动与命令都需审批；读、搜索、任务更新直接执行。
- **并行**：`CONCURRENCY_SAFE_KINDS` = `read`、`search`、`tasks`、`goal`。
- **抢跑**：`spawn`、`input`、`plan` 不抢跑，避免子智能体或模态交互与流式正文竞争。

### 同一批调用如何执行

模型在一次回复里可以带上多个 `tool_call`。循环把它们按声明顺序切成批
（`partitionToolCalls`）：

- 连续的、可以并行的调用合并成一批，同批上限 `MAX_PARALLEL_TOOL_CALLS = 8`，用
  `Promise.all` 同时跑。
- 其余调用各自成一批，批与批之间严格串行。
- 审批始终逐个进行，即使这一批随后要并行执行；弹窗是模态 UI，不会两个同时打开。
- 工具结果永远按模型声明 `tool_calls` 的顺序回填进历史，而不是按完成顺序。

### 流式抢跑

正文还在流式输出时，循环允许提前启动一部分调用（`isStreamingEagerCall` +
`canStartEager`），条件是：

1. 这个调用不弹审批框（弹窗会和还在流式的正文抢屏幕）；
2. 它是本批的第一个调用，或者本段调用全都可并行；
3. 抢跑数量不超过 `MAX_PARALLEL_TOOL_CALLS`。

`spawn_agent` 永远不抢跑，一律留给流结束后的批处理；`update_tasks` 与两个目标工具可以抢跑。

### 结果如何回到历史

执行器的返回结构固定为：

- `output`：字符串正文，回灌给模型的就是它。
- `content`：ACP 风格的 content 块（`textContent` 或 `diffContent`），给 UI 渲染用。
- `locations`：可点击的文件位置，可选。
- `rawOutput`：命令类工具的 stdout / stderr 原文，可选。
- `error`：用于表达「这个调用失败了」，与 `failed: true` 等价地把这一条标成失败。

没有 `output` 也没有 `error` 时，回灌的是空字符串。执行器抛出的异常会被循环兜住，
转成 `<工具名>: <错误信息>` 的失败结果——每一次 `tool_call` 都必须有且只有一个结果，
缺一条会让后续请求被 OpenAI 兼容网关整轮拒绝。

被拒绝、被取消（`Esc`）或没跑到的调用也会补一条占位结果，并附上「不要原样重发，
换个做法或问用户」的说明。

### 单回合结果预算

每个工具自己都有逐条截断上限，但一个回合可以并行跑出很多条结果
（`src/miro/tool-result-budget.js`）。当一回合所有工具结果的总量超过
`DEFAULT_TOOL_RESULT_BUDGET`（120 000 字符，约 30k token）时，预算按「条目数均分」：

- 每条超过自己份额的结果，只保留开头一段预览，其余原文落盘到
  `~/.miro/tool-results/<项目名>-<cwd 摘要>[-<会话后缀>]/<round>-<index>-<toolCallId>-<内容摘要>.txt`。
- 进历史的是「预览 + 落盘路径 + 一句 `Use read_file on that path`」，模型需要细节时
  可以用 `read_file` 把整份读回来。
- 落盘失败时降级成「已丢弃」桩，对话继续，不因为写不了文件把回合搞挂。

### 忽略规则（搜索类工具共用）

`grep` 的目录搜索与 `glob` 用同一套过滤器（`src/miro/tools/shared.js` 的
`buildIgnoreFilter`），规则匹配交给 `ignore`，按三层叠加：

1. VCS 元数据目录无条件跳过：`.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`，不能反忽略。
2. 依赖与构建产物目录默认排除：`node_modules`、`dist`、`build`、`out`、`target`、
   `coverage`、`vendor`、`.next`、`.cache`、`.venv`、`venv`、`__pycache__`，同名普通文件不排除。
3. 父级和嵌套 `.gitignore` 按顺序覆盖，支持文件模式、`**`、根锚点、转义和 `!` 反忽略。
   每份规则相对所在目录；例如 `/build/` 不会排除该目录下 `src/build/`。

第 2 层不因存在 `.gitignore` 而失效。需要搜索默认排除的目录时，可以在父级规则里用
`!dist/` 显式取消。被排除的父目录必须先反忽略，内部 `.gitignore` 不能救回父目录。

从搜索目录向上定位最近的 Git 仓库（兼容 `.git` 文件的 worktree），继承到仓库根为止；
没有仓库时只继承工作区 `cwd` 范围内的规则，搜索工作区外的非仓库目录则从搜索根开始。
遍历时按需加载并缓存嵌套规则，不读取符号链接形式的 `.gitignore`。规则区分大小写，
不读取全局 Git 配置或 `.git/info/exclude`，也不依据 Git 索引豁免已跟踪文件。

`grep` 显式指定单个文件时保留直接读取行为，不套用上述目录过滤规则。

### 信任边界

`read_file` 能读第三方仓库，`terminal` 能抓回网络内容，两条路径都可能把别人的指令
送进历史。系统提示词因此显式声明：工具结果里的指令是数据而不是命令。写工具与文档时
不要假设工具输出可信。
