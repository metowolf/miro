import assert from "node:assert/strict";
import test from "node:test";
import { MiroAgentClient } from "./agent-client.ts";
import { runAgentLoop } from "./agent-loop.ts";

function deferred() {
  let resolve;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ finish = "stop", failure = false, maxToolRounds = 5, isolated = false, plan = false }: any = {}) {
  const entered = deferred();
  const release = deferred();
  const seen = [];
  let requests = 0;
  const client = new MiroAgentClient({
    cwd: "/tmp/miro-steering-test",
    settings: { miro: { models: ["m1"], model: "m1" } },
    dependencies: {
      modelsFile: null,
      oauthModels: { getModels: () => [] },
      loadSkills: () => ({ skills: [], diagnostics: [] }),
      loadSessionBlocks: () => null,
      backend: {
        estimateTokens: (text) => Math.ceil(text.length / 4),
        stream: async function* ({ messages }: any) {
          seen.push(structuredClone(messages));
          requests += 1;
          if (requests === 1) {
            entered.resolve();
            await release.promise;
            if (failure) throw new Error("backend unavailable");
          }
          yield { type: "text", text: requests === 1 ? "first answer" : "guided answer" };
          yield { type: "finish", reason: finish };
        },
      },
    },
  });
  client.config.maxToolRounds = maxToolRounds;
  client.config.autoCompact = false;
  if (plan) client.interactionMode = "plan";
  const applied = [];
  const returned = [];
  const checkpoints = [];
  client.on("context_checkpoint", (state) => checkpoints.push(structuredClone(state)));
  client.on("input_applied", (input) => {
    assert.ok(checkpoints.at(-1).appliedInputs.some((item) => item.id === input.id));
    applied.push(input);
  });
  client.on("input_returned", (event) => returned.push(event));
  const run = () => isolated ? client.promptIsolated("review", { displayText: "/review" }) : client.prompt("original");
  const steer = (id = "s1", text = "change direction") => client.steerInput({ id, turnId: client.steeringCapability().turnId, content: text, display: text });
  return { client, run, steer, entered, release, seen, applied, returned, checkpoints };
}

for (const plan of [false, true]) {
  test(`steering continues a ${plan ? "Plan" : "normal"} task after its final response, with FIFO receipts`, async () => {
    const h = harness({ plan });
    const running = h.run();
    await h.entered.promise;
    assert.deepEqual(h.steer("s1", "first guidance"), { accepted: true });
    assert.deepEqual(h.steer("s2", "second guidance"), { accepted: true });
    h.steer("s1", "first guidance");
    assert.equal(h.applied.length, 0);
    assert.ok(!h.client.messages.some((message) => message.content === "first guidance"));
    h.release.resolve();
    assert.equal((await running).stopReason, "end_turn");
    assert.equal(h.seen.length, 2);
    assert.deepEqual(h.seen[1].slice(-3).map((message) => [message.role, message.content]), [
      ["assistant", "first answer"], ["user", "first guidance"], ["user", "second guidance"],
    ]);
    assert.deepEqual(h.applied.map((input) => input.id), ["s1", "s2"]);
    assert.equal(h.returned.length, 0);
    assert.equal(h.client.steeringCapability().available, false);
  });
}

test("steering rejects a stale turn, empty input and concurrent prompts", async () => {
  const h = harness();
  assert.equal(h.steer().accepted, false);
  const running = h.run();
  await h.entered.promise;
  assert.equal(h.client.steerInput({ id: "s", turnId: "old", content: "x" }).accepted, false);
  assert.equal(h.steer("s", "  ").accepted, false);
  await assert.rejects(h.client.prompt("parallel"), /Wait for the current operation/);
  h.release.resolve();
  await running;
  assert.equal(h.steer().accepted, false);
  assert.equal(h.client.appliedInputs.length, 0);
});

for (const stop of ["cancel", "failure", "limit", "filter"]) {
  test(`unapplied steering is returned paused after ${stop}`, async () => {
    const h = harness({ failure: stop === "failure", maxToolRounds: stop === "limit" ? 1 : 5, finish: stop === "filter" ? "content_filter" : "stop" });
    const running = h.run();
    await h.entered.promise;
    h.steer();
    if (stop === "cancel") {
      h.client.cancel();
      assert.equal(h.steer("late").accepted, false);
    }
    h.release.resolve();
    if (stop === "failure") await assert.rejects(running, /backend unavailable/);
    else await running;
    assert.deepEqual(h.returned, [{ inputs: [{ id: "s1", text: "change direction", display: "change direction" }], paused: true }]);
    assert.equal(h.applied.length, 0);
  });
}

test("isolated workflows and standalone compaction do not accept steering", async () => {
  const h = harness({ isolated: true });
  const running = h.run();
  await h.entered.promise;
  assert.equal(h.client.steeringCapability().available, false);
  assert.equal(h.steer().accepted, false);
  h.release.resolve();
  await running;
  // 独立压缩使用控制器，却没有普通回合的收件箱。
  h.client.abortController = new AbortController();
  assert.equal(h.client.steeringCapability().available, false);
  h.client.abortController = null;
});

test("Goal steering stays in the existing goal and does not count a new goal turn", async () => {
  const h = harness();
  h.client.goal.create({ objective: "finish the task" });
  const id = h.client.goalSnapshot().goalId;
  const running = h.client.driveGoal("original", { maxTurns: 1 });
  await h.entered.promise;
  h.steer();
  h.release.resolve();
  const result = await running;
  assert.equal(h.seen.length, 2);
  assert.equal(h.applied.length, 1);
  assert.equal(result.goal.goalId, id);
  assert.equal(result.goal.turnsUsed, 1);
});

test("a Goal stops automatic continuation when steering cannot fit before the round cap", async () => {
  const h = harness({ maxToolRounds: 1 });
  h.client.goal.create({ objective: "finish the task" });
  const running = h.client.driveGoal("original", { maxTurns: 3 });
  await h.entered.promise;
  h.steer();
  h.release.resolve();
  const result = await running;
  assert.equal(h.seen.length, 1);
  assert.equal(result.goal.status, "paused");
  assert.equal(h.returned[0].paused, true);
});

test("a Goal budget reached during generation leaves steering unapplied", async () => {
  const h = harness();
  h.client.goal.create({ objective: "finish the task" });
  const running = h.client.driveGoal("original", { maxTurns: 3 });
  await h.entered.promise;
  h.steer();
  h.client.goal.setBudgetLimits({ tokenBudget: 1 });
  h.client.goal.addTokens(2);
  h.release.resolve();
  const result = await running;
  assert.equal(result.goal.status, "blocked");
  assert.equal(h.applied.length, 0);
  assert.equal(h.seen.length, 1);
  assert.equal(h.returned[0].paused, true);
});

test("steering submitted during automatic compaction reaches the next model request", async () => {
  const entered = deferred();
  const release = deferred();
  const inputs = [];
  const requests = [];
  const messages = [
    { role: "system", content: "base" },
    { role: "user", content: "a".repeat(1_000) },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "b".repeat(220) },
  ];
  const running = runAgentLoop({
    messages,
    config: { cwd: "/workspace", model: "m1", protocol: "chat-completions", permissionMode: "auto", maxToolRounds: 3, contextWindow: 1_100, autoCompact: true },
    handlers: { takePendingInputs: () => inputs.splice(0) },
    dependencies: { backend: {
      estimateTokens: (text) => text.length,
      stream: async function* ({ messages, tools }: any) {
        if (tools.length === 0) {
          entered.resolve();
          await release.promise;
          yield { type: "text", text: "Useful compact summary" };
        } else {
          requests.push(structuredClone(messages));
          yield { type: "text", text: "guided answer" };
        }
        yield { type: "finish", reason: "stop" };
      },
    } },
  });
  await entered.promise;
  inputs.push({ id: "s", text: "guidance during compaction" });
  release.resolve();
  await running;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].at(-1).content, "guidance during compaction");
  assert.ok(requests[0].some((message) => message.miro_compaction));
});

test("steering waits for every tool result before appending the user message", async () => {
  const entered = deferred();
  const release = deferred();
  const inputs = [];
  const seen = [];
  let calls = 0;
  const messages = [{ role: "user", content: "original" }];
  const running = runAgentLoop({
    messages,
    config: { cwd: "/workspace", model: "m1", protocol: "chat-completions", permissionMode: "auto", maxToolRounds: 3, contextWindow: 128_000, autoCompact: false },
    handlers: { takePendingInputs: () => inputs.splice(0) },
    dependencies: {
      streamCompletion: async function* ({ messages }: any) {
        seen.push(structuredClone(messages));
        if (calls++ === 0) yield { type: "tool_calls", calls: [
          { id: "t1", name: "terminal", arguments: JSON.stringify({ command: "first", risk_level: "low" }) },
          { id: "t2", name: "terminal", arguments: JSON.stringify({ command: "second", risk_level: "low" }) },
        ] };
        else yield { type: "text", text: "done" };
      },
      toolRunnerOverrides: { terminal: async (args) => {
        if (args.command === "first") { entered.resolve(); await release.promise; }
        return { output: args.command };
      } },
    },
  });
  await entered.promise;
  inputs.push({ id: "s", text: "guidance" });
  assert.equal(messages.some((message) => message.content === "guidance"), false);
  release.resolve();
  await running;
  assert.deepEqual(seen[1].slice(-3).map((message) => [message.role, message.tool_call_id ?? message.content]), [
    ["tool", "t1"], ["tool", "t2"], ["user", "guidance"],
  ]);
});
