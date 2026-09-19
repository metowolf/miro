import assert from "node:assert/strict";
import test from "node:test";

import {
  spawnAgentTool,
  subagentTools,
} from "./subagent-runner.js";

/**
 * 记录每次交给子循环的 config。runLoop 被注入，所以用例不碰网络、不碰文件系统。
 */
function harness({ resolver = null } = {}) {
  const calls = [];
  const runLoop = async (args) => {
    calls.push(args);
    args.handlers?.onChunk?.("done");
    return { stopReason: "end_turn", cancelled: false };
  };
  const tool = spawnAgentTool({
    runLoop,
    config: { model: "parent-model", effort: "medium", cwd: "/work" },
    parentTools: ["read_file", "grep", "spawn_agent", "update_tasks"],
    dependencies: resolver ? { resolveSubagentRouting: resolver } : {},
  });
  return { tool, calls };
}

test("model and effort overrides reach the child config through the resolver", async () => {
  const seen = [];
  const resolver = (options) => {
    seen.push(options);
    return { patch: { model: "child-model", effort: "high" } };
  };
  const { tool, calls } = harness({ resolver });

  const result = await tool({ message: "do it", model: "child-model", effort: "high" });

  assert.deepEqual(seen, [{ model: "child-model", effort: "high" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.model, "child-model");
  assert.equal(calls[0].config.effort, "high");
  assert.deepEqual(calls[0].config.tools, ["read_file", "grep"]);
  assert.equal(result.output, "done");
});

test("no override skips the resolver and inherits the parent config", async () => {
  let called = 0;
  const { tool, calls } = harness({
    resolver: () => {
      called += 1;
      return { patch: {} };
    },
  });

  await tool({ message: "do it" });

  assert.equal(called, 0);
  assert.equal(calls[0].config.model, "parent-model");
  assert.equal(calls[0].config.effort, "medium");
});

test("a resolver error becomes a failed tool result without running the loop", async () => {
  const { tool, calls } = harness({
    resolver: () => ({ error: 'model "nope" is not available' }),
  });

  const result = await tool({ message: "do it", model: "nope" });

  assert.match(result.error, /model "nope" is not available/);
  assert.equal(calls.length, 0);
});

test("without a resolver the overrides pass through verbatim", async () => {
  const { tool, calls } = harness();

  await tool({ message: "do it", model: "child-model", effort: "low" });

  assert.equal(calls[0].config.model, "child-model");
  assert.equal(calls[0].config.effort, "low");
});

test("a missing message is rejected before the loop runs", async () => {
  const { tool, calls } = harness();

  const result = await tool({ description: "label only" });

  assert.match(result.error, /missing required parameter 'message'/);
  assert.equal(calls.length, 0);
});

test("subagentTools strips recursion and parent-plan tools", () => {
  assert.deepEqual(
    subagentTools(["read_file", "spawn_agent", "update_tasks", "grep"]),
    ["read_file", "grep"]
  );
});
