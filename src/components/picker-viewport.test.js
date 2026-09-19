import assert from "node:assert/strict";
import test from "node:test";

import { pickerDensity, pickerViewport } from "./picker-viewport.js";

test("the picker viewport shrinks with terminal height and keeps at least one option", () => {
  assert.deepEqual(
    pickerViewport({ index: 0, total: 20, rows: 24, reservedRows: 8, maxVisible: 10 }),
    { index: 0, size: 10, start: 0, end: 10, above: 0, below: 10 },
  );
  assert.equal(
    pickerViewport({ index: 0, total: 20, rows: 6, reservedRows: 5, maxVisible: 10 }).size,
    1,
  );
});

test("the picker viewport still contains the current selection after a resize", () => {
  const viewport = pickerViewport({
    index: 17,
    total: 20,
    rows: 8,
    reservedRows: 5,
    maxVisible: 10,
  });
  assert.ok(viewport.start <= 17);
  assert.ok(viewport.end > 17);
  assert.equal(viewport.above, viewport.start);
  assert.equal(viewport.below, 20 - viewport.end);
});

test("picker density degrades stepwise as terminal height shrinks", () => {
  assert.equal(pickerDensity(24), "full");
  assert.equal(pickerDensity(12), "compact");
  assert.equal(pickerDensity(7), "minimal");
});
