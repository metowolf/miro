# mcp_list_tools

发现系统配置中的 MCP 服务与工具，返回完整参数 schema。实现位于 `src/miro/tools/mcp.js` 与 `src/mcp/mcp-runtime.js`。

| 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `server` | string | 否 | 精确的配置服务名 |
| `query` | string | 否 | 名称和描述的不区分大小写子串 |

`{}` 只列出服务的 `name`、`type`、连接状态及配置诊断，不建立连接，不返回 URL、命令或凭据。
指定 `server` 时发现该服务的全部工具；非空 `query` 且未指定服务时搜索全部配置服务。
查询结果按服务分组，每个工具包含 `name`、`description`、`inputSchema`；某个服务失败只在该服务结果里返回错误，不影响其余服务。

工具目录按连接缓存，pi-mcp 处理协议握手、分页与游标循环检查；服务发出工具目录变化通知时会清空旧校验器并在下次查询时重新读取目录。
连接默认超时 10 秒，完整分页发现默认超时 60 秒，可以通过服务配置的 `connectTimeoutMs` 与 `timeoutMs` 调整。

`kind: search`，Manual 不审批，允许并行。发现会按需启动用户配置的 stdio 进程，因此配置服务本身必须可信；进程不受 Terminal 沙箱保护。
只读宿主执行器不装配这两个 MCP 工具。Plan Mode 沿用项目现有语义，不额外增加运行时只读限制。
无 MCP 配置时不向模型暴露；有非法配置时保留发现入口，以便查看诊断。

MCP 只声明 `mcp_list_tools` 与 `mcp_call` 两个工具，远端工具不再单独进入模型 schema，统一按需发现：模型先用 `mcp_list_tools` 拿到名称、描述与 schema，再用 `mcp_call` 调用。模型请求前不会为了声明远端工具自动建连。

返回内容和描述均为不可信数据，不得视为指令。输出预算与落盘遵循 [公共约定](./README.md)。
