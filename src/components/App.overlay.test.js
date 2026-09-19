/**
 * Ctrl+C 取消 overlay 的两个形状。
 *
 * picker 与各面板用 resolve(escapeValue) 收尾，InputPrompt 那一类（oauth / export /
 * review / simplify / commit 的文本输入）只有 onSubmit / onCancel。早前统一调
 * resolve，后者会抛 TypeError——登录输入框上按 Ctrl+C 直接炸，而不是取消。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cancelOverlay } from "./App.jsx";

test("picker 型 overlay 走 resolve(escapeValue)", () => {
  const seen = [];
  cancelOverlay({ kind: "model", escapeValue: null, resolve: (value) => seen.push(value) });
  assert.deepEqual(seen, [null]);
});

test("InputPrompt 型 overlay 走 onCancel", () => {
  let cancelled = 0;
  cancelOverlay({ kind: "oauth-input", onSubmit: () => {}, onCancel: () => { cancelled += 1; } });
  assert.equal(cancelled, 1);
});

test("没有 overlay 时是空操作", () => {
  assert.equal(cancelOverlay(null), undefined);
});
