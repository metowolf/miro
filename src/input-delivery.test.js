import assert from "node:assert/strict";
import test from "node:test";
import { recoverInputDelivery, submissionIntent } from "./input-delivery.js";

test("Tab queues only while busy, preserving completion, mode switching and shell completion", () => {
  assert.equal(submissionIntent({ tab: true, busy: true }), "queue");
  for (const flags of [{ completion: true }, { shift: true }, { bash: true }, { busy: false }, { tab: false }]) {
    assert.equal(submissionIntent({ tab: true, busy: true, ...flags }), null);
  }
});

test("recovery reconciles stale UI checkpoints and retains only unapplied steering", () => {
  const applied = { id: "done", text: "expanded guidance", display: "guidance" };
  const pending = { id: "waiting", text: "next", display: null };
  const state = { composer: {}, pendingInputs: [applied, pending], queuedInputs: [{ text: "later", display: null }] };
  const recovered = recoverInputDelivery(state, [applied], []);
  assert.deepEqual(recovered.uiState.pendingInputs, []);
  assert.equal(recovered.uiState.queuePaused, true);
  assert.deepEqual(recovered.uiState.queuedInputs, [pending, { text: "later", display: null }]);
  assert.deepEqual(recovered.blocks.map((block) => [block.inputId, block.text]), [["done", "guidance"]]);
  const replay = recoverInputDelivery(recovered.uiState, [applied], recovered.blocks);
  assert.deepEqual(replay, recovered);
});

test("committed messages are not recovered as queued input, including after compaction", () => {
  const input = { id: "s", text: "guidance", display: null };
  const block = { role: "user", inputId: "s", text: "guidance" };
  const recovered = recoverInputDelivery({ queuedInputs: [input], pendingInputs: [input] }, [input], [block]);
  assert.deepEqual(recovered.blocks, [block]);
  assert.deepEqual(recovered.uiState.queuedInputs, []);
  assert.deepEqual(recovered.uiState.pendingInputs, []);
  assert.equal(recovered.uiState.queuePaused, undefined);
});

test("a transcript receipt reconciles queued input without a provider context checkpoint", () => {
  const input = { id: "queued", text: "next", display: null };
  const block = { role: "user", inputId: "queued", text: "next" };
  const result = recoverInputDelivery({ queuedInputs: [input], queuePaused: true }, [], [block]);
  assert.deepEqual(result.uiState.queuedInputs, []);
  assert.equal(result.uiState.queuePaused, false);
  assert.deepEqual(result.blocks, [block]);
});
