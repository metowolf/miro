import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStatusLineSegments, statusLineText } from "./render.js";

const snapshot = {
  modelName: "gpt-5-codex",
  effortName: "medium",
  modeName: "default",
  cwd: path.join(os.homedir(), "workspace", "miro"),
  projectName: "miro",
  hostname: "build-01",
  gitBranch: "feat/status-line",
  providerName: "Claude",
  sessionId: "1094dbe3-d3d9-4f63-a03f-93f98b2f0bbd",
  sessionTitle: "Status line work",
  version: "0.1.0",
  usage: { used: 30_000, size: 200_000 },
  // 累计项读 sessionTokens / sessionCost：`tokens` 与 `usage.cost` 是提供方最近一次
  // 读数，两者不能混用。
  tokens: { total: 2905, input: 5, output: 2900, thought: null },
  sessionTokens: { total: 12_345, input: 10_000, output: 2_000, thought: 345 },
  sessionCost: { amount: 1.5, currency: "USD" },
  plan: { total: 7, completed: 3 },
  busy: true,
  cancelling: false,
  thinking: false,
};

test("renders in configured order with ' · ' as the separator", () => {
  assert.equal(
    statusLineText(["model-with-reasoning", "current-dir"], snapshot),
    "gpt-5-codex medium · ~/workspace/miro"
  );
});

test("user example config: rate-limit items are skipped and collected as invalid", () => {
  const { segments, invalid } = buildStatusLineSegments(
    ["model-with-reasoning", "current-dir", "five-hour-limit", "weekly-limit", "task-progress"],
    snapshot
  );
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ["gpt-5-codex medium", "~/workspace/miro", "3/7"]
  );
  assert.deepEqual(invalid, ["five-hour-limit", "weekly-limit"]);
});

test("current-dir abbreviates the home prefix", () => {
  assert.equal(statusLineText(["current-dir"], { cwd: os.homedir() }), "~");
  assert.equal(statusLineText(["current-dir"], { cwd: "/srv/app" }), "/srv/app");
});

test("context percentages come from usage.used / usage.size", () => {
  assert.equal(statusLineText(["context-used", "context-remaining"], snapshot), "15% used · 85% left");
  assert.equal(statusLineText(["context-window-size"], snapshot), "200k ctx");
});

test("usage.size of 0 skips the context items instead of dividing by zero", () => {
  const zero = { usage: { used: 10, size: 0 } };
  assert.equal(statusLineText(["context-used", "context-remaining", "context-window-size"], zero), "");
});

test("used above size clamps the percentage to 100", () => {
  const over = { usage: { used: 500, size: 100 } };
  assert.equal(statusLineText(["context-used", "context-remaining"], over), "100% used · 0% left");
});

test("items without data are skipped instead of rendering blank", () => {
  assert.equal(statusLineText(["used-tokens", "session-cost", "git-branch"], {}), "");
});

test("token and cost items carry unit suffixes", () => {
  assert.equal(
    statusLineText(["used-tokens", "input-tokens", "output-tokens", "thought-tokens"], snapshot),
    "12.3k tokens · 10k in · 2k out · 345 think"
  );
  assert.equal(statusLineText(["session-cost"], snapshot), "$1.50");
});

test("non-USD cost carries the currency code as a suffix", () => {
  assert.equal(
    statusLineText(["session-cost"], { sessionCost: { amount: 2, currency: "EUR" } }),
    "2.00 EUR"
  );
});

test("run-state reflects busy / thinking / cancelling", () => {
  assert.equal(statusLineText(["run-state"], { busy: false }), "Ready");
  assert.equal(statusLineText(["run-state"], { busy: true }), "Working");
  assert.equal(statusLineText(["run-state"], { busy: true, thinking: true }), "Thinking");
  assert.equal(statusLineText(["run-state"], { busy: true, cancelling: true }), "Interrupting");
});

test("session-id is truncated to the short form", () => {
  assert.equal(statusLineText(["session-id"], snapshot), "1094dbe3");
});

test("task-progress is skipped when there is no plan", () => {
  assert.equal(statusLineText(["task-progress"], { plan: { total: 0, completed: 0 } }), "");
  assert.equal(statusLineText(["task-progress"], {}), "");
});

test("an all-invalid config equals an empty status line while keeping the invalid list", () => {
  const { segments, invalid } = buildStatusLineSegments(["five-hour-limit", "nope"], snapshot);
  assert.deepEqual(segments, []);
  assert.deepEqual(invalid, ["five-hour-limit", "nope"]);
});

test("useColors=false renders every segment as dim", () => {
  const { segments } = buildStatusLineSegments(["model", "current-dir"], snapshot, {
    useColors: false,
  });
  assert.ok(segments.every((segment) => segment.color === null && segment.dim === true));
});

test("useColors=true assigns colors by tone", () => {
  const { segments } = buildStatusLineSegments(["model", "current-dir", "hostname"], snapshot);
  assert.equal(segments[0].color, "yellow");
  assert.equal(segments[1].color, "cyan");
  assert.equal(segments[2].color, null);
  assert.equal(segments[2].dim, true);
});

test("model-with-reasoning falls back to the model name when effort is missing", () => {
  assert.equal(statusLineText(["model-with-reasoning"], { modelName: "gpt-5" }), "gpt-5");
});

test("a throwing value getter skips that item without breaking the render", () => {
  const hostile = {
    get modelName() {
      throw new Error("boom");
    },
    cwd: "/srv/app",
  };
  assert.equal(statusLineText(["model", "current-dir"], hostile), "/srv/app");
});

test("permission-mode shows the two miro levels and hides when ACP reports none", () => {
  for (const [permissionMode, label] of [["auto", "AUTO"], ["manual", "MANUAL"]]) {
    assert.equal(statusLineText(["permission-mode"], { permissionMode }), label);
  }
  assert.equal(statusLineText(["permission-mode"], {}), "");
});

test("goal prints the status so blocked is never mistaken for running", () => {
  const goal = (status) => ({ goal: { status, turnsUsed: 3, budget: {} } });
  assert.equal(statusLineText(["goal"], goal("active")), "goal active 3t");
  assert.equal(statusLineText(["goal"], goal("blocked")), "goal blocked 3t");
  assert.equal(statusLineText(["goal"], goal("paused")), "goal paused 3t");
  assert.equal(statusLineText(["goal"], goal("complete")), "goal complete 3t");
});

test("goal adds the turn budget as a denominator only when one is set", () => {
  assert.equal(
    statusLineText(["goal"], { goal: { status: "active", turnsUsed: 2, budget: { turnBudget: 10 } } }),
    "goal active 2/10t"
  );
  // 不限预算的目标不能印出假分母。
  assert.equal(
    statusLineText(["goal"], { goal: { status: "active", turnsUsed: 2, budget: {} } }),
    "goal active 2t"
  );
});

test("goal is hidden without a goal, which is also the ACP case", () => {
  assert.equal(statusLineText(["goal"], {}), "");
  assert.equal(statusLineText(["goal"], { goal: null }), "");
  // 快照缺 status 时同样跳过，而不是印出 "goal undefined"。
  assert.equal(statusLineText(["goal"], { goal: { turnsUsed: 1 } }), "");
});

test("goal tolerates a snapshot with no counters yet", () => {
  assert.equal(statusLineText(["goal"], { goal: { status: "active" } }), "goal active 0t");
});
