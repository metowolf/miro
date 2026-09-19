import assert from "node:assert/strict";
import test from "node:test";

import {
  PASTE_MAX_CHARS,
  countPastedLines,
  cursorColumn,
  deleteAfterCursor,
  deleteBeforeCursor,
  expandPasteMarkers,
  findPasteMarkers,
  formatPasteMarker,
  insertPastedText,
  normalizePastedText,
  pruneOrphanPastes,
  segmentInput,
  shouldCollapsePaste,
  stepCursor,
} from "./paste-block.js";

function paste(text, { chars = [], cursor = 0, pastes = new Map(), nextId = 1 } = {}) {
  return insertPastedText({ chars, cursor, pastes, nextId, text });
}

test("normalizePastedText strips ANSI, normalizes newlines and expands tabs", () => {
  assert.equal(normalizePastedText("\u001B[31mred\u001B[0m"), "red");
  assert.equal(normalizePastedText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(normalizePastedText("a\tb"), "a    b");
  assert.equal(normalizePastedText("a\u0007b\u007Fc"), "abc");
  assert.equal(normalizePastedText("héllo 🌟"), "héllo 🌟");
});

test("countPastedLines counts newlines", () => {
  assert.equal(countPastedLines("line1\nline2\nline3"), 2);
  assert.equal(countPastedLines("single"), 0);
});

test("shouldCollapsePaste triggers on any newline or on long text", () => {
  assert.equal(shouldCollapsePaste("one line"), false);
  assert.equal(shouldCollapsePaste("two\nlines"), true);
  assert.equal(shouldCollapsePaste("x".repeat(PASTE_MAX_CHARS)), false);
  assert.equal(shouldCollapsePaste("x".repeat(PASTE_MAX_CHARS + 1)), true);
});

test("formatPasteMarker shows lines for multiline and chars for long single line", () => {
  assert.equal(formatPasteMarker(1, "a\nb\nc"), "[Pasted text #1 +2 lines]");
  assert.equal(formatPasteMarker(2, "x".repeat(1500)), "[Pasted text #2 1500 chars]");
});

test("small paste is inlined instead of collapsed", () => {
  const result = paste("just a short paste");
  assert.equal(result.chars.join(""), "just a short paste");
  assert.equal(result.id, null);
  assert.equal(result.pastes.size, 0);
});

test("large paste becomes a single marker and keeps the original text", () => {
  const body = "line1\nline2\nline3";
  const result = paste(body);
  assert.equal(result.chars.join(""), "[Pasted text #1 +2 lines]");
  assert.equal(result.id, 1);
  assert.equal(result.pastes.get(1), body);
  assert.equal(expandPasteMarkers(result.chars.join(""), result.pastes), body);
});

test("paste inserts at the cursor and keeps surrounding text", () => {
  const result = paste("a\nb", { chars: [..."fix "], cursor: 4 });
  assert.equal(result.chars.join(""), "fix [Pasted text #1 +1 lines]");

  const middle = insertPastedText({
    chars: [..."fix  please"],
    cursor: 4,
    pastes: new Map(),
    nextId: 3,
    text: "a\nb",
  });
  assert.equal(middle.chars.join(""), "fix [Pasted text #3 +1 lines] please");
  assert.equal(middle.cursor, "fix [Pasted text #3 +1 lines]".length);
});

test("empty paste is ignored", () => {
  assert.equal(paste(""), null);
  assert.equal(paste("\u0007"), null);
});

test("expandPasteMarkers handles multiple blocks and preserves order", () => {
  const first = paste("A1\nA2");
  const second = insertPastedText({
    chars: [...first.chars, ..." and "],
    cursor: first.chars.length + 5,
    pastes: first.pastes,
    nextId: 2,
    text: "B1\nB2",
  });
  const text = second.chars.join("");
  assert.equal(text, "[Pasted text #1 +1 lines] and [Pasted text #2 +1 lines]");
  assert.equal(expandPasteMarkers(text, second.pastes), "A1\nA2 and B1\nB2");
});

test("only registered ids are treated as markers", () => {
  const typed = "[Pasted text #9 +3 lines]";
  assert.deepEqual(findPasteMarkers(typed, new Map()), []);
  assert.equal(expandPasteMarkers(typed, new Map()), typed);
});

test("marker-looking text inside pasted content is not expanded twice", () => {
  const body = "docs say [Pasted text #1 +1 lines]\nsecond line";
  const result = paste(body);
  assert.equal(expandPasteMarkers(result.chars.join(""), result.pastes), body);
});

test("marker offsets are code point based so CJK prefixes stay aligned", () => {
  const result = paste("a\nb", { chars: [..."中文🌟"], cursor: 3 });
  const markers = findPasteMarkers(result.chars.join(""), result.pastes);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].start, 3);
  assert.equal(markers[0].index, 4);
  assert.equal(markers[0].end, result.chars.length);
});

test("cursor steps over a marker atomically", () => {
  const result = paste("a\nb", { chars: [..."hi "], cursor: 3 });
  const chars = result.chars;
  const end = chars.length;
  const start = 3;
  assert.equal(stepCursor(chars, end, -1, result.pastes), start);
  assert.equal(stepCursor(chars, start, 1, result.pastes), end);
  assert.equal(stepCursor(chars, 2, -1, result.pastes), 1);
  assert.equal(stepCursor(chars, 0, -1, result.pastes), 0);
  assert.equal(stepCursor(chars, end, 1, result.pastes), end);
});

test("backspace deletes the whole block at once", () => {
  const result = paste("a\nb", { chars: [..."hi "], cursor: 3 });
  const deleted = deleteBeforeCursor(result.chars, result.chars.length, result.pastes);
  assert.equal(deleted.chars.join(""), "hi ");
  assert.equal(deleted.cursor, 3);
  assert.equal(pruneOrphanPastes(deleted.chars.join(""), result.pastes).size, 0);
});

test("backspace outside a block still deletes one code point", () => {
  const chars = [..."hi🌟"];
  const deleted = deleteBeforeCursor(chars, chars.length, new Map());
  assert.equal(deleted.chars.join(""), "hi");
  assert.equal(deleteBeforeCursor(chars, 0, new Map()), null);
});

test("delete key removes the whole block when the cursor sits at its start", () => {
  const result = paste("a\nb", { chars: [..."hi "], cursor: 3 });
  const deleted = deleteAfterCursor(result.chars, 3, result.pastes);
  assert.equal(deleted.chars.join(""), "hi ");
  assert.equal(deleted.cursor, 3);
  assert.equal(deleteAfterCursor(result.chars, result.chars.length, result.pastes), null);
});

test("pruneOrphanPastes keeps live blocks and drops removed ones", () => {
  const first = paste("A1\nA2");
  const second = insertPastedText({
    chars: first.chars,
    cursor: first.chars.length,
    pastes: first.pastes,
    nextId: 2,
    text: "B1\nB2",
  });
  assert.equal(second.pastes.size, 2);
  const kept = pruneOrphanPastes("[Pasted text #2 +1 lines]", second.pastes);
  assert.deepEqual([...kept.keys()], [2]);
});

test("segmentInput marks the block as one highlighted unit", () => {
  const result = paste("a\nb", { chars: [..."hi "], cursor: 3 });
  const segments = segmentInput(result.chars, result.chars.length, result.pastes);
  assert.deepEqual(
    segments.map((s) => [s.text, s.marker, s.cursor]),
    [
      ["hi ", false, false],
      ["[Pasted text #1 +1 lines]", true, false],
      [" ", false, true],
    ]
  );
});

test("segmentInput inverses the entire block when the cursor is inside it", () => {
  const result = paste("a\nb", { chars: [..."hi "], cursor: 3 });
  const segments = segmentInput(result.chars, 3, result.pastes);
  const block = segments.find((s) => s.marker);
  assert.equal(block.text, "[Pasted text #1 +1 lines]");
  assert.equal(block.cursor, true);
  assert.equal(segments.filter((s) => s.cursor).length, 1);
});

test("segmentInput handles plain text without blocks", () => {
  assert.deepEqual(
    segmentInput([..."ab"], 1, new Map()).map((s) => [s.text, s.cursor]),
    [
      ["a", false],
      ["b", true],
    ]
  );
  assert.deepEqual(
    segmentInput([], 0, new Map()).map((s) => [s.text, s.cursor]),
    [[" ", true]]
  );
});

test("cursorColumn measures by cell width, not by string length", () => {
  const segments = segmentInput([..."你好"], 2, new Map());
  assert.equal(cursorColumn(segments), 4);
  assert.equal(cursorColumn(segmentInput([..."a😀b"], 2, new Map())), 3);
});

test("cursorColumn marks the caret cell and the end-of-input cell alike", () => {
  assert.equal(cursorColumn(segmentInput([..."ab"], 1, new Map())), 1);
  // 末尾的占位空格段宽度为 0，光标落在正文后一列。
  assert.equal(cursorColumn(segmentInput([..."ab"], 2, new Map())), 2);
  assert.equal(cursorColumn(segmentInput([], 0, new Map())), 0);
});

test("cursorColumn sits after the marker so it matches the inverted block", () => {
  const result = paste("a\nb", { chars: [..."hi "], cursor: 3 });
  const segments = segmentInput(result.chars, 3, result.pastes);
  assert.equal(cursorColumn(segments), 3 + "[Pasted text #1 +1 lines]".length);
});
