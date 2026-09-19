import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration } from "./utils.js";

test("formatDuration omits sub-second durations instead of rendering 0s", () => {
  // null 而不是 "" 是契约的一部分：调用方要按「有没有值」决定整段计时是否渲染，
  // 空串会留下 ` · ` 这样的孤立分隔符。
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(999), null);
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(59_999), "59s");
});

test("formatDuration switches to minutes at 60s", () => {
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(65_000), "1m 5s");
});

test("formatDuration clamps negative input to an omitted duration", () => {
  assert.equal(formatDuration(-500), null);
});
