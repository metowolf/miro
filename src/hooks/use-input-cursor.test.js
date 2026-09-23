import assert from "node:assert/strict";
import test from "node:test";

import { caretPosition } from "./use-input-cursor.js";

test("caretPosition adds the measured origin to the column", () => {
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 40 }, 6), { x: 8, y: 4 });
});

test("caretPosition follows the text onto the wrapped row", () => {
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 10 }, 10), { x: 2, y: 5 });
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 10 }, 23), { x: 5, y: 6 });
});

test("caretPosition wraps CJK by terminal cells instead of code points", () => {
  // 宽度为奇数时，第二个汉字不能塞进首行剩余的一格；每行都必须重新对齐。
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 5 }, 0, { text: "中文中文" }), { x: 6, y: 5 });
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 5 }, 0, { text: "中文中文中文" }), { x: 6, y: 6 });
});

test("caretPosition follows explicit newlines", () => {
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 10 }, 0, { text: "ab\ncd" }), { x: 4, y: 5 });
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 10 }, 0, { text: "a\n\nb" }), { x: 3, y: 6 });
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 3 }, 0, { text: "abc\nd" }), { x: 3, y: 6 });
});

test("caretPosition degrades to a plain offset when the width is unknown", () => {
  assert.deepEqual(caretPosition({ x: 0, y: 0, width: 0 }, 3), { x: 3, y: 0 });
});

test("caretPosition clamps instead of wrapping on a truncating line", () => {
  assert.deepEqual(caretPosition({ x: 2, y: 1, width: 10 }, 12, { truncate: true }), { x: 12, y: 1 });
  assert.deepEqual(caretPosition({ x: 2, y: 1, width: 10 }, 4, { truncate: true }), { x: 6, y: 1 });
});

test("caretPosition shifts by rowOffset for a fullscreen frame", () => {
  // 整屏帧里 Ink 的锚点基数差一行，调用方用 rowOffset 补回来（含折行与截断两条路径）。
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 40 }, 6, { rowOffset: 1 }), { x: 8, y: 5 });
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 10 }, 23, { rowOffset: 1 }), { x: 5, y: 7 });
  assert.deepEqual(caretPosition({ x: 2, y: 1, width: 10 }, 12, { truncate: true, rowOffset: 1 }), { x: 12, y: 2 });
  assert.deepEqual(caretPosition({ x: 0, y: 0, width: 0 }, 3, { rowOffset: 1 }), { x: 3, y: 1 });
});
