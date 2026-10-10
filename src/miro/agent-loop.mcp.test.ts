import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServers } from "../mcp/mcp-config.ts";
import { permissionDecision, runAgentLoop } from "./agent-loop.ts";
import { MiroAgentClient } from "./agent-client.ts";
import { McpRuntime } from "../mcp/mcp-runtime.ts";
import { permissionScope } from "./permissions/permission-mode.ts";
import { createToolRunners, isConcurrencySafeCall } from "./tools/index.ts";

const config = { cwd: "/work", model: "test", protocol: "chat-completions", permissionMode: "auto", maxToolRounds: 2, contextWindow: 128_000, autoCompact: false };
const input = { server: "local", name: "echo", arguments: { value: "hello" } };
const call = { id: "mcp-1", name: "mcp_call", arguments: JSON.stringify(input) };

test("MCP manual grants are scoped to server, tool and exact arguments; auto does not review", () => {
  const scope = (rawInput) => permissionScope({ name: "mcp_call", kind: "execute", cwd: "/work", rawInput });
  assert.notEqual(scope(input), scope({ ...input, server: "other" }));
  assert.notEqual(scope(input), scope({ ...input, name: "other" }));
  assert.notEqual(scope(input), scope({ ...input, arguments: { value: "changed" } }));
  const decide = (mode) => permissionDecision({ item: { name: "mcp_call", kind: "execute", rawInput: input }, mode, cwd: "/work", alwaysAllowed: new Set<any>(), alwaysRejected: new Set<any>() });
  assert.equal(decide("manual").prompts, true);
  assert.equal(decide("auto").prompts, false);
  assert.equal(decide("auto").autoReview, false);
  assert.equal(isConcurrencySafeCall("mcp_call", input), false);
});

test("MCP 按需发现只提供两个工具，模型请求前不自动建连", async () => {
  let names;
  let loads = 0;
  const runtime = new McpRuntime({
    ...parseMcpServers({ local: { command: "never-start-this" } }),
    clientLoader: async () => { loads += 1; throw new Error("不应自动加载 MCP 客户端"); },
  });
  try {
    await runAgentLoop({ messages: [{ role: "user", content: "hello" }], config, handlers: {}, dependencies: {
      mcpRuntime: runtime,
      streamCompletion: async function* (request) {
        names = request.tools.map((tool) => tool.function.name).filter((name) => name.includes("mcp"));
        yield { type: "text", text: "ok" };
      },
    } });
    assert.deepEqual(names, ["mcp_list_tools", "mcp_call"]);
    assert.equal(loads, 0);
    assert.equal(runtime.connections.size, 0);
  } finally { await runtime.close(); }
});

test("MCP schemas are hidden without configured runtime and obey disabled tools and read-only execution", async () => {
  for (const [mcpRuntime, extra, expected] of [
    [null, {}, []],
    [{ enabled: true }, {}, ["mcp_list_tools", "mcp_call"]],
    [{ enabled: true }, { disabledTools: ["mcp_call"] }, ["mcp_list_tools"]],
    [{ enabled: true }, { readOnlyShell: true }, []],
  ]) {
    let names;
    await runAgentLoop({ messages: [{ role: "user", content: "hello" }], config: { ...config, ...extra }, handlers: {}, dependencies: {
      mcpRuntime,
      streamCompletion: async function* (request) { names = request.tools.map((tool) => tool.function.name).filter((name) => name.includes("mcp")); yield { type: "text", text: "ok" }; },
    } });
    assert.deepEqual(names, expected);
  }
  assert.equal(createToolRunners({ cwd: "/work", mcpRuntime: { enabled: false } }).mcp_call, undefined);
});

test("MCP uses normal approvals, failure events and one matching result", async () => {
  for (const approve of [true, false]) {
    const messages: Array<{ role: string; content: string; tool_call_id?: string }> = [{ role: "user", content: "do it" }];
    const events = [];
    let calls = 0;
    let round = 0;
    let approval;
    await runAgentLoop({ messages, config: { ...config, permissionMode: "manual" }, handlers: {
      onTool: (event) => events.push(event),
      requestPermission: async (params) => { approval = params; return approve ? "allow_once" : "reject_once"; },
    }, dependencies: {
      mcpRuntime: { enabled: true, callTool: async () => { calls += 1; return { output: "remote failure", failed: true }; } },
      streamCompletion: async function* () { if (round++ === 0) yield { type: "tool_calls", calls: [call] }; else yield { type: "text", text: "done" }; },
    } });
    assert.match(approval.toolCall.title, /local \/ echo/);
    assert.equal(calls, approve ? 1 : 0);
    const results = messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_call_id, "mcp-1");
    assert.match(results[0].content, approve ? /remote failure/ : /rejected/);
    assert.ok(events.some((event) => event.status === "failed"));
  }
});

test("MCP runtime is shared by normal and isolated turns and run waits for cleanup", async () => {
  let release;
  const cleanup = new Promise<any>((resolve) => { release = resolve; });
  let calls = 0;
  let closes = 0;
  let round = 0;
  const runtime = { enabled: true, diagnostics: [], callTool: async () => { calls += 1; return { output: "ok" }; }, close: () => { closes += 1; return cleanup; } };
  const client = new MiroAgentClient({ settings: { miro: { models: ["m1"], model: "m1" }, skills: false }, dependencies: {
    mcpRuntime: runtime, modelsFile: null, oauthModels: { getModels: () => [] },
    streamCompletion: async function* () { if (round++ % 2 === 0) yield { type: "tool_calls", calls: [call] }; else yield { type: "text", text: "done" }; },
  } });
  let finished = false;
  const running = client.run().then(() => { finished = true; });
  await new Promise<any>((resolve) => client.once("ready", resolve));
  await client.prompt("normal");
  await client.promptIsolated("isolated", { displayText: "/review" });
  assert.equal(calls, 2);
  assert.equal(client.loopDependencies().mcpRuntime, runtime);
  client.close();
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await running;
  assert.ok(closes >= 1);
});

test("取消 MCP 工具发现时保留配对结果，不发起下一轮模型请求", async () => {
  const controller = new AbortController();
  let requests = 0;
  const messages: Array<{ role: string; content: string; tool_call_id?: string }> = [{ role: "user", content: "hello" }];
  const discovery = { id: "mcp-list-1", name: "mcp_list_tools", arguments: JSON.stringify({ server: "local" }) };
  const runtime = { enabled: true,
    listTools: async (_input, { signal }: any) => {
      assert.equal(signal, controller.signal);
      controller.abort(new Error("cancel discovery"));
      signal.throwIfAborted();
    },
  };
  const result = await runAgentLoop({ messages, config, signal: controller.signal, handlers: {}, dependencies: {
    mcpRuntime: runtime,
    streamCompletion: async function* () { requests += 1; yield { type: "tool_calls", calls: [discovery] }; },
  } });
  assert.equal(result.cancelled, true);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(requests, 1);
  const results = messages.filter((message) => message.role === "tool");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, discovery.id);
  assert.match(results[0].content, /cancel discovery/);
});
