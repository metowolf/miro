import assert from "node:assert/strict";
import test from "node:test";

import { assemblyFingerprint, toolContextStats } from "./request-diagnostics.js";

test("assembly fingerprint ignores history and canonicalizes object keys", () => {
  const toolsA = [{ function: { name: "read", parameters: { type: "object", properties: { b: {}, a: {} } } } }];
  const toolsB = [{ function: { parameters: { properties: { a: {}, b: {} }, type: "object" }, name: "read" } }];
  const first = assemblyFingerprint([
    { role: "system", content: "stable" },
    { role: "user", content: "one" },
  ], toolsA);
  const second = assemblyFingerprint([
    { role: "system", content: "stable" },
    { role: "user", content: "different history" },
  ], toolsB);

  assert.equal(first.hash, second.hash);
  assert.notEqual(assemblyFingerprint([{ role: "system", content: "changed" }], toolsA).hash, first.hash);
  assert.notEqual(assemblyFingerprint([{ role: "system", content: "stable" }], [...toolsA, toolsA[0]]).hash, first.hash);
});

test("tool context stats attributes bytes without returning content", () => {
  const stats = toolContextStats([
    {
      role: "assistant",
      tool_calls: [
        { id: "a", function: { name: "read_file" } },
        { id: "b", function: { name: "grep" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "12345" },
    { role: "tool", tool_call_id: "b", content: "123" },
    { role: "tool", tool_call_id: "missing", content: "12" },
  ]);

  assert.equal(stats.totalBytes, 10);
  assert.deepEqual(stats.byTool, [
    { name: "read_file", bytes: 5 },
    { name: "grep", bytes: 3 },
    { name: "unknown", bytes: 2 },
  ]);
  assert.deepEqual(stats.largest, { name: "read_file", toolCallId: "a", bytes: 5 });
  assert.equal(JSON.stringify(stats).includes("12345"), false);
});
