import assert from "node:assert/strict";
import test from "node:test";

import { permissionDecision, requiresAutoReview, runAgentLoop } from "./agent-loop.js";
import { activeToolDefinitions, toolDefinition, toolSchemas } from "./tools/index.js";

/** 取当前模式下命令工具的参数名集合。 */
function commandParameterNames(sandboxEnabled) {
  const schema = toolSchemas(sandboxEnabled).find((entry) => entry.function.name === "terminal");
  return Object.keys(schema.function.parameters.properties);
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
