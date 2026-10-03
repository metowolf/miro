import { APP_NAME, APP_VERSION } from "../config/config.js";
import { McpOAuthProvider, mcpOAuthFetch } from "./mcp-oauth.js";

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);

/** 协议客户端和校验器按需加载，不进入无 MCP 会话的启动路径。 */
async function loadClient() {
  const [client, oauth, validation] = await Promise.all([
    import("@earendil-works/pi-mcp"),
    import("@earendil-works/pi-mcp/oauth"),
    import("@cfworker/json-schema"),
  ]);
  return { ...client, adaptOAuthProvider: oauth.adaptOAuthProvider, Validator: validation.Validator };
}

/** 整个操作的硬截止时间，覆盖 HTTP 建连阶段而不仅是 JSON-RPC request。 */
async function withDeadline(timeoutMs, signals, action) {
  const timeout = new AbortController();
  const signal = AbortSignal.any([...signals.filter(Boolean), timeout.signal]);
  signal.throwIfAborted();
  const timer = setTimeout(() => timeout.abort(new Error("MCP operation timed out")), timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => action(signal)), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** 不把媒体的 base64 或未知块直接写进模型历史和会话日志。 */
export function normalizeMcpResult(result) {
  const parts = [];
  for (const block of result?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && typeof block.resource?.text === "string") parts.push(block.resource.text);
    else if (block.type === "resource_link") parts.push(JSON.stringify({ type: block.type, name: block.name, uri: block.uri, mimeType: block.mimeType }));
    else parts.push(`[MCP ${block.type ?? "unknown"} content omitted: non-text content is not supported]`);
  }
  if (result?.structuredContent != null) parts.push(JSON.stringify(result.structuredContent, null, 2));
  if (parts.length === 0) parts.push(result?.isError ? "MCP tool reported an error." : "MCP tool completed with no text output.");
  return { output: parts.join("\n\n"), failed: result?.isError === true };
}

/** 一份 runtime 属于一个会话；主/隔离/子回合共享连接，不自动重放失败的调用。 */
export class McpRuntime {
  constructor({ servers = [], configured = [], diagnostics = [], cwd = process.cwd(), clientLoader = loadClient } = {}) {
    this.servers = new Map(servers.map((server) => [server.name, server]));
    this.configured = configured;
    this.diagnostics = diagnostics;
    this.cwd = cwd;
    this.clientLoader = clientLoader;
    this.connections = new Map();
    this.queues = new Map();
    this.closing = new Set();
    this.lifetime = new AbortController();
    this.closed = false;
    this.onChanged = null;
    this.catalogGeneration = 0;
  }

  get enabled() { return this.servers.size > 0 || this.diagnostics.length > 0; }

  checkSignal(signal) {
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
  }

  /** 每个服务按调用顺序串行，目录加载也共用队列，避免重复建连。 */
  async withServer(name, signal, action) {
    this.checkSignal(signal);
    const config = this.servers.get(name);
    if (!config) throw new Error("Unknown MCP server; use mcp_list_tools to inspect configured names.");
    const previous = this.queues.get(name) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      this.checkSignal(signal);
      const entry = await this.connect(config, signal);
      this.checkSignal(signal);
      return action(entry, config);
    });
    this.queues.set(name, task);
    try { return await task; }
    finally { if (this.queues.get(name) === task) this.queues.delete(name); }
  }

  async connect(config, signal) {
    const cached = this.connections.get(config.name);
    if (cached?.connected) return cached;
    let entry;
    try {
      return await withDeadline(config.connectTimeoutMs, [signal, this.lifetime.signal], async (connectSignal) => {
        const { McpClient, StdioTransport, StreamableHttpTransport, adaptOAuthProvider, Validator } = await this.clientLoader();
        connectSignal.throwIfAborted();
        const transport = config.type === "stdio"
          ? new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: this.cwd, stderr: "pipe" })
          : new StreamableHttpTransport({
            url: config.url, headers: config.headers,
            ...(Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization") ? {}
              : { authProvider: this.oauthProvider(config, adaptOAuthProvider) }),
          });
        // pi-mcp 排空并限量保留 stderr；不转发服务日志，保持输出干净且不泄漏凭据。
        const client = new McpClient({ name: APP_NAME, version: APP_VERSION,
          capabilities: {}, requestTimeoutMs: config.connectTimeoutMs });
        entry = { client, transport, Validator, connected: false, tools: null, validators: new Map(), outputValidators: new Map() };
        client.onNotification("notifications/tools/list_changed", () => {
          if (!entry.connected) return;
          entry.tools = null;
          entry.validators.clear();
          entry.outputValidators.clear();
          this.catalogGeneration += 1;
          this.onChanged?.(config.name);
        });
        // 初始化失败和 runtime 收尾共用同一份拆除承诺。
        const close = client.close.bind(client);
        client.close = () => entry.closePromise ??= close();
        client.onClose(() => {
          entry.connected = false;
          if (this.connections.get(config.name) === entry) this.connections.delete(config.name);
          this.catalogGeneration += 1;
          this.onChanged?.(config.name);
        });
        this.connections.set(config.name, entry);
        await client.connect(transport);
        connectSignal.throwIfAborted();
        entry.connected = true;
        return entry;
      });
    } catch {
      if (entry) await this.dispose(config.name, entry);
      this.checkSignal(signal);
      throw new Error("MCP connection failed or timed out. Check command/URL, authentication and server availability; raw transport details are omitted to protect credentials.");
    }
  }

  oauthProvider(config, adaptOAuthProvider) {
    const provider = new McpOAuthProvider(config, { signal: this.lifetime.signal });
    const adapted = adaptOAuthProvider(provider);
    return { ...adapted, onUnauthorized: (context) => adapted.onUnauthorized({
      ...context, fetch: mcpOAuthFetch(provider, context.fetch),
    }) };
  }

  async dispose(name, entry) {
    if (this.connections.get(name) === entry) this.connections.delete(name);
    const closing = entry.client.close().catch(() => {});
    this.closing.add(closing);
    try { await closing; }
    finally { this.closing.delete(closing); }
  }

  async request(entry, config, signal, action) {
    try {
      return await withDeadline(config.timeoutMs, [signal, this.lifetime.signal], (requestSignal) =>
        action({ signal: requestSignal, timeoutMs: config.timeoutMs }));
    } catch {
      // 关闭本地 transport，确保取消 HTTP 请求；下次操作可以新建连接，但本次绝不重试。
      await this.dispose(config.name, entry);
      throw new Error("MCP request failed, was cancelled, or timed out. Remote effects may already have occurred; verify the outcome before retrying. Raw transport details are omitted to protect credentials.");
    }
  }

  async catalog(entry, config, signal) {
    if (entry.tools) return entry.tools;
    const generation = this.catalogGeneration;
    // pi-mcp 负责全部分页和重复游标检查；外层 deadline 覆盖整次目录读取。
    const tools = await this.request(entry, config, signal, (options) => entry.client.listTools(options));
    if (generation === this.catalogGeneration) entry.tools = tools;
    return tools;
  }

  async listTools(input = {}, { signal } = {}) {
    this.checkSignal(signal);
    if (!isObject(input) || (input.server != null && typeof input.server !== "string") ||
        (input.query != null && typeof input.query !== "string")) throw new Error("mcp_list_tools expects optional string server/query parameters.");
    if (input.server == null && !input.query) {
      return {
        servers: [...this.servers.values()].map(({ name, type }) => ({ name, type, connected: this.connections.get(name)?.connected === true })),
        diagnostics: this.diagnostics,
      };
    }
    const names = input.server != null ? [input.server] : [...this.servers.keys()];
    const query = (input.query ?? "").toLowerCase();
    const results = await Promise.all(names.map(async (server) => {
      try {
        return await this.withServer(server, signal, async (entry, config) => {
          const tools = await this.catalog(entry, config, signal);
          return { server, tools: tools.filter((tool) => `${tool.name}\n${tool.description ?? ""}`.toLowerCase().includes(query))
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        });
      } catch (error) {
        this.checkSignal(signal);
        return { server, error: error.message };
      }
    }));
    return { results, diagnostics: this.diagnostics };
  }

  async callTool(input, { signal } = {}) {
    if (!isObject(input) || typeof input.server !== "string" || !input.server || typeof input.name !== "string" ||
        !input.name || !isObject(input.arguments)) throw new Error("mcp_call requires server, name, and an arguments object.");
    return this.withServer(input.server, signal, async (entry, config) => {
      const tools = await this.catalog(entry, config, signal);
      const tool = tools.find((tool) => tool.name === input.name);
      if (!tool) throw new Error("Unknown MCP tool; inspect mcp_list_tools before calling.");
      if (tool.execution?.taskSupport === "required") throw new Error("Task-based MCP tools are not supported.");
      if (!entry.validators.has(tool.name)) {
        try {
          // 每份 schema 独立编译，支持 MCP 默认的 2020-12 方言，不共享 $id。
          entry.validators.set(tool.name, new entry.Validator(tool.inputSchema, "2020-12", true));
          if (tool.outputSchema) entry.outputValidators.set(tool.name, new entry.Validator(tool.outputSchema, "2020-12", true));
        } catch {
          entry.validators.delete(tool.name);
          throw new Error("MCP tool schema cannot be validated; invocation blocked.");
        }
      }
      const validation = entry.validators.get(tool.name).validate(input.arguments);
      if (!validation.valid) throw new Error(`Invalid MCP arguments: ${validation.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join("; ")}`);
      // 调用期间目录可能变化，仍按本次调用的 schema 校验返回值。
      const outputValidator = entry.outputValidators.get(tool.name);
      const result = await this.request(entry, config, signal, (options) =>
        entry.client.callTool(input.name, input.arguments, options));
      if (outputValidator && !result.isError && (result.structuredContent == null || !outputValidator.validate(result.structuredContent).valid)) {
        throw new Error("MCP tool returned invalid structured output. Remote effects may have occurred; do not repeat the call blindly.");
      }
      return normalizeMcpResult(result);
    });
  }

  async reconnect(name, { signal } = {}) {
    this.checkSignal(signal);
    const entry = this.connections.get(name);
    if (entry) await this.dispose(name, entry);
    return this.listTools({ server: name }, { signal });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.lifetime.abort(new Error("MCP session closed"));
    const disposals = [...this.connections].map(([name, entry]) => this.dispose(name, entry));
    this.closePromise = Promise.allSettled([...disposals, ...this.closing, ...this.queues.values()]).then(() => {});
    return this.closePromise;
  }
}
