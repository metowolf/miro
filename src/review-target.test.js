import assert from "node:assert/strict";
import test from "node:test";

import { findReviewTarget, reviewEntries } from "./review-target.js";

const THOUGHT_BLOCK = {
  role: "thought",
  text: "Thought · 3s",
  thought: { durationMs: 3000, text: "private detail" },
};

const TOOL_BLOCK = {
  role: "tool",
  tool: {
    label: { name: "Read", args: "src/app.js" },
    status: "completed",
    reviewItems: [{ label: { name: "Read", args: "src/app.js" }, detail: { output: "ok" } }],
  },
};

function state(overrides = {}) {
  return { overlay: null, bashCard: null, thought: null, pendingToolGroup: null, blocks: [], ...overrides };
}

test("an open review screen makes ctrl+o a close key", () => {
  assert.deepEqual(findReviewTarget(state({ overlay: { kind: "tool-review" } })), { kind: "close" });
  assert.deepEqual(findReviewTarget(state({ overlay: { kind: "thought-review" } })), { kind: "close" });
  assert.deepEqual(findReviewTarget(state({ overlay: { kind: "review-browser" } })), { kind: "close" });
});

test("an unrelated overlay swallows ctrl+o", () => {
  const current = state({ overlay: { kind: "model" }, blocks: [TOOL_BLOCK] });
  assert.equal(findReviewTarget(current), null);
});

test("a live source is browsed in the window, never expanded in place", () => {
  const current = state({
    bashCard: { status: "done", command: "ls", lines: [{ text: "a", err: false }] },
    thought: { text: "thinking" },
    blocks: [TOOL_BLOCK],
  });
  const target = findReviewTarget(current);
  assert.equal(target.kind, "review");
  assert.deepEqual(target.entries.map((entry) => entry.kind), ["tool", "thought", "bash"]);
  assert.equal(target.entries[target.index].card.command, "ls", "the shell card starts selected");
  assert.equal(target.live, true);
});

test("the live thought is appended after history and stays selected", () => {
  const current = state({ thought: { text: "thinking" }, blocks: [TOOL_BLOCK] });
  const target = findReviewTarget(current);
  assert.equal(target.kind, "review");
  assert.deepEqual(target.entries.map((entry) => entry.kind), ["tool", "thought"]);
  assert.equal(target.entries[target.index].thought.text, "thinking");
  assert.equal(target.live, true);
});

test("a running shell card is not reviewable yet", () => {
  const current = state({ bashCard: { status: "running" }, blocks: [TOOL_BLOCK] });
  const target = findReviewTarget(current);
  assert.deepEqual(target.entries.map((entry) => entry.kind), ["tool"]);
  assert.equal(target.live, false, "only retained content advertises itself");
});

test("an empty live thought falls through to history", () => {
  const current = state({ thought: { text: "  " }, blocks: [THOUGHT_BLOCK] });
  assert.equal(findReviewTarget(current).kind, "review");
});

test("finalized shell cards stay browsable after they leave the activity area", () => {
  const entries = reviewEntries({
    blocks: [{ role: "bashCard", id: "card-1", card: { command: "git status", lines: [], hidden: 3 } }],
  });
  assert.deepEqual(entries.map((entry) => entry.kind), ["bash"]);
  assert.equal(entries[0].card.hidden, 3);
  assert.equal(entries[0].live, undefined, "history is reachable but never advertises itself");
});

test("all historical review entries are reachable and the latest starts selected", () => {
  const current = state({ blocks: [THOUGHT_BLOCK, TOOL_BLOCK] });
  const target = findReviewTarget(current);
  assert.equal(target.kind, "review");
  assert.deepEqual(target.entries.map((entry) => entry.kind), ["thought", "tool"]);
  assert.equal(target.index, 1);
  assert.equal(target.live, false, "history is reachable but never advertises itself");
});

test("a pending tool group wins over a trailing thought", () => {
  const current = state({
    blocks: [THOUGHT_BLOCK],
    pendingToolGroup: {
      startedAt: 0,
      items: [
        { label: { name: "Read", args: "a.js" }, status: "completed", detail: { output: "a" } },
        { label: { name: "Read", args: "b.js" }, status: "completed", detail: { output: "b" } },
      ],
    },
  });
  const target = findReviewTarget(current);
  assert.equal(target.kind, "review");
  assert.equal(target.live, true);
  assert.deepEqual(target.entries.map((entry) => entry.kind), ["thought", "tool", "tool"]);
  assert.equal(target.entries[target.index].item.label.args, "b.js");
});

test("reviewEntries flattens every tool call without losing transcript order", () => {
  const entries = reviewEntries({
    blocks: [
      TOOL_BLOCK,
      THOUGHT_BLOCK,
      { ...TOOL_BLOCK, id: "second" },
    ],
  });
  assert.deepEqual(entries.map((entry) => entry.kind), ["tool", "thought", "tool"]);
});

test("subagent tool is exposed as a dedicated review entry", () => {
  const entries = reviewEntries({
    blocks: [{
      role: "tool",
      id: "sub-1",
      tool: {
        reviewItems: [{
          label: { name: "worker-1", args: "inspect files" },
          subagent: { request: { message: "inspect files" }, text: "done" },
        }],
      },
    }],
  });
  assert.equal(entries[0].kind, "subagent");
  assert.equal(entries[0].item.subagent.text, "done");
});

test("history without review content offers nothing", () => {
  const current = state({
    blocks: [
      { role: "assistant", text: "done" },
      { role: "thought", text: "Thought · 1s", thought: { text: "" } },
      { role: "tool", tool: { label: { name: "Read" }, reviewItems: [] } },
    ],
  });
  assert.equal(findReviewTarget(current), null);
});
