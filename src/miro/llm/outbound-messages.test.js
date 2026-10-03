import assert from "node:assert/strict";
import test from "node:test";

import { SYNTHETIC_TOOL_RESULT, normalizeOutboundMessages } from "./outbound-messages.js";

function assistant(...calls) {
  return {
    role: "assistant",
    content: "",
    tool_calls: calls.map(([id, name]) => ({ id, function: { name, arguments: "{}" } })),
  };
}

test("normalizes tool results to declaration order without mutating input", () => {
  const input = [
    assistant(["a", "read_file"], ["b", "grep"]),
    { role: "tool", tool_call_id: "b", content: "second" },
    { role: "tool", tool_call_id: "orphan", content: "drop" },
    { role: "tool", tool_call_id: "a", content: "first" },
    { role: "tool", tool_call_id: "a", content: "duplicate" },
    { role: "user", content: "continue" },
  ];
  const snapshot = structuredClone(input);
  const output = normalizeOutboundMessages(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(output.slice(1, 3).map((message) => message.tool_call_id), ["a", "b"]);
  assert.deepEqual(output.slice(1, 3).map((message) => message.content), ["first", "second"]);
  assert.equal(output.some((message) => message.tool_call_id === "orphan"), false);
  assert.equal(output.at(-1).role, "user");
});

test("adds one explicit result for a missing tool call and drops standalone tool results", () => {
  const output = normalizeOutboundMessages([
    { role: "tool", tool_call_id: "old", content: "orphan" },
    assistant(["a", "read_file"]),
    { role: "user", content: "next" },
  ]);

  assert.equal(output[0].role, "assistant");
  assert.deepEqual(output[1], {
    role: "tool",
    tool_call_id: "a",
    content: SYNTHETIC_TOOL_RESULT,
    miro_synthetic: true,
  });
  assert.equal(output[2].role, "user");
});
