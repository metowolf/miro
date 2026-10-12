import assert from "node:assert/strict";
import test from "node:test";
import { setRecorder, useStore } from "./store.ts";

test("嵌套工具父子身份保留到定稿、记录和恢复，更新不需要重复父 id", () => {
  const recorded = [];
  useStore.getState().clearTranscript();
  setRecorder({ recordBlock: (block) => recorded.push(structuredClone(block)) });
  try {
    useStore.getState().upsertTool({ toolCallId: "code/nested-1", parentToolCallId: "code", name: "read_file", title: "Read", toolKind: "read", rawInput: { path: "a" }, status: "pending" });
    assert.equal(useStore.getState().activeTools[0].raw.parentToolCallId, "code");
    useStore.getState().upsertTool({ toolCallId: "code/nested-1", status: "completed" });
    useStore.getState().endTurn();
    const saved = recorded.find((entry) => entry.role === "tool");
    assert.equal(saved.tool.parentToolCallId, "code");
    assert.equal(saved.tool.toolCallId, "code/nested-1");
    assert.equal(saved.tool.reviewItems[0].parentToolCallId, "code");
    useStore.getState().clearTranscript();
    useStore.getState().hydrate([saved]);
    assert.equal(useStore.getState().blocks.find((entry) => entry.role === "tool").tool.parentToolCallId, "code");
  } finally {
    setRecorder(null);
    useStore.getState().clearTranscript();
  }
});
