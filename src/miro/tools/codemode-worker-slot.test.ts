import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerGate } from "./codemode-worker-slot.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("同一时刻只有一个活着的 worker 槽位，先来先得", async () => {
  const gate = createWorkerGate();
  const order: string[] = [];
  const first = await gate.acquire();
  order.push("first");
  const second = gate.acquire().then((slot) => { order.push("second"); return slot; });
  await sleep(10);
  assert.deepEqual(order, ["first"]);
  assert.equal(gate.waiting, 1);
  assert.equal(gate.live, true);
  first.release();
  const secondSlot = await second;
  assert.equal(secondSlot.timedOut, false);
  assert.deepEqual(order, ["first", "second"]);
  secondSlot.release();
  assert.equal(gate.waiting, 0);
  assert.equal(gate.live, false);
});

test("重复归还不会多放行一次", async () => {
  const gate = createWorkerGate();
  const first = await gate.acquire();
  first.release();
  first.release();
  const second = await gate.acquire();
  let thirdStarted = false;
  const third = gate.acquire().then((slot) => { thirdStarted = true; return slot; });
  await sleep(10);
  assert.equal(thirdStarted, false);
  second.release();
  (await third).release();
  assert.equal(thirdStarted, true);
  assert.equal(gate.live, false);
});

test("上一个 worker 迟迟不退出时等满上限先放行并标记 timedOut", async () => {
  const gate = createWorkerGate();
  const first = await gate.acquire();
  const started = Date.now();
  const second = await gate.acquire({ timeoutMs: 60 });
  assert.equal(second.timedOut, true);
  assert.ok(Date.now() - started >= 40, "应当等满上限才放行");
  second.release();
  assert.equal(gate.live, true, "上一个 worker 仍占着槽位");
  first.release();
  assert.equal(gate.live, false);
});

test("等待期间取消只拒绝调用方，不把排队位置让给更晚的执行", async () => {
  const gate = createWorkerGate();
  const first = await gate.acquire();
  const controller = new AbortController();
  const cancelled = gate.acquire({ signal: controller.signal });
  await sleep(10);
  controller.abort(new Error("stop now"));
  await assert.rejects(cancelled, /stop now/);
  let nextStarted = false;
  const next = gate.acquire().then((slot) => { nextStarted = true; return slot; });
  await sleep(10);
  assert.equal(nextStarted, false, "取消者不能提前放行后面的执行");
  first.release();
  (await next).release();
  assert.equal(gate.live, false);
});

test("已经取消的 signal 不会拿到槽位", async () => {
  const gate = createWorkerGate();
  const first = await gate.acquire();
  const controller = new AbortController();
  controller.abort(new Error("already gone"));
  await assert.rejects(gate.acquire({ signal: controller.signal }), /already gone/);
  first.release();
  const slot = await gate.acquire({ timeoutMs: 100 });
  assert.equal(slot.timedOut, false);
  slot.release();
  assert.equal(gate.live, false);
});
