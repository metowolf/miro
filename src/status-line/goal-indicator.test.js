import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_INDICATOR_MARK, goalIndicator } from "./goal-indicator.js";

test("an active goal renders as `◎ /goal active (4s)`", () => {
  const indicator = goalIndicator({ status: "active", wallClockMs: 4_000 });
  assert.equal(indicator.text, "◎ /goal active (4s)");
  assert.equal(indicator.mark, GOAL_INDICATOR_MARK);
  assert.equal(indicator.color, "cyan");
});

test("every status words itself, so a stop is never mistaken for running", () => {
  const color = (status) => goalIndicator({ status, wallClockMs: 60_000 }).color;
  assert.equal(color("active"), "cyan");
  assert.equal(color("paused"), "yellow");
  assert.equal(color("blocked"), "red");
  assert.equal(color("complete"), "green");
  assert.equal(goalIndicator({ status: "blocked", wallClockMs: 0 }).text, "◎ /goal blocked (0s)");
  // 未知状态不猜颜色，但仍要把状态词原样交给用户。
  assert.equal(goalIndicator({ status: "queued", wallClockMs: 0 }).color, null);
});

test("the elapsed reading formats across magnitudes", () => {
  const elapsed = (wallClockMs) => goalIndicator({ status: "active", wallClockMs }).text;
  assert.equal(elapsed(0), "◎ /goal active (0s)");
  assert.equal(elapsed(90_000), "◎ /goal active (1m30s)");
  assert.equal(elapsed(3_720_000), "◎ /goal active (1h02m)");
});

test("a missing or unusable elapsed falls back to 0s instead of printing NaN", () => {
  assert.equal(goalIndicator({ status: "active" }).text, "◎ /goal active (0s)");
  assert.equal(goalIndicator({ status: "active", wallClockMs: Number.NaN }).text, "◎ /goal active (0s)");
  // 负数只会来自坏数据，不该倒着跳。
  assert.equal(goalIndicator({ status: "active", wallClockMs: -5 }).text, "◎ /goal active (0s)");
});

test("a monochrome status line renders the indicator as dim instead of colored", () => {
  const dimmed = goalIndicator({ status: "active", wallClockMs: 4_000 }, { useColors: false });
  assert.equal(dimmed.text, "◎ /goal active (4s)");
  assert.equal(dimmed.color, null);
  assert.equal(dimmed.dim, true);
  assert.equal(goalIndicator({ status: "active", wallClockMs: 4_000 }).dim, false);
});

test("no goal means no indicator, which is also the ACP case", () => {
  assert.equal(goalIndicator(null), null);
  assert.equal(goalIndicator(undefined), null);
  // 快照缺 status 时整项跳过，而不是印出 "goal undefined"。
  assert.equal(goalIndicator({ turnsUsed: 3, wallClockMs: 4_000 }), null);
  assert.equal(goalIndicator({ status: "   " }), null);
  assert.equal(goalIndicator({ status: 42 }), null);
});
