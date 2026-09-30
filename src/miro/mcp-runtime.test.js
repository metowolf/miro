import assert from "node:assert/strict";
import test from "node:test";
import { Validator } from "@cfworker/json-schema";
import { parseMcpServers } from "../mcp-config.js";
import { McpRuntime, normalizeMcpResult } from "./mcp-runtime.js";

const tools = [
  { name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
  { name: "other", description: "Another tool", inputSchema: { type: "object" } },
];

function fixture({ connect, list, call, config = {} } = {}) {
  const state = { loaded: 0, clients: [], transports: [], calls: [], pages: [] };
  class Transport {
    constructor(options) { this.options = options; state.transports.push(this); }
  }
  class Client {
    constructor(options) { this.closed = 0; this.options = options; this.notifications = new Map(); state.clients.push(this); }
    onNotification(method, handler) { this.notifications.set(method, handler); }
    onClose(handler) { this.closeHandler = handler; }
    async connect(transport, options) { this.transport = transport; if (connect) await connect(transport, options); }
    async close() { this.closed += 1; this.closeHandler?.(); }
    async listTools(options) {
      state.pages.push(options);
      return list ? list(options) : tools;
    }
    async callTool(name, args, options) {
      const params = { name, arguments: args };
      state.calls.push(params);
      return call ? call(params, options) : { content: [{ type: "text", text: params.arguments.value }] };
    }

  }
  const runtime = new McpRuntime({
    ...parseMcpServers({ local: { command: "node", ...config } }), cwd: "/work",
    clientLoader: async () => { state.loaded += 1; return { McpClient: Client, StdioTransport: Transport, StreamableHttpTransport: Transport, Validator }; },
  });
  return { runtime, state };
}

test("MCP lazily connects once, caches tools and validates before invocation", async () => {
  const { runtime, state } = fixture();
  try {
    assert.equal((await runtime.listTools()).servers[0].connected, false);
    assert.equal(state.loaded, 0);
    const found = await runtime.listTools({ server: "local" });
    assert.deepEqual(found.results[0].tools, tools);
    assert.equal(state.pages.length, 1);
    assert.equal(state.transports[0].options.cwd, "/work");
    assert.equal(state.transports[0].options.stderr, "pipe");
    await assert.rejects(runtime.callTool({ server: "local", name: "echo", arguments: { value: 1 } }), /Invalid MCP arguments/);
    await assert.rejects(runtime.callTool({ server: "local", name: "missing", arguments: {} }), /Unknown MCP tool/);
    assert.equal(state.calls.length, 0);
    const result = await runtime.callTool({ server: "local", name: "echo", arguments: { value: "ok" } });
    assert.deepEqual(result, { output: "ok", failed: false });
    assert.equal(state.loaded, 1);
    assert.equal(state.pages.length, 1);
    const filtered = await runtime.listTools({ query: "ECHO" });
    assert.deepEqual(filtered.results[0].tools, [tools[0]]);
  } finally { await runtime.close(); }
  await runtime.close();
  assert.equal(state.clients[0].closed, 1);
  await assert.rejects(runtime.listTools(), /closed/);
});

test("工具目录通知刷新发现结果并清除旧校验器", async () => {
  let catalog = tools;
  const { runtime, state } = fixture({ list: async () => catalog });
  try {
    assert.deepEqual((await runtime.listTools({ server: "local" })).results[0].tools.map((item) => item.name), ["echo", "other"]);
    await runtime.callTool({ server: "local", name: "echo", arguments: { value: "x" } });
    const entry = runtime.connections.get("local");
    assert.equal(entry.validators.size, 1);
    const generation = runtime.catalogGeneration;
    catalog = [tools[1]];
    state.clients[0].notifications.get("notifications/tools/list_changed")();
    assert.ok(runtime.catalogGeneration > generation);
    assert.equal(entry.validators.size, 0);
    assert.deepEqual((await runtime.listTools({ server: "local" })).results[0].tools.map((item) => item.name), ["other"]);
    await assert.rejects(runtime.callTool({ server: "local", name: "echo", arguments: { value: "x" } }), /Unknown MCP tool/);
  } finally { await runtime.close(); }
});

test("MCP result normalization retains errors and structured text but never embeds binary blocks", () => {
  const result = normalizeMcpResult({ isError: true, content: [
    { type: "text", text: "failure detail" },
    { type: "resource", resource: { text: "resource text" } },
    { type: "image", data: "secret-base64" },
    { type: "resource", resource: { blob: "secret-blob" } },
  ], structuredContent: { reason: "denied" } });
  assert.equal(result.failed, true);
  assert.match(result.output, /failure detail/);
  assert.match(result.output, /resource text/);
  assert.match(result.output, /denied/);
  assert.ok(!result.output.includes("secret"));
  assert.match(normalizeMcpResult({ isError: true }).output, /error/);
});

test("MCP cancellation reaches pi-mcp, closes the connection, and never retries a call", async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let requestSignal;
  const { runtime, state } = fixture({ call: (_params, options) => {
    requestSignal = options.signal;
    entered();
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const pending = runtime.callTool({ server: "local", name: "echo", arguments: { value: "x" } }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, /effects may already have occurred/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.clients[0].closed, 1);
  await runtime.close();
});

test("MCP timeout cleans up hung initialization and does not leak transport errors", async () => {
  const { runtime, state } = fixture({ config: { connectTimeoutMs: 20 }, connect: () => new Promise(() => {}) });
  const result = await runtime.listTools({ server: "local" });
  assert.match(result.results[0].error, /connection failed or timed out/);
  assert.equal(state.clients[0].closed, 1);
  await runtime.close();
  const rejected = fixture({ connect: async () => { throw new Error("secret-url-token"); } });
  const bad = await rejected.runtime.listTools({ server: "local" });
  assert.ok(!JSON.stringify(bad).includes("secret-url-token"));
  await rejected.runtime.close();
});

test("MCP request timeout aborts transport work without replay", async () => {
  let signal;
  const { runtime, state } = fixture({ config: { timeoutMs: 20 }, call: (_params, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(runtime.callTool({ server: "local", name: "echo", arguments: { value: "x" } }), /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.clients[0].closed, 1);
  await runtime.close();
});

test("MCP simultaneous requests share a connection and execute in order", async () => {
  const order = [];
  const { runtime, state } = fixture({ call: async (params) => {
    order.push(`start ${params.arguments.value}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end ${params.arguments.value}`);
    return { content: [] };
  } });
  await Promise.all(["a", "b"].map((value) => runtime.callTool({ server: "local", name: "echo", arguments: { value } })));
  assert.equal(state.loaded, 1);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
  await runtime.close();
});

test("MCP closing during client loading cannot spawn a late connection", async () => {
  let release;
  const loaded = new Promise((resolve) => { release = resolve; });
  const runtime = new McpRuntime({ ...parseMcpServers({ local: { command: "node" } }), clientLoader: () => loaded });
  const pending = runtime.listTools({ server: "local" });
  await Promise.resolve();
  await runtime.close();
  release({});
  await assert.rejects(pending, /closed/);
  assert.equal(runtime.connections.size, 0);
});

test("MCP does not invoke required-task tools", async () => {
  const { runtime, state } = fixture({ list: async () => [{ ...tools[0], execution: { taskSupport: "required" } }, tools[1]] });
  try {
    await assert.rejects(runtime.callTool({ server: "local", name: "echo", arguments: { value: "x" } }), /Task-based/);
    assert.equal(state.calls.length, 0);
  } finally { await runtime.close(); }
});

for (const phase of ["connect", "list"]) {
  test(`MCP 工具发现在 ${phase} 阶段取消会关闭连接且不重试`, async () => {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const { runtime, state } = fixture({ [phase]: () => {
      entered();
      return new Promise(() => {});
    } });
    const controller = new AbortController();
    const pending = runtime.listTools({ server: "local" }, { signal: controller.signal });
    try {
      await started;
      controller.abort(new Error("cancel discovery"));
      await assert.rejects(pending, /cancel discovery/);
      assert.equal(state.clients.length, 1);
      assert.equal(state.clients[0].closed, 1);
      assert.equal(runtime.connections.size, 0);
    } finally { await runtime.close(); }
  });
}
