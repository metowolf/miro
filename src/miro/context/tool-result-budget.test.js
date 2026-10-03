import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_TOOL_RESULT_BUDGET,
  applyToolResultBudget,
  buildToolResultStub,
  persistToolResult,
  planToolResultBudget,
  toolResultFilePath,
  toolResultsDir,
} from "./tool-result-budget.js";

/** 一条长度可控的假工具结果。 */
function bulk(id, length, index = 0) {
  return { id, index, content: "z".repeat(length) };
}

test("nothing is stubbed while the total is within budget", () => {
  assert.deepEqual(planToolResultBudget([bulk("a", 100), bulk("b", 100, 1)], { budget: 1000 }), []);
  assert.deepEqual(planToolResultBudget([], { budget: 1 }), []);
});

test("a missing budget falls back to the default", () => {
  assert.equal(planToolResultBudget([bulk("a", DEFAULT_TOOL_RESULT_BUDGET)]).length, 0);
  assert.equal(planToolResultBudget([bulk("a", DEFAULT_TOOL_RESULT_BUDGET + 1)]).length, 1);
});

test("stubbing keeps the total within budget after an overflow", () => {
  const entries = [bulk("a", 40_000, 0), bulk("b", 40_000, 1), bulk("c", 40_000, 2)];
  const budget = 100_000;
  const planned = planToolResultBudget(entries, { budget });
  assert.equal(planned.length, 3);

  for (const item of planned) {
    item.entry.content = buildToolResultStub({
      preview: item.kept,
      droppedChars: item.droppedChars,
      path: "/tmp/out.txt",
    });
  }

  // 桩本身也占上下文，所以「总量 ≤ 预算」必须留出这句说明的份额才算成立。
  const total = entries.reduce((sum, item) => sum + item.content.length, 0);
  assert.ok(total <= budget, `actual ${total} > ${budget}`);
  assert.equal(planned[0].droppedChars, 40_000 - planned[0].kept.length);
});

test("a small result is not stubbed because of a big one in the same batch", () => {
  const entries = [bulk("a", 100, 0), bulk("b", 500_000, 1)];
  const planned = planToolResultBudget(entries, { budget: 10_000 });
  assert.deepEqual(
    planned.map((item) => item.id),
    ["b"],
  );
});

test("the stub states how much was dropped and where it went", () => {
  const saved = buildToolResultStub({ preview: "head", droppedChars: 42, path: "/tmp/out.txt" });
  assert.match(saved, /^head\n\n/);
  assert.match(saved, /42 more characters are saved at \/tmp\/out\.txt/);
  assert.match(saved, /read_file/);

  const dropped = buildToolResultStub({ preview: "head", droppedChars: 42, error: "EACCES" });
  assert.match(dropped, /42 more characters were dropped/);
  assert.match(dropped, /could not save a copy: EACCES/);
});

test("persisted paths are split by workspace and session, with sanitized and truncated file names", () => {
  const home = "/home/u";
  const file = toolResultFilePath({
    cwd: "/repo/app",
    sessionId: "sess-1234-abcd",
    round: 2,
    index: 1,
    toolCallId: "call/../x",
    content: "payload",
    home,
  });
  assert.ok(file.startsWith(toolResultsDir(home)));
  assert.match(file, /app-[0-9a-f]{12}-sess1234\//);
  assert.match(file, /2-1-call_\.\._x-[0-9a-f]{64}\.txt$/);
});

test("persisting writes into the injected home and reads the original back verbatim", async () => {
  const home = mkdtempSync(join(tmpdir(), "miro-budget-home-"));
  const saved = await persistToolResult({
    cwd: "/repo/app",
    sessionId: "s1",
    round: 1,
    index: 0,
    toolCallId: "c1",
    content: "the whole thing",
    home,
  });
  assert.ok(saved.path.startsWith(home));
  assert.equal(await Bun.file(saved.path).text(), "the whole thing");
});

test("reusing round, index, and tool id across user turns does not overwrite older results", async () => {
  const home = mkdtempSync(join(tmpdir(), "miro-budget-home-"));
  const common = { cwd: "/repo/app", sessionId: "s1", round: 0, index: 0, toolCallId: "miro-0-0", home };

  const first = await persistToolResult({ ...common, content: "first turn" });
  const second = await persistToolResult({ ...common, content: "second turn" });

  assert.notEqual(first.path, second.path);
  assert.equal(await Bun.file(first.path).text(), "first turn");
  assert.equal(await Bun.file(second.path).text(), "second turn");
});

test("a failed persist does not throw but returns an error for the caller to degrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "miro-budget-blocked-"));
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x", "utf8");

  const saved = await persistToolResult({ cwd: "/repo", toolCallId: "c1", content: "z", home: blocker });
  assert.equal(typeof saved.error, "string");
  assert.equal(saved.path, undefined);
});

test("applyToolResultBudget persists through the injected store and stubs in place", async () => {
  const entries = [bulk("a", 5000, 0)];
  const written = [];

  const planned = await applyToolResultBudget(entries, {
    budget: 1000,
    store: async ({ id, index, content }) => {
      written.push({ id, index, content });
      return { path: `/fake/${id}.txt` };
    },
  });

  assert.equal(planned.length, 1);
  assert.deepEqual(written, [{ id: "a", index: 0, content: "z".repeat(5000) }]);
  assert.match(entries[0].content, /saved at \/fake\/a\.txt/);
});

test("an Infinity budget leaves results untouched", async () => {
  const entries = [bulk("a", 500_000)];
  const planned = await applyToolResultBudget(entries, {
    budget: Infinity,
    store: async () => assert.fail("must not write to disk"),
  });
  assert.deepEqual(planned, []);
  assert.equal(entries[0].content.length, 500_000);
});
