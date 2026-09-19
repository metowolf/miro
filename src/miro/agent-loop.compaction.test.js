import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "./agent-loop.js";

function overflow() {
  return new Error("maximum context length exceeded");
}

function config() {
  return {
    cwd: "/workspace",
    model: "test-model",
    protocol: "chat-completions",
    permissionMode: "auto",
    maxToolRounds: 2,
    contextWindow: 1_000,
    autoCompact: true,
    tools: [],
  };
}

function history() {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "a".repeat(600) },
    { role: "assistant", content: "prior answer" },
    { role: "user", content: "b".repeat(200) },
  ];
}

test("overflow recovery validates and admits a summary before replacing history", async () => {
  const messages = history();
  const compacted = [];
  let call = 0;
  const stream = async function* () {
    call += 1;
    if (call === 1) throw overflow();
    if (call === 2) {
      yield { type: "text", text: "Useful compact summary" };
      yield { type: "finish", reason: "stop" };
      yield { type: "done" };
      return;
    }
    yield { type: "text", text: "finished" };
    yield { type: "finish", reason: "stop" };
    yield { type: "done" };
  };

  const result = await runAgentLoop({
    messages,
    config: config(),
    handlers: { onCompacted: (payload) => compacted.push(payload) },
    dependencies: { backend: { stream, estimateTokens: (text) => text.length } },
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].schemaStatus, "soft_fallback");
  assert.equal(messages[0].miro_compaction, true);
  assert.equal(messages.at(-1).content, "finished");
});

test("an incomplete summary leaves the original history untouched", async () => {
  const messages = history();
  const original = structuredClone(messages);
  let call = 0;
  const stream = async function* () {
    call += 1;
    if (call === 1) throw overflow();
    yield { type: "text", text: "cut off" };
    yield { type: "finish", reason: "length" };
    yield { type: "done" };
  };

  await assert.rejects(
    runAgentLoop({
      messages,
      config: config(),
      handlers: {},
      dependencies: { backend: { stream, estimateTokens: (text) => text.length } },
    }),
    /maximum context length exceeded/,
  );
  assert.deepEqual(messages, original);
});
