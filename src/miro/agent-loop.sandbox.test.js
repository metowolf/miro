import assert from "node:assert/strict";
import test from "node:test";

import { permissionDecision, requiresAutoReview, runAgentLoop } from "./agent-loop.js";
import { activeToolDefinitions, toolDefinition, toolSchemas } from "./tools/index.js";

/** 取当前模式下命令工具的参数 schema。 */
function commandParameters(sandboxEnabled) {
  const schema = toolSchemas(sandboxEnabled).find((entry) => entry.function.name === "terminal");
  return schema.function.parameters;
}

/** 取当前模式下命令工具的参数名集合。 */
function commandParameterNames(sandboxEnabled) {
  return Object.keys(commandParameters(sandboxEnabled).properties);
}

test("the command tool is called terminal in both modes, and only its parameters differ", () => {
  for (const sandboxEnabled of [false, true]) {
    const names = activeToolDefinitions(sandboxEnabled).map((definition) => definition.name);
    assert.ok(names.includes("terminal"));
    assert.ok(!names.includes("run_command"));
    assert.equal(toolDefinition("terminal").kind, "execute");
    assert.equal(toolDefinition("run_command"), null);
  }

  // 非沙箱：就是宿主 shell，没有沙箱参数可传。
  assert.deepEqual(commandParameterNames(false), ["command", "risk_level", "workdir", "timeout_ms"]);
  assert.deepEqual(commandParameterNames(true), [
    "command",
    "risk_level",
    "workdir",
    "timeout_ms",
    "allowedDomains",
    "sandbox",
  ]);
  // 必填项两种模式一致：沙箱只是多出可选的网络与沙箱参数。
  assert.deepEqual(commandParameters(false).required, ["command", "risk_level"]);
  assert.deepEqual(commandParameters(true).required, ["command", "risk_level"]);
});

test("Auto review is limited to high-risk and sandbox-opt-out terminal calls", () => {
  assert.equal(requiresAutoReview({ name: "terminal", rawInput: { command: "anything", risk_level: "high" } }), true);
  assert.equal(requiresAutoReview({ name: "terminal", rawInput: { command: "anything", risk_level: "medium" } }), false);
  assert.equal(requiresAutoReview({ name: "terminal", rawInput: { sandbox: false, risk_level: "low" } }), true);
  assert.equal(requiresAutoReview({ name: "read_file", rawInput: { sandbox: false, risk_level: "high" } }), false);
});

test("Auto never prompts and ignores command text", () => {
  const cwd = "/workspace";
  const decide = (rawInput) => permissionDecision({
    item: { name: "terminal", kind: "execute", rawInput },
    mode: "auto",
    cwd,
    alwaysAllowed: new Set(),
    alwaysRejected: new Set(),
  });
  for (const command of ["rm -rf /", "curl https://example.com", "python <<'EOF'\nprint('x')\nEOF"]) {
    const decision = decide({ command, risk_level: "medium" });
    assert.equal(decision.prompts, false, command);
    assert.equal(decision.autoReview, false, command);
  }
  const edit = permissionDecision({
    item: { name: "write_file", kind: "edit", rawInput: { path: "/tmp/outside.txt", content: "x" } },
    mode: "auto",
    cwd,
    alwaysAllowed: new Set(),
    alwaysRejected: new Set(),
  });
  assert.equal(edit.prompts, false);
  assert.equal(edit.autoReview, false);
});

test("Manual still prompts for side-effecting tools and supports exact session grants", () => {
  const item = { name: "terminal", kind: "execute", rawInput: { command: "pwd", risk_level: "low" } };
  const first = permissionDecision({
    item,
    mode: "manual",
    cwd: "/workspace",
    alwaysAllowed: new Set(),
    alwaysRejected: new Set(),
  });
  assert.equal(first.prompts, true);
  assert.equal(first.autoReview, false);
  assert.equal(permissionDecision({
    item,
    mode: "manual",
    cwd: "/workspace",
    alwaysAllowed: new Set([first.scope]),
    alwaysRejected: new Set(),
  }).prompts, false);
});

test("Plan mode keeps normal tools while headless removes interactive lifecycle tools", async () => {
  const seen = [];
  const streamCompletion = async function* (request) {
    seen.push(request.tools.map((schema) => schema.function.name));
    yield { type: "text", text: "planned" };
  };
  const base = {
    cwd: "/workspace",
    model: "test-model",
    protocol: "chat-completions",
    permissionMode: "auto",
    interactionMode: "plan",
    plan: { id: "p1", path: "/tmp/p1.md" },
    maxToolRounds: 1,
    contextWindow: 128_000,
    autoCompact: false,
  };

  await runAgentLoop({ messages: [{ role: "user", content: "plan" }], config: base, handlers: {}, dependencies: { streamCompletion } });
  assert.ok(seen[0].includes("request_user_input"));
  assert.ok(seen[0].includes("exit_plan_mode"));
  assert.ok(seen[0].includes("update_tasks"));
  assert.ok(seen[0].includes("write_file"));
  assert.ok(seen[0].includes("terminal"));
  for (const forbidden of ["enter_plan_mode", "update_goal", "set_goal_budget"]) {
    assert.ok(!seen[0].includes(forbidden));
  }

  await runAgentLoop({
    messages: [{ role: "user", content: "plan" }],
    config: { ...base, interactive: false },
    handlers: {},
    dependencies: { streamCompletion },
  });
  assert.ok(!seen[1].includes("request_user_input"));
  assert.ok(!seen[1].includes("exit_plan_mode"));
});

test("request_user_input is available in interactive Default mode but never headless", async () => {
  const seen = [];
  const streamCompletion = async function* (request) {
    seen.push(request.tools.map((schema) => schema.function.name));
    yield { type: "text", text: "done" };
  };
  const base = {
    cwd: "/workspace",
    model: "test-model",
    protocol: "chat-completions",
    permissionMode: "auto",
    interactionMode: "default",
    maxToolRounds: 1,
    contextWindow: 128_000,
    autoCompact: false,
  };

  await runAgentLoop({ messages: [{ role: "user", content: "work" }], config: base, handlers: {}, dependencies: { streamCompletion } });
  await runAgentLoop({ messages: [{ role: "user", content: "work" }], config: { ...base, interactive: false }, handlers: {}, dependencies: { streamCompletion } });

  assert.ok(seen[0].includes("request_user_input"));
  assert.ok(!seen[0].includes("exit_plan_mode"));
  assert.ok(!seen[1].includes("request_user_input"));
});

test("a failed Auto review returns its reason to the model without requesting permission", async () => {
  const messages = [{ role: "user", content: "clean everything" }];
  let completion = 0;
  let permissionRequests = 0;
  let executions = 0;
  const streamCompletion = async function* () {
    if (completion++ === 0) {
      yield {
        type: "tool_calls",
        calls: [{
          id: "danger",
          name: "terminal",
          arguments: JSON.stringify({ command: "rm -rf /", risk_level: "high" }),
        }],
      };
      return;
    }
    yield { type: "text", text: "used a safer approach" };
  };

  const result = await runAgentLoop({
    messages,
    config: {
      cwd: "/workspace",
      model: "test-model",
      protocol: "chat-completions",
      permissionMode: "auto",
      maxToolRounds: 2,
      contextWindow: 128_000,
      autoCompact: false,
    },
    handlers: {
      requestPermission: async () => {
        permissionRequests += 1;
        return "allow_once";
      },
    },
    dependencies: {
      streamCompletion,
      riskReviewer: async () => ({ approved: false, blocked: true, reason: "target is too broad" }),
      toolRunnerOverrides: {
        terminal: async () => {
          executions += 1;
          return { output: "should not run" };
        },
      },
    },
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(permissionRequests, 0);
  assert.equal(executions, 0);
  assert.match(messages.find((message) => message.role === "tool")?.content ?? "", /target is too broad/);
});
