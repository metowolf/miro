import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "./agent-loop.ts";
import { createToolRunners, isConcurrencySafeCall, isStreamingEagerCall } from "./tools/index.ts";
import { CODEMODE_LIMITS, runCodemode } from "./tools/codemode-runtime.ts";

const config = { cwd: "/work", model: "test", protocol: "chat-completions", permissionMode: "auto", maxToolRounds: 2, contextWindow: 128_000, autoCompact: false, codemodeEnabled: true };
const call = (code) => ({ id: "code-1", name: "codemode", arguments: JSON.stringify({ code }) });

async function execute(code, extra: any = {}, dependencies: any = {}, handlers: any = {}) {
  const messages: any[] = [{ role: "user", content: "compose tools" }];
  const events = [];
  let round = 0;
  const result = await runAgentLoop({ messages, config: { ...config, ...extra }, signal: dependencies.signal, handlers: {
    onTool: (event) => events.push(event), ...handlers,
  }, dependencies: { ...dependencies,
    streamCompletion: async function* () {
      if (round++ === 0) yield { type: "tool_calls", calls: [call(code)] };
      else yield { type: "text", text: "done" };
    },
  } });
  return { messages, events, result, requests: round };
}

test("codemode 默认关闭，不抢跑、不参与外层并行，也不提前连接 MCP", async () => {
  assert.equal(createToolRunners({ cwd: "/work" }).codemode, undefined);
  assert.equal(isConcurrencySafeCall("codemode", { code: "return 1" }), false);
  assert.equal(isStreamingEagerCall("codemode", { code: "return 1" }), false);
  for (const extra of [{ codemodeEnabled: false }]) {
    let schemas;
    await runAgentLoop({ messages: [], config: { ...config, ...extra }, handlers: {}, dependencies: {
      streamCompletion: async function* (request) { schemas = request.tools; yield { type: "text", text: "ok" }; },
    } });
    assert.ok(!schemas.some((entry) => entry.function.name === "codemode"));
  }
  let schema;
  let connected = false;
  await runAgentLoop({ messages: [], config, handlers: {}, dependencies: {
    mcpRuntime: { enabled: true, listTools: () => { connected = true; throw new Error("不应发现"); } },
    streamCompletion: async function* (request) { schema = request.tools.find((entry) => entry.function.name === "codemode"); yield { type: "text", text: "ok" }; },
  } });
  assert.match(schema.function.description, /mcp_call/);
  assert.match(schema.function.description, /nextOffset/);
  assert.equal(connected, false);
});

test("codemode 内部调用有父子审计而模型历史只有外层一条配对", async () => {
  const { messages, events } = await execute('const r = await tools.read_file({path:"a"}); return r.data.value', {}, {
    toolRunnerOverrides: { read_file: async () => ({ output: "不要回灌这段中间原文", structuredContent: { value: 42 } }) },
  });
  assert.deepEqual(messages.filter((entry) => entry.role === "tool").map((entry) => entry.tool_call_id), ["code-1"]);
  assert.match(messages.find((entry) => entry.role === "tool").content, /^42/);
  assert.doesNotMatch(messages.find((entry) => entry.role === "tool").content, /中间原文/);
  const nested = events.filter((event) => event.parentToolCallId === "code-1");
  assert.deepEqual(nested.map((event) => event.status), ["pending", "in_progress", "completed"]);
  assert.ok(nested.every((event) => event.toolCallId === "code-1/nested-1"));
});

test("codemode 遵守派生白名单与只读执行器，不能恢复 MCP", async () => {
  for (const [extra, absent] of [
    [{ tools: ["codemode", "grep"] }, "read_file"],
    [{ readOnlyShell: true }, "mcp_call"],
  ] as const) {
    const { messages, events } = await execute(`return ${JSON.stringify(absent)} in tools`, extra, { mcpRuntime: { enabled: true } });
    assert.match(messages.find((entry) => entry.role === "tool").content, /^false/);
    assert.ok(!events.some((event) => event.parentToolCallId));
  }
});

test("codemode 每次 MCP 按真实参数审批且与普通调用共享精确会话许可", async () => {
  const approvals = [];
  const seen = [];
  const { messages, events } = await execute('for(const value of ["one","one","two"]){await tools.mcp_call({server:"local",name:"echo",arguments:{value}})}', { permissionMode: "manual" }, {
    mcpRuntime: { enabled: true, callTool: async (input) => { seen.push(input.arguments.value); return { output: "ok" }; } },
  }, { requestPermission: async (params) => { approvals.push(params); return "allow_session"; } });
  assert.deepEqual(seen, ["one", "one", "two"]);
  assert.deepEqual(approvals.map((entry) => entry.toolCall.rawInput.arguments.value), ["one", "two"]);
  assert.ok(approvals.every((entry) => entry.signal instanceof AbortSignal));
  assert.ok(events.filter((entry) => entry.parentToolCallId).every((entry) => entry.title === "MCP local / echo"));
  assert.equal(messages.filter((entry) => entry.role === "tool").length, 1);
});

test("codemode Manual 无审批者时拒绝实际 MCP 调用，部分输出与拒绝保留", async () => {
  let ran = false;
  const { messages, events } = await execute('text("before"); await tools.mcp_call({server:"local",name:"echo",arguments:{}})', { permissionMode: "manual", interactive: false }, {
    mcpRuntime: { enabled: true, callTool: async () => { ran = true; return { output: "ok" }; } },
  });
  assert.equal(ran, false);
  const result = messages.find((entry) => entry.role === "tool");
  assert.match(result.content, /before/);
  assert.match(result.content, /cancelled/);
  assert.ok(events.some((entry) => entry.parentToolCallId && entry.status === "cancelled"));
});

test("codemode 取消无响应审批时收尾并保留外层配对，不请求下一轮", async () => {
  const controller = new AbortController();
  let releasedSignal;
  const { result, messages, requests } = await execute('await tools.mcp_call({server:"local",name:"echo",arguments:{}})', { permissionMode: "manual" }, {
    signal: controller.signal, mcpRuntime: { enabled: true },
  }, { requestPermission: (params) => { releasedSignal = params.signal; controller.abort(new Error("cancel approval")); return new Promise(() => {}); } });
  assert.equal(releasedSignal.aborted, true);
  assert.equal(result.cancelled, true);
  assert.equal(requests, 1);
  const results = messages.filter((entry) => entry.role === "tool");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, "code-1");
  assert.match(results[0].content, /verify/);
});

test("codemode 超时释放内部审批 signal，即使审批者不响应", async () => {
  let approvalSignal;
  const { messages } = await execute('await tools.mcp_call({server:"local",name:"echo",arguments:{}})', { permissionMode: "manual" }, {
    mcpRuntime: { enabled: true },
    toolRunnerOverrides: { codemode: (input, context) => runCodemode(input, context, context.codemodeDefinitions, { ...CODEMODE_LIMITS, timeoutMs: 150 }) },
  }, { requestPermission: (params) => { approvalSignal = params.signal; return new Promise(() => {}); } });
  assert.equal(approvalSignal.aborted, true);
  assert.match(messages.find((entry) => entry.role === "tool").content, /timed out/);
});

test("普通与嵌套 MCP 调用双向共享许可，不放行不同参数", async () => {
  const allowed = new Set<any>();
  const approvals = [];
  const executions = [];
  for (const nested of [false, true, true, false]) {
    const value = executions.length < 2 ? "one" : "two";
    let round = 0;
    await runAgentLoop({ messages: [{ role: "user", content: "echo" }], config: { ...config, permissionMode: "manual" },
      handlers: { alwaysAllowed: allowed, requestPermission: async (params) => { approvals.push(params.toolCall.rawInput.arguments.value); return "allow_session"; } },
      dependencies: {
        mcpRuntime: { enabled: true, callTool: async (input) => { executions.push(input.arguments.value); return { output: "ok" }; } },
        streamCompletion: async function* () {
          if (round++ === 0) yield { type: "tool_calls", calls: [nested
            ? call(`await tools.mcp_call({server:"local",name:"echo",arguments:{value:${JSON.stringify(value)}}})`)
            : { id: "ordinary", name: "mcp_call", arguments: JSON.stringify({ server: "local", name: "echo", arguments: { value } }) }] };
          else yield { type: "text", text: "done" };
        },
      },
    });
  }
  assert.deepEqual(executions, ["one", "one", "two", "two"]);
  assert.deepEqual(approvals, ["one", "two"]);
});
