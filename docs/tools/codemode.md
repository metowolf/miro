# codemode

在独立 Worker 内的 QuickJS WASM 中执行 JavaScript，用一条模型调用完成工具组合、分页、过滤和聚合。
仅 miro provider 支持，默认关闭；原有工具仍然可用，不是 codemode-only 模式。

用 `/config codemode on` 开启，`/config codemode off` 关闭；配置保存在
`~/.miro/settings.json` 的 `miro.codemode.enabled`。顶层 `disableTools` 同样生效，
禁用 `codemode` 隐藏入口，禁用某个读取或 MCP 工具也会从脚本能力中移除它。

| 属性 | 值 |
| --- | --- |
| kind | `codemode` |
| UI 标题 | Codemode |
| 需要审批 | 入口不整段授权；内部实际 MCP 调用沿用普通审批 |
| 可并行 | 外层否；内部连续读取最多 8 条并行 |
| 可流式抢跑 | 否 |
| 实现 | `src/miro/tools/codemode*.ts`、`tool-execution.ts` |

## 参数与脚本 API

唯一参数是必填的 `code: string`，非空、最多 65 536 个 JS 字符，不接受额外字段。
它是 **async function body**，不是函数包装，也不是 TypeScript，可直接写 `await` 和 `return`：

```js
const found = await tools.glob({ pattern: "src/**/*.ts", limit: 20 });
const files = await Promise.all(found.data.paths.slice(0, 8).map(async (name) => {
  const file = await tools.read_file({ path: `${found.data.path}/${name}`, limit: 100 });
  return { path: name, lines: file.data.lineCount, more: file.data.nextOffset !== null };
}));
text(files);
```

当前能力集只包括 `read_file`、`grep`、`glob`，以及已装配的 `mcp_list_tools`、`mcp_call`。
精确的参数和结果声明随当前能力集附在 codemode 的描述中，不会为了生成声明连接 MCP。
没有写文件、Terminal、subagent、用户输入、目标更新或递归 codemode 入口。
派生工具白名单和只读宿主执行器的过滤不能通过脚本恢复。

脚本工具统一返回 `{ output: string, data: ... }`：`output` 是普通展示文本，`data` 是程序化结果。
读取/搜索的数据字段见各工具文档。不要解析带行号的 `output` 来还原对象。
普通工具失败、远端错误和审批拒绝会抛为脚本可 `catch` 的 Error；参数在宿主执行前按本地
JSON Schema 校验，MCP 还会校验远端 schema。

`text(value)`、`console.log(...)` 和 `return value` 选择进入模型历史的输出。
`ALL_TOOLS` 列出脚本工具；检查成员用 `"read_file" in tools`，直接访问缺失成员会报错。
pi 运行时的 `store` / `load` 仅在单次执行内有效，不保存 `storeWrites`，没有跨调用持久状态。
`image` 不提供多模态输出，返回中仅保留省略说明。

MCP 使用按需桥接而非每个远端工具各自注册方法：

```js
const catalog = await tools.mcp_list_tools({ server: "trusted" });
text(catalog.data); // 检查名称、inputSchema 和可选 outputSchema
```

拿到并核对远端 schema 后，可在脚本中 `await tools.mcp_call({server, name, arguments})`。
`data` 是远端 `structuredContent`，没有时为 `null`；不要假设远端一定返回对象。

## 审批、顺序与记录

Manual 逐次审批真实 `server + name + arguments`，与普通 MCP 调用共享精确会话许可。
所有 `mcp_call` 均为串行屏障，不信任远端只读提示：它先等在途读取结束，后面的读取
也不能越过它。Auto 沿用普通 MCP 策略，不询问、不使用 Terminal 审查。
非交互 Manual 拒绝内部 MCP 调用，在 stderr 和 JSON `permission_denials` 中记录真实内部 id。
发现工具依旧可能启动可信配置中的本地进程，MCP 不在 Terminal 沙箱内运行。

外层 codemode 不抢跑、不与其它外层调用并行。脚本必须 await 每条工具调用；
`Promise.all` 可以组合读取，但不要发起宿主调用后直接 `return` / `exit`。
执行结束、取消或超时时停止接收调用、拒绝排队任务、传递取消并等待实际宿主任务收尾。
等待收尾可能超过 VM 的时限，VM 终止不是宿主或远端事务回滚。

内部调用只发正常工具事件，不向模型历史写孤立的 `role: tool` 消息。
每个外层 codemode 仍有且只有一个对应结果。主 transcript 的活动行和工具组只展示内部实际工具，
外层 Codemode 包装行不显示，也不计入可见调用数或类别摘要；原始记录仍保留供回看使用。
transcript 保留内部状态、参数和有界结果预览，定稿记录保留 `toolCallId` / `parentToolCallId`，
可跟踪所属脚本，不增加专用 UI 布局。
嵌套审计正文保留最多 32 768 字符再附截断标记；完整中间结果不会自动进入模型上下文。
参数和结果仍属于会话数据，可能包含敏感内容。

## 预算与失败

| 预算 | 上限 |
| --- | --- |
| VM 执行时限（含工具等待和审批） | 60 秒 |
| QuickJS 堆 | 64 MiB |
| 调用次数（含非法或拒绝调用） | 64 |
| 连续读取并发 | 8 |
| 单个参数或成功结果 JSON 的 UTF-8 大小 | 1 MiB |
| 累计参数与成功结果 JSON | 8 MiB |
| 返回模型的总字符数（含诊断） | 32 768 |

调用数和数据预算超限会终止整次执行，不能用脚本 `catch` 绕过。
返回结果保留已产生的选定文本、错误与有界调用状态摘要；裁剪时为失败/取消说明预留空间。
pi 内部的 `text` / `console` / `image` 聚合另有 16 Mi 字符、100 000 项上限，
32 768 是结束后返回的上限，不是宿主进程的硬内存上限。64 MiB 只约束 VM 堆，不包括 WASM、
Worker、传输与宿主工具；工具结果在宿主生成后才检查数据预算。

VM 没有宿主 `process`、`require`、`fetch`、模块导入或计时器。
Worker 能终止纯脚本 CPU 或微任务死循环，但宿主 `grep` 的 RegExp 等仍使用原有执行器，
VM 时限不提供宿主 CPU 的硬隔离。工具结果与远端描述均为不可信数据。

失败脚本不自动重放。远端副作用可能已发生，取消/超时/未 await 的状态尤其不能说明
「没有执行」或「已撤销」。先核实结果，再决定是否使用更小的脚本或普通工具继续。
