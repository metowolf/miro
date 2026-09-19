import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BSU, ESU, createSyncStdout } from "./sync-stdout.js";

class MockStdout extends EventEmitter {
  columns = 120;
  rows = 42;
  isTTY = true;
  writes = [];

  write(...args) {
    this.writes.push(args);
    return true;
  }

  dimensions() {
    return `${this.columns}x${this.rows}`;
  }
}

test("wraps one non-empty frame in a single underlying write", () => {
  const realStdout = new MockStdout();
  const stdout = createSyncStdout(realStdout);

  assert.equal(stdout.write("rendered frame"), true);
  assert.equal(realStdout.writes.length, 1);
  assert.deepEqual(realStdout.writes[0], [Buffer.from(`${BSU}rendered frame${ESU}`)]);
});

test("preserves binary chunks and forwards empty writes unchanged", () => {
  const realStdout = new MockStdout();
  const stdout = createSyncStdout(realStdout);
  const binary = Buffer.from([0, 255, 10]);

  stdout.write(binary);
  stdout.write("");

  assert.deepEqual(realStdout.writes[0], [Buffer.concat([Buffer.from(BSU), binary, Buffer.from(ESU)])]);
  assert.deepEqual(realStdout.writes[1], [""]);
});

test("delegates terminal properties, methods, and resize events", () => {
  const realStdout = new MockStdout();
  const stdout = createSyncStdout(realStdout);
  let resizeCount = 0;

  assert.equal(stdout.columns, 120);
  assert.equal(stdout.rows, 42);
  assert.equal(stdout.isTTY, true);
  assert.equal(stdout.dimensions(), "120x42");

  stdout.on("resize", () => {
    resizeCount += 1;
  });
  realStdout.columns = 100;
  realStdout.rows = 30;
  realStdout.emit("resize");

  assert.equal(resizeCount, 1);
  assert.equal(stdout.dimensions(), "100x30");
});
