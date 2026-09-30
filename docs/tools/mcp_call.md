# mcp_call

调用已配置 MCP 服务中的工具。先用 `mcp_list_tools` 检查远端参数 schema，再提供调用参数。
实现位于 `src/miro/tools/mcp.js` 与 `src/miro/mcp-runtime.js`。

| 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `server` | string | 是 | 精确的配置服务名 |
| `name` | string | 是 | 精确的远端工具名 |
| `arguments` | object | 是 | 符合远端 inputSchema 的参数，无参数时传 `{}` |

调用前会检查工具存在性并编译、校验 inputSchema；不合法的参数不会发到服务。
连接和工具目录与发现入口共用，跨普通、隔离和子 agent 回合复用，会话关闭时等待连接释放。

`kind: execute`，调用严格串行；Manual 每次实际调用都需审批，不信任远端 `readOnlyHint`。
会话授权绑定 `server + name + arguments`，不同参数不能复用许可。headless Manual 因没有审批者而拒绝实际调用。
审批界面以可滚动的 JSON 展示完整参数，不把远端的 `content`、`patch`、`plan` 等字段当成本地文件编辑或计划正文。
Auto 无审批、无 Terminal 自动审查；MCP 服务不在 Terminal 沙箱中运行。

文本、嵌入的文本资源和结构化 JSON 转成 `output`，`isError` 映射为 `failed: true`，失败正文仍回灌模型。
资源链接只返回链接元数据，不自动读取。图片、音频及二进制资源不直接写入历史，而以不支持提示替代。
工具参数和文本结果仍可能含敏感数据，会按普通工具的会话规则保存。

请求默认超时 60 秒；Esc 和会话关闭会传递取消，并关闭本地 transport。
取消、超时和连接丢失时，远端副作用可能已发生，不能宣称操作没有执行或已撤销；必须核实结果后才能决定是否再次调用。
runtime 不自动重放调用，只允许后续操作建立新的连接。
OAuth 可通过 `miro mcp login` 或 `/mcp` 登录。MCP 仅提供 `mcp_list_tools` 与 `mcp_call` 两个工具，不支持资源列举、URI 模板、资源读取、Prompts 和任务型执行；工具返回的资源链接不能通过资源读取入口继续获取正文。

大结果处理、事件和一一配对的历史回填遵循 [公共约定](./README.md)。