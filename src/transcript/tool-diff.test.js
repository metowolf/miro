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

test("预览归一化换行并忽略文件末尾换行差异", () => {
  const result = extractToolDiff({ rawInput: { oldText: "one\r\ntwo\r", newText: "one\ntwo" } });
  assert.deepEqual(result.hunks, []);
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.oldText, "one\ntwo\n");
  assert.equal(result.newText, "one\ntwo");
});

test("相距较远的改动拆成独立 hunk", () => {
  const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[1] = "changed 2";
  newLines[18] = "changed 19";
  const result = extractToolDiff({ rawInput: { oldText: oldLines.join("\n"), newText: newLines.join("\n") } });
  assert.equal(result.hunks.length, 2);
  assert.equal(result.hunks[0].oldStart, 1);
  assert.equal(result.hunks[1].oldStart, 16);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 2);
});

test("超过编辑距离预算时降级为完整删除和新增", () => {
  const oldLines = Array.from({ length: 600 }, (_, index) => `old ${index}`);
  const newLines = Array.from({ length: 600 }, (_, index) => `new ${index}`);
  const result = extractToolDiff({ rawInput: { oldText: oldLines.join("\n"), newText: newLines.join("\n") } });
  assert.deepEqual(result.hunks, [{
    oldStart: 1, oldLines: 600, newStart: 1, newLines: 600,
    lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
  }]);
  assert.equal(result.additions, 600);
  assert.equal(result.deletions, 600);
});

test("patch 保留含空格路径及空区间坐标，不显示末尾换行标记", () => {
  const result = extractToolDiff({ rawInput: { patch: [
    "--- /dev/null", "+++ b/new file.txt\t2026-01-01", "@@ -0,0 +1 @@",
    "+hello", "\\ No newline at end of file",
  ].join("\n") } });
  assert.equal(result.path, "new file.txt");
  assert.equal(result.operation, "create");
  assert.deepEqual(result.hunks, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hello"] }]);
  const deletion = extractToolDiff({ rawInput: { patch: "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone" } });
  assert.equal(deletion.path, "gone.txt");
  assert.equal(deletion.operation, "delete");
  assert.equal(deletion.hunks[0].newStart, 0);
});

test("多文件 patch 按输入路径选择，否则只显示首个文件", () => {
  const patch = [
    "--- a/first.txt", "+++ b/first.txt", "@@ -1 +1 @@", "-one", "+ONE",
    "--- a/second.txt", "+++ b/second.txt", "@@ -1 +1 @@", "-two", "+TWO",
  ].join("\n");
  const first = extractToolDiff({ rawInput: { patch } });
  assert.equal(first.path, "first.txt");
  assert.equal(first.additions, 1);
  assert.deepEqual(first.hunks[0].lines, ["-one", "+ONE"]);
  const second = extractToolDiff({ rawInput: { path: "second.txt", patch } });
  assert.equal(second.path, "second.txt");
  assert.deepEqual(second.hunks[0].lines, ["-two", "+TWO"]);
});

test("无文件头 patch 使用输入路径，无效 patch 回退其他输入", () => {
  const result = extractToolDiff({ rawInput: { path: "a.txt", patch: "@@ -1 +1 @@\n-a\n+b" } });
  assert.equal(result.path, "a.txt");
  assert.equal(result.hasLineNumbers, true);
  for (const patch of ["@@ broken @@", "@@ -1,3 +1,2 @@\n-a\n+b", "@@ -9007199254740992 +1 @@\n-a\n+b"]) {
    assert.equal(extractToolDiff({ rawInput: { patch } }), null);
    const fallback = extractToolDiff({ rawInput: { patch, old_string: "a", new_string: "b" } });
    assert.equal(fallback.source, "raw-input");
  }
});