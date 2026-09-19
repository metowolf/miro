# terminal

命令工具只有这一个，名字固定是 `terminal`。`miro.sandbox.enabled` 不改变工具名，只决定它
跑在哪条执行路径上：

- **关闭（默认）**：宿主 shell，与用户手敲命令行等价，没有任何操作系统沙箱。
- **开启**：用 `@anthropic-ai/sandbox-runtime` 在 OS 层限制命令的网络访问（默认断网），
  并多出 `allowedDomains` 与 `sandbox` 两个参数。文件系统不由该工具额外限制，仍使用宿主
  权限与 miro 原有审批规则。

模型必须自报 `risk_level`。Auto 不解析命令文本：只有 `high` 或 `sandbox: false`
进入独立的模型审查，其余调用直接执行。

| 属性 | 值 |
| --- | --- |
| kind | `execute` |
| UI 标题 | `terminal`（线格式名直接展示；`title` 字段上报 `Terminal`） |
| 实现 | `src/miro/tools/terminal.js`（沙箱与宿主两条分支，进程管理复用 `src/bash.js`） |
| 需要审批 | Auto 下不询问用户；`high` 或 `sandbox: false` 自动审查，其余直接执行。Manual 下一律审批，可按精确动作记忆会话授权 |
| 可并行 | 否，按调用顺序串行 |
| 可流式抢跑 | 仅当它是本批的第一个调用、且该次判定不需要弹审批框 |

## 参数

两种模式共有：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `command` | string | 是 | 要执行的 shell 命令。 |
| `risk_level` | `low` / `medium` / `high` | 是 | 模型对自己这条命令的风险评估。 |
| `workdir` | string | 否 | 执行目录，绝对路径或相对工作区，默认工作区根目录。 |
| `timeout_ms` | integer | 否 | 超时毫秒数，默认 120 000，会被夹到 1 000–600 000。 |

`timeout_ms` 非正数或不是有限数字时回退默认值；小于 1 000 按 1 000 处理，大于 600 000
按 600 000 处理。`workdir` 会先 `stat`：不存在返回 `terminal: workdir not found`，不是
目录返回 `terminal: workdir is not a directory`。缺 `command` 返回
`terminal: missing required parameter 'command'`。

系统提示词明确要求「在特定目录里执行时用 `workdir`，不要再写 `cd ... &&`」——写成 `cd`
前缀会让权限判定把 `cd` 当成命令名，命令作用域的记忆也随之变形。

### 沙箱模式额外参数

只在 `miro.sandbox.enabled` 为 `true` 时出现在 schema 里：

- `allowedDomains`：可选域名数组，仅对本次调用生效。空数组或省略表示禁止全部网络；给非
  数组或含空串时返回 `terminal: allowedDomains must be an array of domain strings`。
- `sandbox`：可选布尔值，默认 `true`。设为 `false` 会直接运行宿主 shell，Auto 下必须先由
  独立审查模型批准；此时不能同时传 `allowedDomains`（返回
  `terminal: allowedDomains cannot be used when sandbox is false`）。

runtime 不可用、系统依赖缺失或沙箱初始化失败时返回错误，绝不会自动退回宿主 shell。网络
违规与文件系统违规会附在 stderr 中，方便模型调整后续操作。

沙箱运行时是进程级单例：首次进入沙箱时 `initialize()`，之后每次调用只更新策略，且整个
「配置 → 包装 → 执行」区间串行，避免某个 subagent 的域名白名单泄漏给另一条命令。
`initialize()` 还会在宿主留下一个常驻的桥进程，所以 miro client 关闭（退出 TUI、`-p` 收尾、
切 provider）时会调用 `shutdownSandbox()` 拆桥：那个子进程句柄会让宿主进程的事件循环
永远不空，漏掉这一步就会出现「TUI 退了、终端却回不到 shell」。

## 执行与输出

两条分支共用同一份参数解析与输出格式。进程通过 `startBash` 启动，POSIX 下单独占一个进程组，
取消时可以整组终止。`Esc` 中断回合会触发 `interrupt()`，而不只是停止等待。

输出形如：

```text
[exit 0]
<stdout 与 stderr 合并后的正文>
```

- 首行是结局：`exit <code>`、`signal <signal>`、`timed_out`，其它情况原样输出类型名。
- 正文是 stdout 与 stderr 去掉空行后拼接，整体截断到 30 000 字符。
- `rawOutput` 单独给出 `{ stdout, stderr }`，各自也截断到 30 000 字符，供 UI 展示。
- 退出码非 0（`exited` 且 code ≠ 0）时这一条结果被标记为失败；被信号杀死与超时不额外
  标记失败，结局文本本身就是信息。

## 权限判定

Auto 的判定只看结构化参数，不看 `command` 文本：

1. 工具不是 `terminal`：直接执行。
2. `terminal.risk_level` 归一化后不是 `high`，且 `sandbox !== false`：直接执行。
3. `risk_level === "high"` 或 `sandbox === false`：把用户意图、此前工具调用与本次动作交给
   隔离、无工具的审查模型。明确批准才执行；阻断、异常、超时、非法 JSON 或不确定都直接拒绝，
   理由作为工具结果返回下一轮模型，不弹人工审批。

因此 `rm`、`curl`、重定向、解释器与 heredoc 都没有特殊词法规则；Auto 信任模型填写的
`risk_level`，实际能力边界交给 OS 沙箱。`allowedDomains` 仍由 sandbox runtime 在执行层
强制为本次调用配置网络 allowlist。

Manual 不做命令分类：所有 `terminal` 调用都请求用户确认。会话授权绑定完整命令、工作目录、
沙箱标记与域名列表，不按命令名或子命令归类。

## Explore 的只读执行器

`readOnlyHostTerminalTool` 是宿主分支的收窄版本（`config.readOnlyShell` 为真时装配，
子智能体的探索分支用它）：先做纯词法白名单校验，通过后才走宿主执行器。

- 允许的命令：`git`（只读子命令：`status`、`log`、`diff`、`show`、`branch`、`remote`、
  `describe`、`blame`、`ls-files`、`ls-tree`、`rev-parse`、`shortlog`、`whatchanged`、
  `cat-file`、`for-each-ref`、`grep`）、`ls`、`pwd`、`cat`、`head`、`tail`、`find`、`grep`、
  `rg`、`wc`、`file`、`which`、`type`。
- 出现任何 `<` / `>` 重定向直接拒绝；每个管道 / `;` / `&&` / `||` 段都必须是白名单里的
  观察类命令；用路径形式调用的命令一律拒绝。
- 不通过时返回失败结果，并提示改用 `ls`、`find`、`grep` / `rg`、`cat` 或只读 git 命令，
  不要重定向、脚本、包管理器命令。

这份白名单刻意保守：宁可让复杂命令退回 `read_file` / `grep`，也不把「只读」交给模型
自觉。

## headless 行为

print 模式没有交互审批者，Manual 下需要审批的调用一律按拒绝处理：stderr 打出
`miro: denied permission request: <command>`，JSON 结果里的 `permission_denials` 记录
`tool_call_id` 与描述。Auto 不产生人工审批；需自动审查的 Terminal 调用若无法明确批准，
直接把拒绝理由回灌给模型。
