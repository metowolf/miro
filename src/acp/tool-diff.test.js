import assert from "node:assert/strict";
import test from "node:test";
import { extractToolDiff } from "./tool-diff.js";

test("an explicit ACP diff wins and produces a structuredPatch with context", () => {
  const result = extractToolDiff({
    kind: "edit",
    content: [{
      type: "diff",
      path: "/repo/src/app.js",
      oldText: "one\ntwo\nthree\nfour\nfive\n",
      newText: "one\nTWO\nthree\nfour\nFIVE\nsix\n",
    }],
    rawInput: { path: "ignored.js", old_string: "x", new_string: "y" },
  });

  assert.equal(result.path, "/repo/src/app.js");
  assert.equal(result.source, "acp");
  assert.equal(result.complete, true);
  assert.equal(result.hasLineNumbers, true);
  assert.equal(result.operation, "update");
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 2);
  assert.deepEqual(result.hunks, [{
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 6,
    lines: [" one", "-two", "+TWO", " three", " four", "-five", "+FIVE", "+six"],
  }]);
});

test("handles ACP content wrappers and newly created files", () => {
  const result = extractToolDiff({
    content: [{
      type: "content",
      content: { type: "diff", path: "new.txt", oldText: null, newText: "hello\nworld\n" },
    }],
  });

  assert.equal(result.operation, "create");
  assert.equal(result.hasLineNumbers, true);
  assert.equal(result.oldText, null);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 0);
  assert.deepEqual(result.hunks[0], {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    lines: ["+hello", "+world"],
  });
});

test("handles rawInput old_string/new_string and marks it as an incomplete fragment", () => {
  const result = extractToolDiff({
    kind: "edit",
    rawInput: { file_path: "src/a.js", old_string: "const a = 1;", new_string: "const a = 2;" },
  });

  assert.equal(result.path, "src/a.js");
  assert.equal(result.source, "raw-input");
  assert.equal(result.complete, false);
  assert.equal(result.hasLineNumbers, false);
  assert.equal(result.operation, "update");
  assert.deepEqual(result.hunks[0].lines, ["-const a = 1;", "+const a = 2;"]);
});

test("handles rawInput oldText/newText as complete text", () => {
  const result = extractToolDiff({
    rawInput: { path: "gone.txt", oldText: "gone\n", newText: "" },
  });

  assert.equal(result.complete, true);
  assert.equal(result.hasLineNumbers, true);
  assert.equal(result.operation, "delete");
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 1);
});

test("parses multiple hunks and file operations from a unified patch", () => {
  const patch = [
    "--- a/src/a.txt",
    "+++ b/src/a.txt",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
    "@@ -8 +8,2 @@ note",
    "-eight",
    "+EIGHT",
    "+nine",
  ].join("\n");
  const result = extractToolDiff({ rawInput: { diff: patch } });

  assert.equal(result.path, "src/a.txt");
  assert.equal(result.source, "patch");
  assert.equal(result.complete, false);
  assert.equal(result.hasLineNumbers, true);
  assert.equal(result.operation, "update");
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 2);
  assert.deepEqual(result.hunks.map(({ oldStart, oldLines, newStart, newLines }) => ({ oldStart, oldLines, newStart, newLines })), [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 },
    { oldStart: 8, oldLines: 1, newStart: 8, newLines: 2 },
  ]);
});

test("edits array still yields a diff at the permission confirmation stage", () => {
  const result = extractToolDiff({
    rawInput: {
      path: "a.js",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 10;" },
        { oldText: "const c = 3;", newText: "const c = 30;" },
      ],
    },
  });

  assert.ok(result);
  assert.equal(result.path, "a.js");
  assert.equal(result.operation, "update");
  // 确认阶段拿不到全文，行号不可信。
  assert.equal(result.complete, false);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 2);
});

test("empty or malformed edits produce no diff", () => {
  assert.equal(extractToolDiff({ rawInput: { path: "a.js", edits: [] } }), null);
  assert.equal(extractToolDiff({ rawInput: { path: "a.js", edits: [{ oldText: 1 }] } }), null);
});

test("write_file rawInput.content still yields a diff at the approval stage", () => {
  const result = extractToolDiff({
    rawInput: { path: "src/a.js", content: "hello\nworld\n" },
  });

  assert.ok(result);
  assert.equal(result.path, "src/a.js");
  assert.equal(result.source, "raw-input");
  // 审批时尚无旧文件，只能当新建预览；complete: false 让渲染层不信行号。
  assert.equal(result.complete, false);
  assert.equal(result.operation, "create");
  assert.equal(result.oldText, null);
  assert.deepEqual(result.hunks[0].lines, ["+hello", "+world"]);
});

test("returns null when nothing can be parsed", () => {
  assert.equal(extractToolDiff(), null);
  assert.equal(extractToolDiff({ content: [{ type: "text", text: "no diff" }] }), null);
  assert.equal(extractToolDiff({ rawInput: { patch: "plain text" } }), null);
});
