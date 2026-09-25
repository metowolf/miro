import assert from "node:assert/strict";
import test from "node:test";

import { stringWidth } from "../../markdown-width.js";
import { completionHint, completionViewport } from "./picker-completion.js";

test("补全列表最多八项，短窗口扣除输入框、底栏和提示后收缩", () => {
  const options = { index: 0, total: 81, rows: 24 };
  assert.equal(completionViewport(options).size, 8);
  assert.equal(completionViewport({ ...options, rows: 12 }).size, 4);
  assert.equal(completionViewport({ ...options, rows: 12, inputRows: 5 }).size, 2);
  assert.equal(completionViewport({ ...options, rows: 5, inputRows: 5 }).size, 1);
});

test("多行输入、缩放和滚动都保持当前候选可见且总数不变", () => {
  for (const rows of [32, 16, 12, 6]) {
    for (const inputRows of [3, 5, 9]) {
      for (const index of [0, 15, 40, 80]) {
        const viewport = completionViewport({ rows, inputRows, index, total: 81 });
        assert.ok(viewport.start <= index && viewport.end > index);
        assert.equal(viewport.above + viewport.size + viewport.below, 81);
      }
    }
  }
  assert.equal(completionViewport({ index: 0, total: 0, rows: 24 }).size, 0);
});

test("提示不会折行，窄窗口仍保留完整候选计数", () => {
  const viewport = completionViewport({ index: 40, total: 81, rows: 12 });
  for (const width of [110, 42, 24, 12, 5]) {
    const hint = completionHint(width, viewport, 81);
    assert.ok(stringWidth(hint) <= width);
    assert.ok(hint.endsWith("41/81"));
  }
  assert.equal(completionHint(0, viewport, 81), "");
  const small = completionViewport({ index: 0, total: 1, rows: 24 });
  assert.doesNotMatch(completionHint(80, small, 1), /1\/1/);
});
