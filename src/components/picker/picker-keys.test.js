import assert from "node:assert/strict";
import test from "node:test";

import { footerHint, pickerAction, sanitizeInput } from "./picker-keys.js";

const NO_KEY = {};

test("sanitizeInput strips newlines and control characters", () => {
  assert.equal(sanitizeInput("ab\r\ncd"), "abcd");
  assert.equal(sanitizeInput("a\u0000b\u007F"), "ab");
  assert.equal(sanitizeInput(null), "");
});

test("Esc cancels without a query and clears the query first with one", () => {
  assert.deepEqual(pickerAction("", { escape: true }, { hasQuery: false }), { type: "cancel" });
  assert.deepEqual(pickerAction("", { escape: true }, { hasQuery: true }), { type: "clear-query" });
});

test("Enter confirms and the arrow keys move", () => {
  assert.deepEqual(pickerAction("", { return: true }), { type: "confirm" });
  assert.deepEqual(pickerAction("", { upArrow: true }), { type: "move", delta: -1 });
  assert.deepEqual(pickerAction("", { downArrow: true }), { type: "move", delta: 1 });
});

test("j/k enter the query instead of navigating when searchable", () => {
  assert.deepEqual(pickerAction("j", NO_KEY, { searchable: true }), { type: "append", text: "j" });
  assert.deepEqual(pickerAction("k", NO_KEY, { searchable: true }), { type: "append", text: "k" });
});

test("j/k bind to up/down movement when not searchable", () => {
  assert.deepEqual(pickerAction("k", NO_KEY, { searchable: false }), { type: "move", delta: -1 });
  assert.deepEqual(pickerAction("j", NO_KEY, { searchable: false }), { type: "move", delta: 1 });
});

test("plain characters are ignored when not searchable", () => {
  assert.deepEqual(pickerAction("x", NO_KEY, { searchable: false }), { type: "none" });
});

test("Backspace deletes a character and only applies when searchable", () => {
  assert.deepEqual(pickerAction("", { backspace: true }, { searchable: true }), { type: "backspace" });
  assert.deepEqual(pickerAction("", { delete: true }, { searchable: true }), { type: "backspace" });
  assert.deepEqual(pickerAction("", { backspace: true }, { searchable: false }), { type: "none" });
});

test("Ctrl/Meta/Tab/paging/Home/End never enter the query", () => {
  for (const key of [
    { ctrl: true },
    { meta: true },
    { tab: true },
    { pageUp: true },
    { pageDown: true },
    { leftArrow: true },
    { rightArrow: true },
    { home: true },
    { end: true },
  ]) {
    assert.deepEqual(pickerAction("a", key, { searchable: true }), { type: "none" });
  }
});

test("a pasted multi-character chunk is appended as a whole", () => {
  assert.deepEqual(pickerAction("sonnet", NO_KEY, { searchable: true }), {
    type: "append",
    text: "sonnet",
  });
});

test("footerHint follows capabilities and omits the search entry when unsupported", () => {
  const searchable = footerHint({ searchable: true });
  assert.match(searchable, /Type to filter/);
  assert.match(searchable, /Enter to confirm/);
  assert.doesNotMatch(footerHint({ searchable: false }), /Type to filter/);
});

test("footerHint swaps cancel for go back when going back is possible", () => {
  assert.match(footerHint({ canGoBack: true }), /Esc to go back/);
  assert.doesNotMatch(footerHint({ canGoBack: true }), /Esc to cancel/);
  assert.match(footerHint({ canGoBack: false }), /Esc to cancel/);
});
