import assert from "node:assert/strict";
import test from "node:test";

import { caretPosition } from "./use-input-cursor.ts";

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

test("caretPosition matches Ink's word wrap for mixed CJK and Latin text", () => {
  // Ink 按单词折行：放不下的英文单词整体换到下一行，行尾留空，字符级模拟会漂移。
  const fullText = "中文 hello world";
  // "中文 hello " 占 11 格，"world" 放不进宽 12 的首行，被整体折到第二行。
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 12 }, 0, { text: fullText, fullText }), { x: 7, y: 5 });
  // 光标停在 "wor" 后面：后面的字符决定了这个单词已经被折走。
  const text = "中文 hello wor";
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 12 }, 0, { text, fullText }), { x: 5, y: 5 });
  // 光标在被折走的单词开头时也跟到下一行行首。
  assert.deepEqual(caretPosition({ x: 2, y: 4, width: 12 }, 0, { text: "中文 hello ", fullText }), { x: 2, y: 5 });
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
