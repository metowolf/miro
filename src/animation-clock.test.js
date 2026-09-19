import assert from "node:assert/strict";
import test from "node:test";

import { acquireAnimationClock, isAnimationClockRunning } from "./animation-clock.js";
import { useStore } from "./store.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("one shared timer advances the store tick for every animation, and stops when the last one lets go", async () => {
  const releaseFirst = acquireAnimationClock();
  const releaseSecond = acquireAnimationClock();
  assert.equal(isAnimationClockRunning(), true, "the clock starts on the first subscriber");

  const before = useStore.getState().animationTick;
  await wait(160);
  assert.ok(
    useStore.getState().animationTick > before,
    "the clock advances the tick that every animated component renders from"
  );

  // 重复 release 不该把还在用的表停掉：一个组件卸载两次是它自己的事。
  releaseFirst();
  releaseFirst();
  assert.equal(isAnimationClockRunning(), true, "the second subscriber keeps the clock alive");

  releaseSecond();
  assert.equal(isAnimationClockRunning(), false, "the clock stops when nobody is animating");

  const after = useStore.getState().animationTick;
  await wait(160);
  assert.equal(useStore.getState().animationTick, after, "an idle app does no periodic work");
});
