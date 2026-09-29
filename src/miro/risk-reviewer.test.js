import assert from "node:assert/strict";
import test from "node:test";

import { projectReviewTranscript, reviewRisk } from "./risk-reviewer.js";

test("risk reviewer accepts only explicit JSON approval", async () => {
  const seen = [];
  const stream = async function* (request) {
    seen.push(request);
    yield { type: "text", text: '{"decision":"approve_once","reason":"routine build"}' };
  };
  const result = await reviewRisk({
    stream,
    requestOptions: { model: "m1", messages: [{ role: "system", content: "secret system" }, { role: "user", content: "run the tests" }, { role: "tool", content: "SECRET_TOOL_RESULT" }], tools: [{ name: "terminal" }] },
    item: { name: "terminal", kind: "execute", rawInput: { command: "sh -c 'bun test'" } },
    decision: { requiresSessionReview: true, requiresNetworkReview: false },
    cwd: "/workspace",
  });
  assert.equal(result.approved, true);
  assert.deepEqual(seen[0].tools, []);
  assert.equal(seen[0].messages.some((message) => message.content === "SECRET_TOOL_RESULT"), false);
  assert.match(seen[0].messages[1].content, /run the tests/);
  assert.doesNotMatch(seen[0].messages[1].content, /secret system|SECRET_TOOL_RESULT/);
});

test("risk reviewer projects a normalized riskReason and defaults it to null", async () => {
  const seen = [];
  const stream = async function* (request) {
    seen.push(request);
    yield { type: "text", text: '{"decision":"block","reason":"no"}' };
  };
  const run = (rawInput) => reviewRisk({
    stream,
    requestOptions: { messages: [{ role: "user", content: "clean up" }] },
    item: { name: "terminal", kind: "execute", rawInput },
    decision: {},
    cwd: "/workspace",
  });
  await run({ command: "rm -rf dist", risk_level: "high", risk_reason: `  ${"y".repeat(600)}  ` });
  await run({ command: "rm -rf dist", risk_level: "high" });
  const withReason = JSON.parse(seen[0].messages[1].content).proposedAction;
  const withoutReason = JSON.parse(seen[1].messages[1].content).proposedAction;
  assert.equal(withReason.riskReason.length, 500);
  assert.equal(withoutReason.riskReason, null);
});

test("terminal schema exposes an optional risk_reason", async () => {
  const { TERMINAL_DEFINITION, SANDBOX_TERMINAL_DEFINITION } = await import("./tools/terminal.js");
  for (const definition of [TERMINAL_DEFINITION, SANDBOX_TERMINAL_DEFINITION]) {
    assert.equal(definition.parameters.properties.risk_reason.type, "string");
    assert.equal(definition.parameters.required.includes("risk_reason"), false);
  }
});

test("review transcript keeps only user intent and assistant tool calls within its budget", () => {
  const { transcript, truncated } = projectReviewTranscript([
    { role: "system", content: "do not leak" },
    { role: "user", content: "x".repeat(40) },
    { role: "assistant", tool_calls: [{ function: { name: "terminal", arguments: "{\\\"command\\\":\\\"pwd\\\"}" } }] },
    { role: "tool", content: "private output" },
  ], 30);
  assert.equal(truncated, true);
  assert.doesNotMatch(transcript, /private output|do not leak/);
});

test("risk reviewer fails closed for malformed or non-approving output", async () => {
  const stream = async function* () { yield { type: "text", text: "probably okay" }; };
  const result = await reviewRisk({ stream, requestOptions: {}, item: {}, decision: {}, cwd: "/workspace" });
  assert.equal(result.approved, false);
});
