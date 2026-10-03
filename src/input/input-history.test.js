import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendInputHistory,
  InputHistory,
  loadInputHistory,
  MAX_INPUT_HISTORY,
} from "./input-history.js";

function snapshot(value, { cursor = [...value].length, pastes = new Map(), nextPasteId = 1 } = {}) {
  return { value, cursor, pastes, nextPasteId };
}

test("browsing history up and down restores the exact current draft", () => {
  const history = new InputHistory([snapshot("older"), snapshot("newer")]);
  const draft = snapshot("draft", { cursor: 2 });

  assert.deepEqual(history.previous(draft), snapshot("newer", { cursor: 0 }));
  assert.deepEqual(history.previous(draft), snapshot("older", { cursor: 0 }));
  assert.deepEqual(history.previous(draft), snapshot("older", { cursor: 0 }));
  assert.deepEqual(history.next(), snapshot("newer"));
  assert.deepEqual(history.next(), draft);
  assert.equal(history.next(), null);
});

test("isBrowsing is true while parked on a recalled entry and clears when the text changes or the cursor moves", () => {
  const history = new InputHistory([snapshot("/model"), snapshot("hello")]);

  // 未开始浏览时恒为假，命令候选正常工作。
  assert.equal(history.isBrowsing("/model", 0), false);

  // 回填 "hello" 后停在行首，处于浏览态。
  const first = history.previous(snapshot(""));
  assert.equal(first.value, "hello");
  assert.equal(history.isBrowsing(first.value, first.cursor), true);

  // 继续上翻拿到 "/model"，仍为浏览态，因此不会重新弹出命令列表。
  const second = history.previous(snapshot(""));
  assert.equal(second.value, "/model");
  assert.equal(history.isBrowsing(second.value, second.cursor), true);
  // 行尾同样算浏览态（对齐 next 回填到行尾的行为）。
  assert.equal(history.isBrowsing("/model", 6), true);

  // 用户改动文本后自动失效，无需手动重置。
  assert.equal(history.isBrowsing("/mode", 0), false);
  // 光标移到中间也失效。
  assert.equal(history.isBrowsing("/model", 3), false);

  // 提交后重置，浏览态一并清除。
  history.record(snapshot("/model"));
  assert.equal(history.isBrowsing("/model", 0), false);
});

test("history keeps the paste registry and returns snapshots that share nothing with its internals", () => {
  const pastes = new Map([[3, "first\nsecond"]]);
  const history = new InputHistory();
  assert.equal(
    history.record(snapshot("[Pasted text #3 +1 lines]", { pastes, nextPasteId: 4 })),
    true
  );
  pastes.set(3, "changed");

  const recalled = history.previous(snapshot(""));
  assert.equal(recalled.pastes.get(3), "first\nsecond");
  assert.equal(recalled.nextPasteId, 4);
  recalled.pastes.set(3, "mutated recall");
  assert.equal(history.previous(snapshot("")).pastes.get(3), "first\nsecond");
});

test("ignores empty input and adjacent duplicates and caps the list at 100 entries", () => {
  const history = new InputHistory();
  assert.equal(history.record(snapshot("   ")), false);
  assert.equal(history.record(snapshot("same")), true);
  assert.equal(history.record(snapshot("same")), false);
  for (let index = 0; index < MAX_INPUT_HISTORY + 5; index++) {
    history.record(snapshot(`item ${index}`));
  }
  assert.equal(history.entries.length, MAX_INPUT_HISTORY);
  assert.equal(history.entries[0].value, "item 5");
});

test("a failing persist callback does not affect in-memory history", () => {
  const history = new InputHistory([], { onRecord: () => { throw new Error("disk failed"); } });
  assert.equal(history.record(snapshot("kept")), true);
  assert.equal(history.entries.at(-1).value, "kept");
});

test("JSONL loads per cwd, skips corrupt lines, and keeps pasted content", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-input-history-"));
  const file = path.join(dir, "history.jsonl");
  const first = snapshot("one", { pastes: new Map([[1, "a\nb"]]), nextPasteId: 2 });

  assert.equal(appendInputHistory(first, { cwd: "/workspace/a", file }), true);
  assert.equal(appendInputHistory(snapshot("other"), { cwd: "/workspace/b", file }), true);
  appendFileSync(file, "not-json\n", "utf8");
  const loaded = loadInputHistory({ cwd: "/workspace/a", file });

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].value, "one");
  assert.equal(loaded[0].pastes.get(1), "a\nb");
  assert.equal(loaded[0].nextPasteId, 2);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);
});

test("an oversized history entry is not written to disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-input-history-large-"));
  const file = path.join(dir, "history.jsonl");
  const huge = snapshot("[Pasted text #1 300000 chars]", {
    pastes: new Map([[1, "x".repeat(300_000)]]),
  });
  assert.equal(appendInputHistory(huge, { cwd: "/workspace", file }), false);
  assert.deepEqual(loadInputHistory({ cwd: "/workspace", file }), []);
});
