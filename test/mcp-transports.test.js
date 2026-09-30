import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseMcpServers } from "../src/mcp-config.js";
import { McpRuntime } from "../src/miro/mcp-runtime.js";
import { respondMcp } from "./fixtures/mcp-server.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.js", import.meta.url));

test("real stdio MCP connects, invokes, reuses the child, and closes it", async () => {
  const runtime = new McpRuntime({ ...parseMcpServers({ local: { command: process.execPath, args: [fixture] } }) });
  let pid;
  try {
    const catalog = await runtime.listTools({ server: "local" });
    assert.equal(catalog.results[0].tools?.[0].name, "echo", JSON.stringify(catalog));
    assert.deepEqual(catalog.results[0].tools.map((tool) => tool.name), ["echo", "other"]);
    pid = runtime.connections.get("local").transport.pid;
    for (const value of ["first", "second"]) {
      const result = await runtime.callTool({ server: "local", name: "echo", arguments: { value } });
      assert.equal(result.output, `${value}\n\n${JSON.stringify({ value }, null, 2)}`);
      assert.equal(runtime.connections.get("local").transport.pid, pid);
    }
  } finally { await runtime.close(); }
  assert.equal(runtime.connections.size, 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("real Streamable HTTP MCP negotiates a session and passes configured headers", async () => {
  const sessionId = crypto.randomUUID();
  const methods = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    assert.equal(request.headers.get("authorization"), "Bearer test-only");
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const message = await request.json();
    methods.push(message.method);
    if (message.method !== "initialize") assert.equal(request.headers.get("mcp-session-id"), sessionId);
    const response = respondMcp(message);
    return response ? Response.json(response, { headers: { "mcp-session-id": sessionId } }) : new Response(null, { status: 202 });
  } });
  const runtime = new McpRuntime({ ...parseMcpServers({ remote: { url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: "Bearer test-only" } } }) });
  try {
    const result = await runtime.callTool({ server: "remote", name: "echo", arguments: { value: "HTTP works" } });
    assert.equal(result.output, `HTTP works\n\n${JSON.stringify({ value: "HTTP works" }, null, 2)}`);
    assert.equal(methods.filter((method) => method === "tools/list").length, 2);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("tools/list"));
    assert.ok(methods.includes("tools/call"));
    assert.equal(methods.filter((method) => method === "tools/call").length, 1);
  } finally {
    await runtime.close();
    await http.stop(true);
  }
});

test("real HTTP MCP accepts SSE responses and validates output from an earlier tool page", async () => {
  let calls = 0;
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response(null, { status: 405 });
    const message = await request.json();
    const response = respondMcp(message);
    if (!response) return new Response(null, { status: 202 });
    if (message.method === "tools/call") {
      calls += 1;
      response.result.structuredContent.value = 42;
    }
    return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const runtime = new McpRuntime({ ...parseMcpServers({ remote: { url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: "test" } } }) });
  try {
    await assert.rejects(runtime.callTool({ server: "remote", name: "echo", arguments: { value: 42 } }), /Invalid MCP arguments/);
    assert.equal(calls, 0);
    await assert.rejects(runtime.callTool({ server: "remote", name: "echo", arguments: { value: "valid" } }), /invalid structured output/);
    assert.equal(calls, 1);
  } finally {
    await runtime.close();
    await http.stop(true);
  }
});

test("real HTTP MCP enforces initialization and request deadlines without replay", async () => {
  for (const hungMethod of ["initialize", "tools/call"]) {
    let calls = 0;
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json();
      if (message.method === "tools/call") calls += 1;
      if (message.method === hungMethod) return new Promise(() => {});
      const response = respondMcp(message);
      return response ? Response.json(response) : new Response(null, { status: 202 });
    } });
    const runtime = new McpRuntime({ ...parseMcpServers({ remote: {
      url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: "test" }, connectTimeoutMs: 100, timeoutMs: 100,
    } }) });
    try {
      await assert.rejects(runtime.callTool({ server: "remote", name: "echo", arguments: { value: "x" } }), /timed out/);
      assert.equal(calls, hungMethod === "tools/call" ? 1 : 0);
      assert.equal(runtime.connections.size, 0);
    } finally {
      await runtime.close();
      await http.stop(true);
    }
  }
});
