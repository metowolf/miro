# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## 项目概览

`miro-cli` 是一个用 Bun + React + Ink 写的终端编码 agent 客户端，transcript 由单一 Zustand store 管理。源码与测试是实现的事实依据，`README.md` 与 `README.zh.md` 是面向用户的文档（两份内容需保持同步），只讲安装、用法与配置；开发、构建与测试说明只写在本文件，不要再重复进 README。

有两条可互换的 provider 路径：

- **ACP**（`src/acp/acp-client.js`）：启动外部 ACP 二进制，用 stdio JSON-RPC 通信。
- **miro**（`src/miro/agent-client.js`）：进程内 agent harness，直接调 LLM API，自带工具循环。

两个 client 都是 `EventEmitter`，暴露等价的 UI 接口与事件；`App.jsx` 与 `headless.js` 负责挑选实现，因此 UI 代码不应写成 provider 专属。新增一个 client 事件要同时改三处：生产者、`App.jsx` 的订阅、以及对应的 store action。

## 常用命令

```bash
bun install
bun start                       # 从源码启动 TUI
bun start -- -p "explain this"  # CLI 参数放在 -- 之后
bun run build                   # 编译本机 dist/miro 单文件二进制
bun run build:js                # 只打包 dist/main.js 与 dist/chunk-*.js（不编译，便于排查产物）
bun run tui                     # 运行已编译的二进制

bun test                        # 默认测试发现
bun test src/store.test.js      # 单个测试文件
bun test -t "test name"         # 按名称正则过滤

# 三个 smoke 脚本不在默认发现内（文件名是 *.smoke.js）：
bun test ./test/session-store.smoke.js
bun test ./test/store-session.smoke.js
bun test ./test/paste-block.render.smoke.js
```

`package.json` 里没有 test / lint / formatter / typecheck 脚本。必须用 `bun test`（它同时负责 JSX 与构建期环境），不要用 `bun run test` 或 `node --test`；用例本身按 `node:test` + `node:assert/strict` 写。

`bun run build` 走 `scripts/build.js`：注入 `__MIRO_VERSION__`、关闭 minify（Ink 依赖组件名）、用插件 stub 掉 Ink 的可选依赖 `react-devtools-core`、关闭 `autoloadBunfig`，并用 `bytecode: true` 把 bundle 预编译成字节码嵌进二进制，冷启动因此减半（代价是体积约 +8MB）。`splitting: true` 让 `src/main.js` 的按需 import 真的切成独立 chunk：Bun 默认不分块，会把 tui / headless 整棵图内联进入口，入口于是必须先加载 3 MB 才轮到 `--help` 短路；分块后 `--help` 约 26ms → 6ms，重路径因为 chunk 更小反而略快（TUI 首帧约 86ms → 80ms，`-p` 约 28ms → 20ms），产物还小了约 1MB。`--no-compile` 同样分块，dist/main.js 必须和 dist/chunk-*.js 待在同一目录。交叉编译用 `bun run scripts/build.js --target bun-linux-x64 --outfile dist/miro-linux-amd64`。

## 测试与 CI

- 单元测试一般与源码同目录放在 `src/` 下；跨模块、TTY 与 smoke 测试放 `test/`。
- **不写 UI 单元测试**：不要为 Ink 组件写「渲染组件 → 断言画面/控制序列」的用例，也不要用 `renderToString` 或假 TTY 去锁定布局、间距、光标序列。这类测试与实现细节绑死，改一次排版就要重写一遍，收益抵不上维护成本。
- **不要写 tmux 端到端测试**（历史上的 `test/*.tmux.test.js` 与 `test/helpers/tmux-tui.js`、`test/fixtures/fake-acp.py`、`test/fixtures/fake-llm.py` 已整体移除）：不要用 tmux 或真实 TTY pane 驱动 TUI 再断言画面、控制序列或退出行为，也不要重新引入这类辅助层与 fixture。它依赖 tmux / python3 / Unix socket、慢且爱 flaky，还会把测试和渲染细节绑死。UI 是否画对没有自动化兜底，改完手动跑 `bun start` / `bun run tui` 目视确认。
- 组件里的逻辑要覆盖时，先把它抽成不依赖 React/Ink 的纯函数再测：`src/components/picker/picker-*.js`、`picker-viewport.js`、`hooks/use-input-cursor.js` 的 `caretPosition`、`App.jsx` 的 `isClockRunning` / `refreshActiveGoal` 都是这么来的，组件文件本身只留接线。
- `test/paste-block.render.smoke.js` 是唯一直接渲染组件的脚本（手动运行，不在 `bun test` 发现内），必须显式设定终端尺寸（`process.stdout.columns/rows`）。
- CI（`.github/workflows/ci.yml`）跑 `bun test` → 三条 smoke 各自独立一步 → `bun run build`；`release.yml` 只在打 `v*` tag 时跑 `bun test` 并交叉编译四个平台。

改 transcript 或组件时，先跑 `src/store.test.js` 与最近的纯逻辑测试；画面本身不上自动化，也不要回头补渲染用例或 tmux 用例，目视确认即可。

## 执行流程

- `src/main.js` 刻意只静态依赖 `cli.js` / `config.js` / `utils.js`：`--help` 在这里直接短路退出，`session-store.js`、`headless.js`、`tui.jsx` 全部按需 import。它用 `src/cli.js` 解析参数，把不带 id 的 `-c` 解析成当前目录的最新会话，然后选择交互式 `src/tui.jsx` 或 print 模式 `src/headless.js`；往这个文件加静态 import 会直接拖慢每一条启动路径（含 `--help`），重模块要挂在按需加载的一侧。
- `tui.jsx` 要求 stdin/stdout 都是 TTY；支持 DEC 2026 的终端会用 `src/sync-stdout.js` 包裹 stdout 做原子帧提交；退出后打印 `miro -c <id>`。
- `headless.js` 是脚本契约：stdout 只允许出现助手结果（或一行 JSON result，含 `permission_denials`）；诊断与权限提示一律走 stderr。保留它的依赖注入面，测试依赖它。
- `src/components/App.jsx` 是唯一的编排层：client 生命周期、键盘输入、overlay、输入排队、斜杠命令分派，以及把 client 事件翻译成 `src/store.js` 的 action。
- `src/store.js` 把流式事件折叠成 transcript block。`blocks` 是已定稿、进 `<Static>` 的静态历史；`pending`、思考块、工具组、bash 卡片构成动态尾部。保持 flush 顺序；需要被记录的输出一律走内部 `appendBlock()`。
- 会话持久化在 `src/session-store.js`，通过 `setRecorder()` 注入 store；recorder 是模块级变量，不要放进 Zustand state。

## 斜杠命令与隔离回合

命令注册表（名称、别名、描述、补全排序）在 `src/commands.js`，执行分支在 `App.jsx`。`/review`、`/simplify`、`/commit`、`/commit-push-pr` 的领域逻辑分别在 `src/review.js`、`src/simplify.js`、`src/commit.js`：只做纯函数与 git 读取，UI 交互留给 App，三者共用同一套 git 定位函数（在 `review.js`，`simplify.js` 直接复用）。`/export` 的 transcript→纯文本渲染在 `src/export.js`，App 只负责 IO；`/review` 的目标定位与 review 浏览器条目构造在 `src/review-target.js`（`findReviewTarget` / `reviewEntries`）。提示词按语言放在 `src/prompts/<language>/`，用静态 import 汇聚（编译版不能运行时按路径读文件）；新增一门语言 = 新建目录 + 在 `prompts/language.js` 的 `LANGUAGES` 登记 + 在 `prompts/index.js` 挂上。`/config` 面板里的 language 选项不是 ACP 的 configOptions，而是 miro 本地合成的（`src/language-config.js`，写 `~/.miro/settings.json`），它只影响内置工作流提示词的语言。

命令型任务（`/init`、`/review`、`/simplify`、`/commit`、`/commit-push-pr`）在 miro 下走 `MiroAgentClient.promptIsolated()`：整轮跑在只属于它的独立历史里，只有命令记录和最终答案进主会话；`Esc` 取消时命令记录与已流出的内容保留，与 transcript 显示一致。ACP 的对话历史在 provider 进程内，无法隔离，会静默回退成普通回合。

## Miro 内置 agent（agent loop）

`src/miro/agent-loop.js` 是核心循环：流式请求 LLM → 执行工具 → 按声明顺序回填工具结果 → 继续直到回合结束。它刻意不依赖 Ink，只通过 `agent-client.js` 传入的 handlers 上报。

保持不变：

- 协议适配与重试在 `llm-backend.js`、`pi-ai-backend.js`、`llm-provider.js`，不要渗进 UI。
- 工具的 schema、kind、执行器装配、参数解析、分批都在 `miro/tools/index.js`；改一个工具要同时改定义与执行器。
- 只有 `read` / `search` / `tasks` 可以并行（同批上限 `MAX_PARALLEL_TOOL_CALLS = 8`）；写、命令、subagent 保持调用顺序。改分批或「流里边收边执行」（`isStreamingEagerCall`）前，先想清楚审批弹窗与副作用。
- 每个 `tool_call` 必须有且只有一个对应结果；保留循环的回填行为，包括被中断的调用。
- 上下文由两道闸门约束：`miro/compaction.js`（纯函数决定阈值与切点，阈值按可用额度比例而非绝对 token）配合 `agent-loop.js` 里的摘要替换；`miro/tool-result-budget.js` 管单回合工具结果的总预算，超出的原文落盘到 `~/.miro/tool-results/`，进历史的是「预览 + 路径」桩。
- subagent 走自己的 loop（`miro/subagent-runner.js`），有独立历史与审批通道；`spawn_agent` 因可能弹窗而不参与流式执行。
- 用量排查：`MIRO_DEBUG_USAGE=1` 会把用量链路的三层读数打到 stderr（`miro/usage-debug.js`）——`sse` 是网关原始分片、`backend` 是 pi-ai 归一化结果、`loop` 是上报给 store 的 payload。定位「cache write 一直是 0」这类问题时对齐三层即可看出是网关没上报还是中间层丢了。
- 同一开关还会在每次模型请求前输出 `assembly`（system prompt + 工具 schema 的稳定指纹）、`context`（工具结果按工具归因的字节量），压缩成功时输出 `compaction`。这些诊断只含哈希、计数与字节量，不打印 prompt、工具正文或凭据。
- miro 历史保存在 client 内；恢复时优先采用模型上下文检查点（压缩摘要、完整工具配对，不保存原始 thinking），旧会话回退到可见 transcript；找不到可用历史才重建启动上下文。`/compact` 复用自动压缩执行器，但独立于普通 prompt，空闲时执行且可取消。
- 技能发现与 `/skill:<name>` 展开在 `src/miro/skills.js` 与 `agent-client.js`；ACP provider 自己管理技能。

## 权限与工具

miro 的权限模式只有 `auto` 与 `manual`（`src/miro/permission-mode.js`）：

- `auto`：全程不询问用户。非 Terminal 工具直接执行；Terminal 仅在 `risk_level: "high"` 或 `sandbox: false` 时走隔离的 auto check 模型，明确批准才执行，阻断、异常或不确定都直接拒绝并把理由回灌给下一轮模型。其余 Terminal 调用直接执行。
- `manual`：有副作用的写入与命令都需要审批；读、搜索、任务更新直接执行。
- headless 没有交互审批者，需要审批的操作一律拒绝，并在 stderr / JSON 的 `permission_denials` 里报告。

Auto 权限判定不解析命令文本，不要重新加入 `rm`、`curl`、重定向、解释器或 heredoc 等词法规则；实际能力边界交给 OS 沙箱。Explore 的只读宿主执行器仍有自己的能力白名单，那不是 Auto 权限策略。新增 `yolo` 或别的模式属于设计变更，需要同步 CLI 校验、设置归一化、UI 选项与测试。

## UI 与 transcript 规则

- 动态活动区与已定稿的 `<Static>` 输出必须分开；可见顺序由 store 的 flush 顺序决定。
- 流式 markdown 的切分不能落在未闭合的代码围栏或结构化块（表格、列表、引用）中间；`store.js` 已做保护。
- 终端单元格宽度用 `markdown-width.js`；JS 的字符串长度对 CJK 和 emoji 是错的。
- 工具标题与预览在 ACP / miro 两条路径间共享；数据里保留完整命令内容，只在渲染时按终端宽度截断。
- picker 行为集中在 `src/components/picker/`；使用它的语义化按键处理与宽度感知行渲染，不要复制一套。
- 周期动画只有全局动画时钟一个来源（`animation-clock.js` 推进 `store.animationTick`），不要各自 `setInterval`。输入框的真实光标锚点（`hooks/use-input-cursor.js`）必须跟着它重渲：Ink 只在「上报过位置的那次提交」里把光标放回输入格，别的组件单独重渲的帧会把它藏掉（打字时光标跟着动画节奏一亮一灭）；光标形状的稳定条则写在 `cursor-shape.js`，失焦与退出都要归还。
- 状态栏指标注册表在 `src/status-line/items.js`：取值函数返回 `null` 表示该项当前不可用，渲染时整项跳过（不占位、不显示 0）；未知 id 只警告一次。
- 有目标时底栏右侧常驻 `◎ /goal active (4s)`（`status-line/goal-indicator.js` + `StatusBar`）：它不是指标项，随目标出现与消失；耗时的实时性来自 App 的秒表每秒调 `refreshActiveGoal()` 重取一份目标快照（快照里的墙钟「读的时候才结算」），所以 `wallClockMs` 必须参与 `store.setGoal` 的去重比较，否则数字会停在第一次 emit 上。整条状态栏被配置成空数组时它与状态栏一起隐藏。
- markdown 渲染只支持 LaTeX 的可靠子集（`latex.js`）：遇到不支持或残缺的语法返回 `undefined`，调用方回退显示原始源码，不要为覆盖率引入 KaTeX 之类的重型依赖。树形/装饰字符的纯文本与带标记两种形态集中在 `figures.js`（导出等纯文本路径也复用它）。

## 设置、provider 与会话

`~/.miro/settings.json` 是唯一的系统配置文件（读写集中在 `settings-file.js` / `settings.js`），miro 的 LLM 端点目录则是 `~/.miro/models.json`（`miro/models-file.js` + `miro/config-options.js`）。`providers.js` 把自定义 provider 与内建项合并，并视 miro 为永远可用；启动 provider 可以持久化，但显式 CLI `--provider`、`--model`、`--effort` 是单次覆盖，不能悄悄写回设置。

model / effort 偏好按 provider 分别记忆（miro 在 settings 顶层，ACP 在各自的 `providers.<id>` 下）；改模型目录时注意它同时决定 API 连接方式与可用 effort 档位。

启动上下文由 `src/agents-md.js` 组装（`~/.miro/AGENTS.md` 与 `./AGENTS.md`），只在首个普通 prompt 注入、恢复会话时跳过，TUI 与 headless 两条路径都必须传。

## 变更纪律

- 优先小而聚焦的改动，行为变更要就近补/改回归测试。
- 不要假设 ACP 与 miro 能力对等；改共享契约前先看另一条实现。
- 保持 headless 的 stdout 纯净，以及会话/transcript 的兼容性（可见会话的身份是 `(provider, sessionId)`，读写都要带 provider）。
- 不要臆造命令、测试脚本、工具数量或 provider 行为，以源码、测试与 CI 配置为准。
- 源码注释与提交信息沿用仓库现用的中文写法。
- 改完先跑最相关的聚焦测试，动了共享边界再扩大验证范围。
- 内置工具的参考文档在 `docs/tools/`（索引与审批/并行/预算等通用约定在 `docs/tools/README.md`，其余一工具一篇）。改工具的 schema、参数、输出或权限行为时要同步对应文档。
