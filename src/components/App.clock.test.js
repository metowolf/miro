/**
 * 底栏目标指示器的两个接线规则：
 *
 * 1. 秒表什么时候为它走（isClockRunning 的 goalActive）：目标跨越多个回合，大部分
 *    时间花在「没有工具在跑」的模型思考与回合间隙上，只在 busy 时走表会让耗时僵住。
 * 2. 秒表每秒替它取一次新快照（refreshActiveGoal）：目标快照的墙钟按需结算，不主动
 *    取就只能等下一次 emit。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isClockRunning, refreshActiveGoal } from "./App.jsx";
import { useStore } from "../store.js";

const activeGoal = (wallClockMs) => ({
  goalId: "goal_1",
  objective: "ship it",
  status: "active",
  turnsUsed: 1,
  wallClockMs,
  budget: {},
});

function fakeClient(snapshot) {
  const calls = { goalSnapshot: 0 };
  return {
    calls,
    goalSnapshot() {
      calls.goalSnapshot += 1;
      return snapshot;
    },
  };
}

test("the second clock also runs for a goal with no tool in flight", () => {
  assert.equal(isClockRunning({}), false);
  assert.equal(isClockRunning({ goalActive: true }), true);
  // 阻塞式 overlay 仍在等用户按键，目标耗时不必每秒重算。
  assert.equal(isClockRunning({ goalActive: true, awaitingInput: true }), false);
  // 整屏接管的面板同理：动态区被整块替换。
  assert.equal(isClockRunning({ goalActive: true, overlayKind: "review-browser" }), false);
});

test("an active goal's fresh snapshot lands in the store on every tick", () => {
  useStore.getState().setGoal(activeGoal(4_000));
  const client = fakeClient(activeGoal(5_000));

  refreshActiveGoal(client);

  assert.equal(client.calls.goalSnapshot, 1);
  assert.equal(useStore.getState().goal.wallClockMs, 5_000);
});

test("a goal that is not running is not polled", () => {
  for (const status of ["paused", "blocked", "complete"]) {
    useStore.getState().setGoal({ ...activeGoal(4_000), status });
    const client = fakeClient(activeGoal(9_000));
    refreshActiveGoal(client);
    assert.equal(client.calls.goalSnapshot, 0, `${status} should not be polled`);
    assert.equal(useStore.getState().goal.wallClockMs, 4_000);
  }

  // 没有目标时连状态都不该被碰。
  useStore.getState().setGoal(null);
  const client = fakeClient(activeGoal(9_000));
  assert.equal(refreshActiveGoal(client), null);
  assert.equal(client.calls.goalSnapshot, 0);
  assert.equal(useStore.getState().goal, null);
});

test("an ACP client without goalSnapshot, or a null snapshot, changes nothing", () => {
  useStore.getState().setGoal(activeGoal(4_000));

  assert.equal(refreshActiveGoal({}), null);
  assert.equal(useStore.getState().goal.wallClockMs, 4_000);

  refreshActiveGoal(fakeClient(null));
  assert.equal(useStore.getState().goal.wallClockMs, 4_000);
});
