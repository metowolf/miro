import assert from "node:assert/strict";
import test from "node:test";

import { composerHasDraft, inputHint } from "./input-hint.ts";

test("仅运行中且有草稿时替代状态栏", () => {
  for (const busy of [false, true]) {
    for (const hasDraft of [false, true]) {
      const hint = inputHint({ busy, hasDraft, canSteer: true });
      assert.equal(hint != null, busy && hasDraft);
    }
  }
});

test("提示按 steering 能力选择 Enter/Tab 操作，并始终包含队列快捷键", () => {
  assert.equal(
    inputHint({ busy: true, hasDraft: true, canSteer: true }),
    "Enter to steer · Tab to queue · Ctrl+Q to review queue",
  );
  assert.equal(
    inputHint({ busy: true, hasDraft: true, canSteer: false }),
    "Enter/Tab to queue · steering unavailable · Ctrl+Q to review queue",
  );
});

test("合并行显示队列数量及暂停状态", () => {
  const state = { busy: true, hasDraft: true, canSteer: true };
  assert.ok(inputHint({ ...state, queuedCount: 1 }).endsWith(" · 1 message queued"));
  assert.ok(inputHint({ ...state, queuedCount: 2, queuePaused: true }).endsWith(" · 2 messages queued · paused"));
  assert.equal(inputHint({ ...state, queuedCount: 0, queuePaused: true }), inputHint(state));
});

test("草稿判定兼容空白、粘贴块和恢复快照", () => {
  assert.equal(composerHasDraft(null), false);
  assert.equal(composerHasDraft({ value: "", pastes: new Map<any, any>() }), false);
  assert.equal(composerHasDraft({ value: " " }), true);
  assert.equal(composerHasDraft({ value: "恢复的草稿", pastes: new Map<any, any>() }), true);
  assert.equal(composerHasDraft({ value: "", pastes: new Map<any, any>([[1, "粘贴内容"]]) }), true);
});

test("输入、清空与恢复快照会切换提示，运行结束后恢复状态栏", () => {
  const hint = (snapshot, busy = true) => inputHint({ busy, hasDraft: composerHasDraft(snapshot), canSteer: true });
  assert.equal(hint({ value: "" }), null);
  assert.ok(hint({ value: "继续" }));
  assert.equal(hint({ value: "", pastes: new Map<any, any>() }), null);
  assert.ok(hint({ value: "历史草稿" }));
  assert.equal(hint({ value: "历史草稿" }, false), null);
});
