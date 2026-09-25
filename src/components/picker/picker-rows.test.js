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
  truncatePathToCellWidth,
  truncateToCellWidth,
} from "./picker-rows.js";
import { stringWidth } from "../../markdown-width.js";

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

test("路径优先省略父目录，保留文件名、扩展名和目录尾斜线", () => {
  const source = "src/components/picker/picker-rows.test.js";
  const shown = truncatePathToCellWidth(source, 30);
  assert.ok(shown.startsWith("src/"));
  assert.ok(shown.endsWith("/picker-rows.test.js"));
  assert.equal(stringWidth(shown), 30);
  assert.equal(truncatePathToCellWidth("src/a.js", 20), "src/a.js");
  assert.equal(truncatePathToCellWidth("src/components/", 12), "…components/");
  const longName = truncatePathToCellWidth("extremely-long-component-name.test.js", 20);
  assert.ok(longName.startsWith("ext"));
  assert.ok(longName.endsWith(".test.js"));
});

test("路径省略按终端格宽而非字符数裁剪，不切开 CJK 或 emoji 字素", () => {
  const paths = [
    "配置/组件/选择器.test.js",
    "src/👩‍💻👩‍💻👩‍💻.js",
    "src/e\u0301e\u0301e\u0301e\u0301.js",
    "very-long-directory/nested/",
  ];
  for (const source of paths) {
    for (let width = 0; width <= 40; width += 1) {
      const shown = truncatePathToCellWidth(source, width);
      assert.ok(stringWidth(shown) <= width);
      assert.doesNotMatch(shown, /^\p{M}|\u200d…|…\u200d/u);
      assert.doesNotMatch(shown.replaceAll("👩‍💻", ""), /👩|💻/u);
    }
  }
  assert.equal(truncatePathToCellWidth("abc", 0), "");
  assert.equal(truncatePathToCellWidth("abc", 1), "…");
});

test("路径中的换行和控制字符只在展示时转义", () => {
  assert.equal(truncatePathToCellWidth("dir/a\nb\tc.js", 40), "dir/a\\nb\\tc.js");
  assert.doesNotMatch(truncatePathToCellWidth("dir/a\u001b[31m.js", 40), /\u001b/);
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
