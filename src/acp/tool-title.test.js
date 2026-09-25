/**
 * 工具标题与预览的纯函数测试。
 *
 * 这些函数被 ACP 与 miro 两条路径共用，决定了 transcript 里每个工具卡片
 * 显示什么；store 只负责把它们的结果收进 block，那一层由 store.test.js 覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  commandText,
  extractToolOutputPreview,
  extractToolPreview,
  summarizeReadResult,
  summarizeToolResult,
  TOOL_PREVIEW_MAX_LINES,
} from "./tool-title.js";

function textContent(text) {
  return [{ type: "content", content: { type: "text", text } }];
}

function imageContent(data = "") {
  return [{ type: "content", content: { type: "image", data, mimeType: "image/png" } }];
}

test("extractToolPreview caps lines and counts the remainder", () => {
  const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const preview = extractToolPreview(textContent(text));
  assert.equal(preview.lines.length, TOOL_PREVIEW_MAX_LINES);
  assert.equal(preview.lines[0], "line 1");
  assert.equal(preview.more, 12 - TOOL_PREVIEW_MAX_LINES);
});

test("extractToolPreview ignores non-text and empty content", () => {
  assert.equal(extractToolPreview(undefined), null);
  assert.equal(extractToolPreview([]), null);
  assert.equal(extractToolPreview([{ type: "diff", path: "a.txt" }]), null);
  assert.equal(extractToolPreview(textContent("   \n  ")), null);
});

test("extractToolOutputPreview prefers the actual stdout and includes stderr", () => {
  const preview = extractToolOutputPreview({ stdout: "answer", stderr: "warning" });
  assert.deepEqual(preview, { lines: ["answer", "warning"], more: 0 });
  assert.equal(extractToolOutputPreview({ stdout: "", stderr: "" }), null);
});

test("commandText keeps newlines intact and leaves wrapping and clipping to the renderer", () => {
  // 压平成一行会让 heredoc 读不出结构；按字符数截断又会在终端很宽时白丢内容。
  const command = "python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY\n\n";
  assert.equal(commandText({ command }), "python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY");
  assert.equal(commandText({ command: "bun test" }), "bun test");
  assert.equal(commandText({ command: "   " }), null);
  assert.equal(commandText({ path: "src/a.js" }), null);
});

test("Read summary counts content lines and strips trailing newlines", () => {
  assert.deepEqual(
    summarizeReadResult({ kind: "read", content: textContent("a\nb\n") }),
    { lines: ["Read 2 lines"], more: 0 }
  );
  assert.deepEqual(
    summarizeReadResult({ kind: "read", content: textContent("only") }),
    { lines: ["Read 1 line"], more: 0 }
  );
});

test("Read summary reports image size when image data is available", () => {
  const data = Buffer.alloc(128 * 1024).toString("base64");
  assert.deepEqual(summarizeReadResult({ kind: "read", content: imageContent(data) }), {
    lines: ["Read image (128KB)"],
    more: 0,
  });
  assert.deepEqual(summarizeReadResult({ kind: "read", content: imageContent() }), {
    lines: ["Read image"],
    more: 0,
  });
});

test("Read summary returns null for empty content and the first error line", () => {
  assert.equal(summarizeReadResult({ kind: "read", content: textContent("  \n") }), null);
  assert.deepEqual(
    summarizeReadResult({ kind: "read", status: "failed", content: textContent("ENOENT: missing\nstack") }),
    { lines: ["ENOENT: missing"], more: 0 }
  );
});

test("Edit summary reports written line count instead of file content", () => {
  assert.deepEqual(
    summarizeToolResult({
      kind: "edit",
      rawInput: { apply_content: "/**\n * comment\n */\nint main() {}\n", file_path: "/tmp/a.cpp" },
      content: textContent("/**\n * comment\n */\nint main() {}\n"),
      status: "completed",
    }),
    { lines: ["Wrote 4 lines"], more: 0 }
  );
  assert.deepEqual(
    summarizeToolResult({ kind: "edit", content: textContent("single"), status: "completed" }),
    { lines: ["Wrote 1 line"], more: 0 }
  );
  assert.deepEqual(
    summarizeToolResult({
      kind: "edit",
      rawInput: { apply_content: "a\r\nb\r\n" },
      status: "completed",
    }),
    { lines: ["Wrote 2 lines"], more: 0 }
  );
});

test("Edit summary keeps error lines on failure and hides empty payloads", () => {
  assert.deepEqual(
    summarizeToolResult({
      kind: "edit",
      status: "failed",
      content: textContent("String not found in file\ndetail"),
    }),
    { lines: ["String not found in file"], more: 0 }
  );
  assert.equal(summarizeToolResult({ kind: "edit", content: textContent("  \n") }), null);
  assert.equal(summarizeToolResult({ kind: "edit", status: "failed" }), null);
  assert.equal(
    summarizeToolResult({ name: "Edit", content: textContent("x = 1\ny = 2") }).lines[0],
    "Wrote 2 lines"
  );
});
