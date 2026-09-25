<p align="center">
  <img src="logo.png" alt="Miro" width="120" height="120">
</p>

<h1 align="center">Miro</h1>

<p align="center">
  面向 ACP 兼容编程智能体的终端客户端。<br>
  支持交互式 TUI 与一次性打印模式，基于 Bun、React 与 Ink。
</p>

<p align="center">
  <a href="./README.md">English</a>
  ·
  中文
</p>

---

**miro-cli** 自带直接调用 Chat Completions、OpenAI Responses 或 Anthropic Messages 的 agent 和工具循环。只有显式传入 `--acp <provider-id>` 时，才会将 [Agent Client Protocol](https://agentclientprotocol.com/) 提供方作为子进程启动，并通过 stdio JSON-RPC 通信。

## 环境要求

- [Bun](https://bun.sh/) **>= 1.2**
- 为 Miro 自带 agent 准备一个兼容的 API 端点；仅在使用 `--acp` 时才需要 `PATH` 上的 ACP 提供方二进制（见 [ACP 提供方](#acp-提供方)）

## 安装与运行

```bash
bun install
bun start
```

为当前平台编译独立二进制：

```bash
bun run build
./dist/miro
```

`bun run build:js` 会生成可检查的 ESM 包，而不是编译后的二进制。

带 `v*` 的发布标签会构建 Linux / macOS（x64 与 arm64）二进制。本地交叉编译与 CI 使用相同参数：

```bash
bun run scripts/build.js --target bun-linux-x64 --outfile dist/miro-linux-amd64
```

## 用法

```bash
miro
miro -p "Analyze this project"
echo "Summarize this input" | miro -p
miro -p --output-format json "Fix the tests"
miro --model hy3
miro --effort high
miro --acp claude
miro --continue
miro --resume <session-id>
./dist/miro -c <session-id>
```

从源码运行时，在 `--` 之后传递参数：

```bash
bun start -- -c <session-id>
bun start -- -p "Analyze this project"
```

### 选项

| 参数 | 说明 |
|------|------|
| `-p`, `--print` | 非交互执行一次请求后退出 |
| `--output-format <text\|json>` | 打印模式输出格式（需配合 `--print`） |
| `--acp <provider-id>` | 按 id 启动可用的 ACP 提供方；不传时始终启动 miro |
| `--model <model>` | 按值或显示名选择模型（交互与打印模式均可用） |
| `--effort <level>` | 按值或显示名选择思考强度（交互与打印模式均可用，不保存） |
| `-c`, `--continue [id]` | 继续会话；省略 `id` 则使用当前项目最近一次会话 |
| `--resume <id>` | 按指定会话 id 恢复 |
| `--permission-mode <m>` | miro 权限模式：`auto`（默认）或 `manual` |
| `--mode <mode>` | 交互模式：`default` 或 `plan` |
| `-h`, `--help` | 打印帮助 |

`--output-format` 仅能与 `-p` / `--print` 同时使用；`--acp`、`--model`、`--effort` 也可在启动交互式 TUI 时使用，且只影响本次运行。`--acp` 只接受可用 ACP 提供方的 id，不能传 `miro`；已移除的 `--provider` 会报迁移错误。不带 `--print` 的裸提示会报错。`-c` 不带 id 只继续本次启动模式下最近的会话（ACP 还限定为同一 id）；`--resume` 必须提供 id。

## 命令

在交互式输入框中使用：

| 命令 | 说明 |
|------|------|
| `/init [extra]` | 分析代码库并创建或改进 `AGENTS.md` |
| `/login` | 登录订阅提供方（ChatGPT/Codex、Claude、Copilot、OpenRouter、Kimi 或 xAI） |
| `/model [model]` | 选择或切换模型 |
| `/effort [level]` | 设置当前模型的努力程度 |
| `/config [id] [val]` | 查看或修改 ACP 会话配置项 |
| `/thinking [mode]` | 设置思考呈现为 `compact`（默认）、`full` 或 `hidden`；不带参数打开选择器 |
| `/permissions [mode]` | miro 权限模式：`auto`（默认）或 `manual`；不带参数打开选择器 |
| `/plan [on\|off\|status]` | 进入、退出或查看 Plan 模式（仅 miro） |
| `/statusline [reset]` | 配置状态栏项目、顺序与颜色 |
| `/review [text]` | 审查代码改动；不带参数打开选择器（未提交、分支、commit 或自定义指令） |
| `/goal [text]` | 朝一个目标持续工作，直到模型报告完成或受阻；回复运行中输入新目标会安全中断当前回合并接管。不带参数查看当前目标，另有 `replace`、`status`、`pause`、`resume` / `cancel` 子命令（仅 miro） |
| `/simplify [text]` | 在保持行为不变的前提下简化代码；可传路径或自由指令 |
| `/commit [text]` | 为当前改动创建一个提交；可用文本指导提交信息 |
| `/commit-push-pr` | 创建一个提交、把分支推送到 `origin`，并用该远端平台的 CLI（`gh`、`glab` 或 `tea`）创建拉取请求 |
| `/resume [id]` | 恢复已保存会话；不带 id 打开选择器 |
| `/continue [id]` | `/resume` 的别名 |
| `/new` | 新建会话，不清除终端 |
| `/sessions` | 列出当前项目已保存的会话 |
| `/clear` | 新建会话并清除终端与可见记录 |
| `/export [file]` | 导出对话（剪贴板或 `.txt` 文件） |
| `/help` | 显示帮助 |
| `/exit` | 退出（`exit`、`/quit`、`quit`），并打印会话累计用量 |
| `!<command>` | 在本地执行 shell 命令，输出会附到下一次普通提示 |

ACP 声明的提供方专用斜杠命令会原样转发。

`/commit-push-pr` 会先读 `origin` 远端再挑对应的 CLI：GitHub 用 `gh`，GitLab 用 `glab`，Gitea / Forgejo 用 `tea`。该 CLI 缺失、未认证，或平台本身没有 CLI（Bitbucket、无法识别的自建实例）时，它仍会提交并推送，然后给出手动创建拉取请求的 URL，而不是编造一个。仓库没有 `origin` 远端时，本地提交完就停下。

回合进行中时，普通提示按 FIFO 排队。斜杠命令立即执行。忙碌时拒绝 `!command`。

## 快捷键

| 按键 | 作用 |
|------|------|
| Enter | 发送提示 |
| Shift+Enter | 插入换行（Miro 会启用 Kitty 与 xterm 扩展键上报；不支持的终端仍无法将它与 Enter 区分） |
| `?` | 快捷键速查（输入框为空时） |
| ↑ / ↓ | 输入历史或补全 |
| Ctrl+M | 选择或切换模型（需要终端支持 kitty 键盘协议，否则该键与 Enter 相同） |
| Shift+Tab | 循环交互模式（`Default` / `Plan`） |
| Ctrl+O | 打开整屏的 Review 窗口：实时与已保留的思考、shell 输出与工具详情 |
| Ctrl+Q | 审阅、编辑、重排或删除排队消息 |
| Ctrl+L | 清除终端显示（不结束 ACP 会话） |
| Ctrl+C | 清空输入框；输入框为空时中断当前回合，2 秒内再按一次退出。任何正常退出方式（Ctrl+C、`/exit`、裸 `exit`/`quit`）都会打印同一行会话累计用量，形如 `Stat ↑12.4k ↓2.1k  R84.3k W6.2k CH81.9%  $0.018`：↑/↓ 是输入与输出的会话累计值，`R`/`W` 是缓存读/写（本会话出现过缓存读数后整段出现，没有读数的一侧补 0），`CH` 是缓存命中率（命中 /（未命中输入 + 命中 + 写入）），末段是会话累计成本（不足 1 时保留三位小数，不足 0.001 时保留四位；miro 累加每次主循环 LLM 请求，ACP 直接用 agent 上报的累计 `usage_update` 成本）；提供方从未上报过用量与成本时这一行整体不打印 |
| Esc | 关闭快捷键帮助，或中断当前回合 |

`@` 补全文件路径（优先 `git ls-files`，否则回退到文件系统）。多行粘贴会作为一次提交保留：编辑时折叠显示，发送后在会话记录中还原为原文。

## 渲染

智能体回复会在终端里按 Markdown 渲染：标题、列表、表格、围栏代码块与行内代码都会着色，行内 `$...$` 与块级 `$$...$$` 数学公式会以 Unicode 字形呈现。流式过程中未闭合的数学分隔符会原样输出，直到回合结束；不支持的 LaTeX 语法保留为纯文本。这仅影响显示，你发送的消息文本不会被改动。

思考内容使用三层披露方式。流式阶段若存在开头的 `**粗体标题**`，miro 会提取它并维持稳定的活动状态行；这一行还会带上计时，提供方上报过用量之后再加上 token 数，例如 `Thinking… (12s · ↑5 ↓2.9k)`：↑/↓ 是提供方最近一次读数里的输入与输出（miro 是每次 LLM 调用，ACP 是回合结束时 `PromptResponse` 的用量），不上报用量的提供方不会显示这一段。定稿后按持久化的 `thinkingDisplay` 设置呈现：`compact` 只保留标题与耗时摘要，`full` 额外打印 Markdown 正文，`hidden` 不进入可见 transcript。`/thinking` 打开选择器，`/thinking compact|full|hidden` 可直接切换。Ctrl+O 打开整屏的 Review 窗口，浏览实时思考、实时 shell 输出以及 transcript 里保留的思考与工具详情：列表里用 ↑/↓ 选中、Enter 进入详情，详情里用左右键切换到该列表的上一条 / 下一条。

可见会话文件仍只保存思考元数据。原始 ACP 流量日志现在默认也会省略 `agent_thought_chunk`；只有确实需要这些敏感调试信息时，才应在 `~/.miro/settings.json` 中显式设置 `"recordRawThinking": true`。

## ACP 提供方

Miro 默认使用自带 agent。要进入 ACP，显式使用 `miro --acp <id>`；对应二进制必须在 `PATH` 上。也可以在 `~/.miro/settings.json` 的 `providers.<id>` = `{ command | bin, args, name }` 新增或覆盖 ACP 定义。Miro 会把 ACP 提供方上次 `/model` 与 `/effort` 的选择记在同一条目的 `model` / `effort` 里。

| Id | 名称 | 二进制 |
|----|------|--------|
| `pi` | Pi | `pi-acp` |
| `cursor` | Cursor | `cursor-agent` |
| `claude` | Claude | `claude-agent-acp` |
| `codex` | Codex | `codex-acp` |

### 内置 agent

Miro 自带的 agent 不启动子进程、不走 ACP 协议，而是直接调用 LLM API，自己跑工具循环（`read_file`、`write_file`、`edit_file`、`terminal`、`grep`、`glob`、`spawn_agent`、`update_tasks`），并对外发出与 ACP client 相同的事件。它同时支持 OpenAI Chat Completions（默认）、OpenAI Responses 与 Anthropic Messages，无需安装任何二进制。长对话会自动压缩，压缩时 transcript 与模型都会看到一条 `Context compacted` 提示。

以「产出报告」为目的的命令——`/review`、`/simplify`、`/commit`、`/commit-push-pr`、`/init`——跑在**独立上下文**里：命令的提示词（rubric、预读的 git 上下文、你的指令）以及模型为此读过的每个文件，都留在这次运行专用的历史里，只有一行命令记录（随回合开始即入会话）与最终结论并入会话。于是一次读了五十个文件的审查不再挤占对话上下文，而结论照样落在 transcript 上——之后说「把第 2 条修掉」仍有据可依。按 `Esc` 取消时，命令记录与已经流出的内容仍留在会话里，与 transcript 所见一致，恢复会话后看到的历史也相同。这条只在 miro 下成立：ACP 提供方的对话历史在它自己的进程里，miro 既无法隔离也无法修剪，那里这些命令照旧作为普通回合执行、留在对话中。

miro 用到的上游写在 `~/.miro/models.json`。打开 `/model` 会重新读取该文件，改完不必重启：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`api` 可以是 `openai-completions`、`openai-responses` 或 `anthropic-messages`（提供方或模型级）。`apiKey` 可以是字面量、`$ENV_VAR` / `${ENV_VAR}`，或发请求时执行的 `!command`。选中某个模型会同时带上该提供方的 `baseUrl` / `api` / `apiKey`。选择器的值与顶层记下的 `model` 偏好始终是 `provider/id`（例如 `ollama/llama3.1:8b`）。`/model llama3.1:8b` 与 `--model llama3.1:8b` 在该 id 唯一时仍可匹配。

推理模型需设置 `"reasoning": true`。`thinkingLevelMap` 把 miro 的标准 effort 档位映射成上游值：字符串给出上游值，`null` 隐藏不支持的档位；缺省的 `minimal` 至 `high` 使用同名映射，缺省的 `xhigh` / `max` 视为不支持。`/effort` 只展示当前模型支持的档位。

`models.json` 缺失或没有可用条目时，回退到 `~/.miro/settings.json` 里的 `miro` 对象：

```json
{
  "miro": {
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      { "id": "gpt-4o-mini", "name": "GPT-4o mini", "contextWindow": 128000 }
    ],
    "model": "gpt-4o-mini",
    "protocol": "chat-completions",
    "effort": "medium",
    "thinking": true,
    "sandbox": { "enabled": false }
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `protocol` | `chat-completions` | 仅在未使用 `models.json` 时生效：`chat-completions`、`openai-responses` 或 `anthropic-messages`；也可用 `$MIRO_PROTOCOL`。目录里的模型自带 `api`。 |
| `baseUrl` | 按协议决定 | Chat Completions / Responses 默认 `https://api.openai.com/v1`；Anthropic Messages 默认 `https://api.anthropic.com`。`$MIRO_BASE_URL` 优先。`models.json` 里的 `baseUrl` 对目录模型优先。 |
| `apiKey` | `$MIRO_API_KEY`，再按协议回退 | Anthropic Messages 使用 `$ANTHROPIC_API_KEY`，两个 OpenAI 协议使用 `$OPENAI_API_KEY`。在 `models.json` 里还可以写 `$ENV` 或 `!command`。 |
| `models` | `gpt-4o-mini`、`gpt-4o`、`deepseek-chat` | 仅当 `~/.miro/models.json` 没有可用条目时使用。字符串，或 `{ id, name, contextWindow }` 形式。 |
| `model` / `effort` / `thinking` | 首个模型 / `medium` / `true` | 回退默认值；顶层 `model` / `effort` 偏好匹配到可用选项时优先。与 ACP 提供方共用 `/model`、`/effort`、`/config` 流程。 |
| `maxToolRounds` | 不限 | 每个回合工具循环的最大轮数。默认不设上限，因为上下文已由自动压缩兜底；写入数字可为失控的回合兜底。 |
| `temperature` | 不设置 | 传给 API 的采样温度。 |
| `permissionMode` | `auto` | `auto` 全程不询问用户；仅 `risk_level: high` 或 `sandbox: false` 的 Terminal 调用由隔离模型自动审查，其余工具直接执行。`manual` 对写入和命令请求确认。未知值及旧 `ask`、`plan`、`yolo` 配置回退为 `auto`。 |
| `sandbox.enabled` | `false` | 为 `true` 时 `terminal` 工具在 `@anthropic-ai/sandbox-runtime` 的网络沙箱里执行命令：默认断网，只有 `allowedDomains` 能为单次调用放行网络。两种模式下工具同名，沙箱模式只是多出沙箱专属参数。文件系统仍使用宿主权限。需要满足 `@anthropic-ai/sandbox-runtime` 的平台前置条件，失败不会回退为未受限 shell。 |

可用 `/config sandbox on` 或 `/config sandbox off` 持久化修改这个开关，并立即切换当前会话命令工具的沙箱状态。

`/model` 与 `/effort` 的选择按提供方分别记忆。`miro` 使用 `settings.json` 顶层的 `model` / `effort`，其中 `model` 记为 `provider/id`；ACP 提供方则存在自己的 `providers.<id>` 条目里。`miro` 对象里的 `model` / `effort` 只在顶层偏好缺省或匹配不到时作为回退默认值。miro 的 `Default` / `Plan` 交互模式与 `Auto` / `Manual` 权限模式相互独立；`Shift+Tab` 循环交互模式。

### Skill

Miro 支持 `SKILL.md` 约定（Agent Skills）。启动时从 `~/.miro/skills`、`<cwd>/.miro/skills`、`~/.agents/skills`、`<cwd>/.agents/skills` 扫描；额外目录写进 `~/.miro/settings.json` 顶层的 `skills` 数组，`"skills": false` 则整体关闭。含 `SKILL.md` 的目录就是一个 skill，不再向下扫描；裸 `*.md` 文件只有在 frontmatter 里带 `description` 时才算。同名时更靠后的根目录胜出（项目级覆盖用户级，显式路径最后），被遮住的文件会记在 client 的诊断里。

Frontmatter 使用 YAML core 语法，顶层必须是映射，且 `description` 必须为非空字符串。看起来像数字或布尔值的文本请加引号。支持 Unicode 转义、块标量和有限的别名引用，不支持自定义标签或合并键展开。YAML 语法错误、重复键、过量别名展开或超过 64 KiB 的 frontmatter 都会使该 skill 被跳过并留下诊断。

只有每个 skill 的 name / description / 文件路径会写进系统提示的 `<available_skills>`，正文由模型按需用 `read_file` 读取。`/skill:<name> [args]` 则把该 skill 的正文直接注入本轮消息，`-p` 运行同样可用：

```bash
/skill:pdf 提取 invoice.pdf 里的表格
miro -p "/skill:pdf 提取 invoice.pdf 里的表格"
```

`disable-model-invocation: true` 只让 skill 不进模型可见的目录，手动 `/skill:` 仍可用。skill 只增加指令、**不增加能力**：Manual 的审批策略与 Auto 的 Terminal 自动审查策略都不会因 skill 改变。

这只对 miro 生效。ACP 提供方自己管 skill，它广播出来的任何命令（例如 `skill:<name>`）都以普通提供方命令的形式进入 miro。

## 会话与上下文

可见对话记录保存在 `~/.miro/sessions/<拍平后的 cwd>/<acp|miro>/<sessionId>.jsonl`，可通过 `/resume`、`--continue` 或 `--resume` 恢复。ACP 原始流量隔离在 `<拍平后的 cwd>/acp/raw/`，不会再与相同 session ID 的可恢复 transcript 冲突。项目目录名是把 cwd 里所有非字母数字字符折成 `-`（不掺哈希，保持可读）。除非显式开启 `recordRawThinking`，否则会省略原始思考 chunk。持久化失败不会导致程序退出；旧版 transcript 布局不再读取。可见会话的身份是运行方式 + session ID。`/resume`、`/sessions` 与 `--continue` 只显示当前启动模式的会话；要恢复 ACP transcript，须以该 transcript 的 `--acp <id>` 重启。空对话不留下任何东西：transcript 文件（连同它的运行方式目录）只在录到第一条 user/assistant 消息时才创建，零消息的 transcript 也不会被 `/resume`、`/sessions` 或 `--continue` 列出（ACP 原始流量日志不在此列，它仍在会话建立时开写）。

启动时会加载 `~/.miro/AGENTS.md` 与 `./AGENTS.md`（跳过空白或不可读文件，相同文本去重），并在**第一次普通提示**时注入。恢复的会话跳过 AGENTS.md 的重复注入。若第一次请求失败，会恢复注入状态以便重试。

输入框历史独立于对话记录，保存在 `~/.miro/history.jsonl`。

## 配置

模型、努力程度、提示词语言、状态栏和自定义 ACP 提供方偏好保存在 `~/.miro/settings.json`；其中遗留的顶层 `provider` 会被忽略。miro 的上游与模型列表保存在 `~/.miro/models.json`；`/login` 创建的订阅 OAuth 凭据独立保存在 `~/.miro/auth.json`。`/login` 仅在 miro TUI 中可用，会启动提供方的浏览器或设备码流程。OAuth 订阅与 API key 是独立认证路径；请妥善保管 `auth.json`，订阅凭据只应用于你自己的本地使用。`/config` 既可修改 ACP 以 `configOptions` 声明的实时选项，也可修改 miro 自己的 `language` 选项。

### 权限模式

miro 提供 `Auto` 与 `Manual` 两档，默认 `Auto`。`/permissions` 可直接指定或打开选择器；它与 Plan 模式相互独立。

| 模式 | 行为 |
|------|------|
| `auto` | 默认。全程不弹人工审批；非 Terminal 工具直接执行，Terminal 仅在 `risk_level: high` 或 `sandbox: false` 时由隔离模型自动审查 |
| `manual` | 写入、编辑、删除、移动与命令需确认；读取、搜索和任务更新直接执行 |

`Auto` 不解析 Terminal 命令文本，因此 `rm`、`curl`、重定向、解释器与 heredoc 都没有特殊规则；`low` 与 `medium` 直接执行。只有 `high` 或 `sandbox: false` 会把用户意图、此前工具调用与本次动作投影给隔离、无工具的分类器，绝不传入工具结果。分类器明确批准才执行；阻断、异常或不确定都直接拒绝并把理由交给下一轮模型，不会回退询问用户。工具行下会写明审查结论，被拦下时直接给出理由。

```bash
miro --permission-mode auto
miro --permission-mode manual
/permissions manual
```

`/permissions` 和启动参数只影响当前运行，不写入配置；持久化默认值可配置 `miro.permissionMode`。旧配置 `ask`、`plan`、`yolo` 和未知值回退到 `auto`，但显式的非法 `--permission-mode` 值会报错。

配置 `permission-mode` 状态栏项后，分别显示 `AUTO`、`MANUAL`。非交互 miro 运行会按实际档位向 stderr 打印说明，stdout 保持纯结果。

### Plan 模式

Plan 模式把调查与设计同实现分开。可通过 `/plan`、`/plan on` 或 Shift+Tab 进入；模型也能请求进入，但必须由用户确认。该模式保留普通的 Terminal、文件写入、子智能体及本地命令能力；专注规划是行为指令，而不是运行时只读限制。规范计划文件保存在 `~/.miro/sessions/<project>/miro/plans/<session>/<plan-id>.md`。

在任一交互模式中，agent 最多可提出四个结构化问题，支持单选、多选、Markdown 选项预览、自定义文本和备注；在 Plan 模式中随后会提交规范计划文件供审阅。批准会冻结当时的精确文本、返回 Default 模式，并从该冻结快照开启一个全新的实现回合；要求修改会留在 Plan 模式；拒绝则退出且不实现。Plan 状态随会话持久化。目标正在运行时不能进入 Plan 模式。非交互运行与子智能体不会暴露提问界面。

`miro -p --mode plan "设计这项改动"` 刻意采用非交互语义：打印计划后退出，不提问、不打开审批界面、也不实现。ACP 提供方继续使用自己的模式行为。

### 等待动词

状态栏上的等待动词动画可通过 `~/.miro/settings.json` 的 `spinnerVerbs` 自定义：

```json
{
  "spinnerVerbs": { "mode": "append", "verbs": ["thinking", "planning", "searching"] }
}
```

`mode` 为 `append`（追加到内置动词表）或 `replace`（只使用你的列表）。`verbs` 为空或非法时回落为默认值。

### 提示词语言

`/config language English`（或 `en`、`en-us`）、`/config language Chinese`（或 `zh`、`zh-cn`、`中文`）或 `/config language Cantonese`（或 `yue`、`zh-hk`、`zh-yue`、`粤语`、`粵語`）用于设置 miro 内置工作流提示词（`/init`、`/review`、`/simplify`、`/commit` 与 `/commit-push-pr`）的语言，结果写入 `~/.miro/settings.json` 的 `language` 字段。默认英文，未知取值回落为英文。该设置不影响 ACP 会话配置与你自己发送的消息；提示词文本本身放在 `src/prompts/<language>/`，新增一门语言即新增一个目录。

### 状态栏

`/statusline` 可交互选择项目、顺序与颜色。`/statusline reset` 恢复默认。确认时会一并写入 `statusLine` 与 `statusLineUseColors`。

默认项目：`["model-with-reasoning", "current-dir"]`。空数组隐藏状态栏。未知 id 会被忽略（一次性警告）；没有数据的项目会被跳过。

存在目标时，同一行的右侧会常驻 `◎ /goal active (4s)`：目标状态加上它**实际推进**了多久（暂停期间与结束之后都不计入，与预算同一口径）。它不是可配置项，随目标出现与消失；ACP 提供方没有目标机制，那里永不出现。整条状态栏被配置成空数组时，它与状态栏一起隐藏。

可用 id 包括 `model`、`model-with-reasoning`、`reasoning`、`mode`、`permission-mode`、`current-dir`、`project-name`、`hostname`、`git-branch`、`run-state`、`provider`、`session-id`、`session-title`、`miro-version`、`context-used`、`context-remaining`、`context-window-size`、`task-progress`、`goal`、`used-tokens`、`input-tokens`、`output-tokens`、`thought-tokens`、`session-cost`。上下文、token、费用与会话标题类项目需要提供方上报，否则省略。`used-tokens`、`input-tokens`、`output-tokens`、`thought-tokens`、`session-cost` 都是会话累计值：miro 累加主循环的每一次 LLM 请求（子智能体与压缩摘要不计入），ACP 直接采用 agent 上报的会话累计快照（成本则用 `usage_update` 的累计值）；因此它们可能大于活动槽思考行里的「最近一次读数」。`permission-mode` 在 miro 下显示 `AUTO` 或 `MANUAL`；无 miro 权限模式时隐藏。`goal` 显示当前目标的状态与进度，没有目标时隐藏——ACP 提供方没有目标机制，那里恒为隐藏。这些 id 也接受简写别名：`model-name`（`model`）、`permissions`（`permission-mode`）、`project` / `project-root`（`project-name`）、`status`（`run-state`）、`thread-id` / `thread-title`（`session-id`）、`version`（`miro-version`）、`context-usage`（`context-used`）、`goal-status`（`goal`）。

## 许可证

ISC
