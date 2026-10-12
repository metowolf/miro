import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeScheduler } from "./codemode-scheduler.ts";

function gate() {
  let release: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("codemode 调度最多八条并行读取，MCP 是不可越过的串行屏障", async () => {
  const scheduler = createCodemodeScheduler();
  const signal = new AbortController().signal;
  const reads = gate();
  const remote = gate();
  const remoteStarted = gate();
  let active = 0;
  let peak = 0;
  const events = [];
  const first = Array.from({ length: 10 }, (_, i) => scheduler.schedule(true, signal, async () => {
    active += 1; peak = Math.max(peak, active); events.push(`read${i}`);
    await reads.promise;
    active -= 1;
  }));
  const effect = scheduler.schedule(false, signal, async () => {
    assert.equal(active, 0);
    events.push("remote"); remoteStarted.release(); await remote.promise;
  });
  const last = scheduler.schedule(true, signal, async () => { events.push("last"); });
  await Promise.resolve();
  assert.equal(peak, 8);
  assert.equal(events.length, 8);
  reads.release();
  await remoteStarted.promise;
  assert.equal(events.at(-1), "remote");
  assert.equal(events.includes("last"), false);
  remote.release();
  await Promise.all([...first, effect, last]);
  await scheduler.close();
  assert.equal(events.at(-1), "last");
  assert.equal(peak, 8);
});

test("codemode 关闭拒绝排队任务且等待实际执行器完成", async () => {
  const scheduler = createCodemodeScheduler();
  const signal = new AbortController().signal;
  const running = gate();
  let queuedRan = false;
  const active = scheduler.schedule(false, signal, () => running.promise);
  const queued = scheduler.schedule(true, signal, async () => { queuedRan = true; });
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await assert.rejects(queued, /finished before/);
  assert.equal(closed, false);
  running.release();
  await active;
  await closing;
  assert.equal(queuedRan, false);
  await assert.rejects(scheduler.schedule(true, signal, async () => {}), /finished/);
});
