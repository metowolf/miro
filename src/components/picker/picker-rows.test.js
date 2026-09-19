import assert from "node:assert/strict";
import test from "node:test";

import {
  compactRowWidth,
  firstSelectableIndex,
  initialIndex,
  moveIndex,
  normalizeItem,
  normalizeItems,
  splitRowWidth,
  truncateToCellWidth,
} from "./picker-rows.js";

test("normalizeItem falls back through label → name → value in order", () => {
  assert.equal(normalizeItem({ value: "v", label: "L", name: "N" }, 0).label, "L");
  assert.equal(normalizeItem({ value: "v", name: "N" }, 0).label, "N");
  assert.equal(normalizeItem({ value: "v" }, 0).label, "v");
});

test("normalizeItem fills missing fields with empty string and false", () => {
  const row = normalizeItem({ value: "v" }, 0);
  assert.equal(row.description, "");
  assert.equal(row.groupName, "");
  assert.equal(row.right, "");
  assert.equal(row.current, false);
  assert.equal(row.disabled, false);
});

test("normalizeItem keeps the original object on source for pass-back", () => {
  const raw = { value: "v", extra: { nested: 1 } };
  assert.equal(normalizeItem(raw, 0).source, raw);
});

test("normalizeItem builds a stable key when value is missing", () => {
  assert.equal(normalizeItem({ label: "A" }, 3).key, "row-3");
  assert.equal(normalizeItem({ value: "a" }, 3).key, "3:a");
});

test("normalizeItem keys stay unique when two rows share a value", () => {
  const rows = normalizeItems([{ value: "shared" }, { value: "shared" }]);
  assert.deepEqual(rows.map((row) => row.key), ["0:shared", "1:shared"]);
});

test("normalizeItems tolerates non-array input", () => {
  assert.deepEqual(normalizeItems(null), []);
  assert.equal(normalizeItems([{ value: "a" }, null]).length, 2);
});

test("firstSelectableIndex skips leading disabled rows", () => {
  const rows = normalizeItems([
    { value: "a", disabled: true },
    { value: "b", disabled: true },
    { value: "c" },
  ]);
  assert.equal(firstSelectableIndex(rows), 2);
});

test("firstSelectableIndex returns 0 when every row is unselectable", () => {
  const rows = normalizeItems([{ value: "a", disabled: true }]);
  assert.equal(firstSelectableIndex(rows), 0);
});

test("initialIndex prefers an explicit selected index", () => {
  const rows = normalizeItems([{ value: "a" }, { value: "b" }, { value: "c" }]);
  assert.equal(initialIndex(rows, 2), 2);
});

test("initialIndex lands on the current item when selected is absent", () => {
  const rows = normalizeItems([{ value: "a" }, { value: "b", current: true }]);
  assert.equal(initialIndex(rows, null), 1);
});

test("initialIndex falls back when selected is out of range or points at a disabled row", () => {
  const rows = normalizeItems([{ value: "a", disabled: true }, { value: "b", current: true }]);
  assert.equal(initialIndex(rows, 99), 1, "an out-of-range index falls back to current");
  assert.equal(initialIndex(rows, 0), 1, "pointing at a disabled row falls back to current");
});

test("initialIndex returns 0 for an empty list", () => {
  assert.equal(initialIndex([], 3), 0);
});

test("moveIndex skips disabled rows", () => {
  const rows = normalizeItems([
    { value: "a" },
    { value: "b", disabled: true },
    { value: "c" },
  ]);
  assert.equal(moveIndex(rows, 0, 1), 2);
  assert.equal(moveIndex(rows, 2, -1), 0);
});

test("moveIndex wraps around past the first and last rows", () => {
  const rows = normalizeItems([{ value: "a" }, { value: "b" }]);
  assert.equal(moveIndex(rows, 1, 1), 0);
  assert.equal(moveIndex(rows, 0, -1), 1);
});

test("moveIndex stays put without looping forever when all rows are disabled", () => {
  const rows = normalizeItems([
    { value: "a", disabled: true },
    { value: "b", disabled: true },
  ]);
  assert.equal(moveIndex(rows, 1, 1), 1);
});

test("moveIndex returns 0 for an empty list", () => {
  assert.equal(moveIndex([], 0, 1), 0);
});

test("truncateToCellWidth truncates CJK by cell width", () => {
  assert.equal(truncateToCellWidth("配置项名称", 6), "配置…");
  assert.equal(truncateToCellWidth("abc", 10), "abc");
  assert.equal(truncateToCellWidth("abcdef", 1), "…");
  assert.equal(truncateToCellWidth("abcdef", 0), "");
});

test("splitRowWidth gives the right column at most half the content width", () => {
  const layout = splitRowWidth(40, 2, "medium");
  assert.equal(layout.showRight, true);
  assert.ok(layout.rightWidth <= Math.floor(38 / 2));
  assert.equal(layout.leftWidth + layout.rightWidth + 1, 38);
});

test("splitRowWidth lets the left column take everything when there is no right text", () => {
  const layout = splitRowWidth(40, 2, "");
  assert.equal(layout.showRight, false);
  assert.equal(layout.leftWidth, 38);
});

test("splitRowWidth drops the right column when content is too narrow", () => {
  const layout = splitRowWidth(8, 2, "value");
  assert.equal(layout.showRight, false);
  assert.equal(layout.leftWidth, 6);
});

test("compactRowWidth gives the left column exactly the label width", () => {
  const layout = compactRowWidth(80, 2, "1  Tool   ");
  assert.equal(layout.showRight, true);
  assert.equal(layout.leftWidth, 10);
  assert.equal(layout.rightWidth, 67);
  // 左栏 + 1 格间距 + 右栏恰好占满内容宽度，列位置因此与调用方的列头一致。
  assert.equal(layout.leftWidth + 1 + layout.rightWidth, layout.contentWidth);
});

test("compactRowWidth never truncates the left column to fit the right one", () => {
  const layout = compactRowWidth(40, 2, "very long label");
  assert.equal(layout.leftWidth, 15);
  assert.equal(layout.rightWidth, 22);
});

test("compactRowWidth drops the right column when only one cell is left", () => {
  const layout = compactRowWidth(12, 2, "1  Tool   ");
  assert.equal(layout.showRight, false);
  assert.equal(layout.rightWidth, 0);
  assert.equal(layout.leftWidth, 9);
});
