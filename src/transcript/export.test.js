import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaultFilename,
  ensureTxtExtension,
  extractFirstPrompt,
  formatExportTimestamp,
  osc52Copy,
  renderTranscript,
  sanitizeFilename,
} from "./export.js";

test("renderTranscript renders roles, spacing, pending, and tool details", () => {
  const text = renderTranscript([
    { role: "banner", text: "ignored", head: true },
    { role: "user", text: "hello\nworld", head: true },
    { role: "assistant", text: "answer", gap: true },
    { role: "tool", text: "Read(src/a.js)", head: true, tool: { hint: "reading", preview: { lines: ["const x = 1;"] } } },
    { role: "plan", text: "- done", head: true },
  ], { role: "assistant", text: "tail" });

  assert.equal(text, "> hello\n  world\n\n● answer\n\n● Read(src/a.js)\n  └ reading\n    const x = 1;\n\n- done\n● tail");
});

test("empty transcript ignores banners", () => {
  assert.equal(renderTranscript([{ role: "banner", text: "welcome" }]), "");
});

test("renderTranscript keeps finalized edit diffs", () => {
  const text = renderTranscript([{
    role: "tool",
    text: "Edit(src/a.js)",
    head: true,
    tool: {
      diff: {
        path: "src/a.js",
        additions: 1,
        deletions: 1,
        hunks: [{
          oldStart: 3,
          oldLines: 1,
          newStart: 3,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        }],
      },
    },
  }]);

  assert.equal(
    text,
    "● Edit(src/a.js)\n    diff src/a.js (+1 -1)\n    @@ -3,1 +3,1 @@\n    -const x = 1;\n    +const x = 2;"
  );
});

test("thinking export follows compact, full, and hidden display modes", () => {
  const block = {
    role: "thought",
    text: "Thought: Inspecting · 2s",
    thought: {
      title: "Inspecting",
      text: "**Inspecting**\n\nprivate detail",
      displayMode: "compact",
    },
  };
  assert.equal(renderTranscript([block]), "∴ Thought: Inspecting · 2s");
  assert.equal(
    renderTranscript([{ ...block, thought: { ...block.thought, displayMode: "full" } }]),
    "∴ Thought: Inspecting · 2s\n  private detail"
  );
  assert.equal(
    renderTranscript([{ ...block, thought: { ...block.thought, displayMode: "hidden" } }]),
    ""
  );
  assert.equal(
    renderTranscript([{
      ...block,
      thought: { title: "Inspecting", hasContent: true, displayMode: "compact" },
    }]),
    "∴ Thought: Inspecting · 2s · details not retained"
  );
});

test("prompt and filename helpers follow export naming rules", () => {
  assert.equal(extractFirstPrompt([{ role: "assistant", text: "no" }, { role: "user", text: "Hello, World!\nsecond" }]), "Hello, World!");
  assert.equal(sanitizeFilename("Hello, World!  v2"), "hello-world-v2");
  const date = new Date(2026, 7, 17, 9, 5, 3);
  assert.equal(formatExportTimestamp(date), "2026-08-17-090503");
  assert.equal(buildDefaultFilename([{ role: "user", text: "Hello, World!" }], date), "2026-08-17-090503-hello-world.txt");
  assert.equal(buildDefaultFilename([], date), "conversation-2026-08-17-090503.txt");
});

test("long prompts are shortened and invalid extensions are replaced", () => {
  const prompt = "a".repeat(60);
  assert.equal(extractFirstPrompt([{ role: "user", text: prompt }]), `${"a".repeat(49)}…`);
  assert.equal(ensureTxtExtension("report"), "report.txt");
  assert.equal(ensureTxtExtension("report.md"), "report.txt");
  assert.equal(ensureTxtExtension("report.txt"), "report.txt");
  assert.equal(ensureTxtExtension(".md"), ".txt");
});

test("osc52Copy encodes text and rejects oversized content", () => {
  assert.equal(osc52Copy("hello"), "\u001b]52;c;aGVsbG8=\u0007");
  assert.equal(osc52Copy("x".repeat(74001)), null);
});
