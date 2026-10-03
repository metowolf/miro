import { parsePatch, structuredPatch } from "diff";

const DIFF_CONTEXT_LINES = 3;
const MAX_EDIT_LENGTH = 1_000;
const DIFF_TIMEOUT_MS = 100;

function own(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizedText(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
}

function splitLines(text) {
  if (text === "") return [];
  const lines = normalizedText(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function pathFromInput(input) {
  if (input == null || typeof input !== "object") return null;
  for (const key of ["path", "file_path", "filePath", "filename"]) {
    if (typeof input[key] === "string" && input[key].length > 0) return input[key];
  }
  return null;
}

function operationFor(oldText, newText, { oldMissing = false } = {}) {
  if (oldMissing || oldText == null) return "create";
  if (newText === "" && oldText !== "") return "delete";
  if (oldText === "" && newText !== "") return "create";
  return "update";
}

/** jsdiff 的空区间使用下一行；展示层保留 unified patch 的前一行坐标。 */
function displayHunks(hunks) {
  return hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) => ({
    oldStart: oldLines === 0 ? Math.max(0, oldStart - 1) : oldStart,
    oldLines,
    newStart: newLines === 0 ? Math.max(0, newStart - 1) : newStart,
    newLines,
    lines: lines.filter((line) => !line.startsWith("\\")),
  }));
}

function countChanges(hunks) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function textHunks(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  // 预览只比较行内容，沿用忽略末尾换行差异的行为；原始正文仍保留在结果中。
  const terminated = (lines) => lines.length ? `${lines.join("\n")}\n` : "";
  const patch = structuredPatch("", "", terminated(oldLines), terminated(newLines), "", "", {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (patch) return displayHunks(patch.hunks);
  // 超出计算预算时仍给出完整预览，不继续做无界搜索。
  return [{
    oldStart: oldLines.length ? 1 : 0,
    oldLines: oldLines.length,
    newStart: newLines.length ? 1 : 0,
    newLines: newLines.length,
    lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
  }];
}

function fromTexts({ path, oldText, newText, source, complete, oldMissing = false }) {
  if (typeof newText !== "string" || (!oldMissing && typeof oldText !== "string")) return null;
  const normalizedOld = normalizedText(oldMissing ? "" : oldText);
  const normalizedNew = normalizedText(newText);
  const hunks = textHunks(normalizedOld, normalizedNew);
  return {
    path: typeof path === "string" && path.length > 0 ? path : null,
    oldText: oldMissing ? null : normalizedOld,
    newText: normalizedNew,
    hunks,
    ...countChanges(hunks),
    operation: operationFor(normalizedOld, normalizedNew, { oldMissing }),
    source,
    complete,
    // 完整文件从第 1 行起算是真实行号；old_string 片段的 1 只是相对偏移。
    hasLineNumbers: complete,
  };
}

function contentDiff(content) {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const block = item?.type === "content" ? item.content : item;
    if (block?.type !== "diff" || typeof block.newText !== "string") continue;
    const oldMissing = block.oldText == null;
    return fromTexts({
      path: block.path,
      oldText: block.oldText,
      newText: block.newText,
      source: "acp",
      complete: true,
      oldMissing,
    });
  }
  return null;
}

function cleanPatchPath(value) {
  if (typeof value !== "string" || !value || value === "/dev/null") return null;
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

function parseUnifiedPatch(patch, fallbackPath) {
  if (typeof patch !== "string" || patch.trim().length === 0) return null;
  try {
    const patches = parsePatch(normalizedText(patch)).filter((entry) => entry.hunks.length > 0);
    // 一个工具卡片只展示一个文件，不能把其他文件的 hunk 混到当前路径下。
    const entry = patches.find((item) => fallbackPath != null &&
      [cleanPatchPath(item.newFileName), cleanPatchPath(item.oldFileName)].includes(fallbackPath))
      ?? patches[0];
    if (!entry || !entry.hunks.every((hunk) =>
      [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]
        .every((value) => Number.isSafeInteger(value) && value >= 0))) return null;
    const hunks = displayHunks(entry.hunks);
    return {
      path: cleanPatchPath(entry.newFileName) ?? fallbackPath ?? cleanPatchPath(entry.oldFileName),
      oldText: null,
      newText: null,
      hunks,
      ...countChanges(hunks),
      operation: entry.oldFileName === "/dev/null" ? "create" : entry.newFileName === "/dev/null" ? "delete" : "update",
      source: "patch",
      complete: false,
      hasLineNumbers: true,
    };
  } catch {
    // 不完整或无效的 patch 不能让工具预览崩溃，继续尝试其他输入形态。
    return null;
  }
}

function rawInputDiff(rawInput) {
  if (rawInput == null || typeof rawInput !== "object") return null;
  const path = pathFromInput(rawInput);

  for (const key of ["patch", "diff"]) {
    if (!own(rawInput, key)) continue;
    const value = rawInput[key];
    if (typeof value === "string") {
      const parsed = parseUnifiedPatch(value, path);
      if (parsed) return parsed;
    } else if (value != null && typeof value === "object") {
      const nestedPath = pathFromInput(value) ?? path;
      if (typeof value.newText === "string") {
        return fromTexts({
          path: nestedPath,
          oldText: value.oldText,
          newText: value.newText,
          source: "raw-input",
          complete: true,
          oldMissing: value.oldText == null,
        });
      }
    }
  }

  if (own(rawInput, "newText") && typeof rawInput.newText === "string") {
    return fromTexts({
      path,
      oldText: rawInput.oldText,
      newText: rawInput.newText,
      source: "raw-input",
      complete: true,
      oldMissing: rawInput.oldText == null,
    });
  }
  // edits 数组（miro 的 edit_file）：确认阶段还没读过文件，拿不到完整
  // 原文，只能把每处替换当成独立片段拼出预览。complete: false 让渲染层
  // 知道这不是全文，不要显示可信的行号。
  if (own(rawInput, "edits") && Array.isArray(rawInput.edits)) {
    const edits = rawInput.edits.filter(
      (edit) =>
        edit != null &&
        typeof edit === "object" &&
        typeof edit.oldText === "string" &&
        typeof edit.newText === "string",
    );
    if (edits.length > 0) {
      return fromTexts({
        path,
        oldText: edits.map((edit) => edit.oldText).join("\n"),
        newText: edits.map((edit) => edit.newText).join("\n"),
        source: "raw-input",
        complete: false,
        oldMissing: false,
      });
    }
  }
  if (own(rawInput, "new_string") && typeof rawInput.new_string === "string") {
    return fromTexts({
      path,
      oldText: rawInput.old_string,
      newText: rawInput.new_string,
      source: "raw-input",
      complete: false,
      oldMissing: rawInput.old_string == null,
    });
  }
  // write_file 的参数是 content（全文），审批发生在执行前、还没读过旧文件，
  // 只能把新正文当新建预览。complete: false —— 没有 oldText，行号不可信，
  // 但至少 PermissionDialog 能走 DiffView，而不是 JSON.stringify 成单行转义串。
  if (own(rawInput, "content") && typeof rawInput.content === "string") {
    return fromTexts({
      path,
      oldText: null,
      newText: rawInput.content,
      source: "raw-input",
      complete: false,
      oldMissing: true,
    });
  }
  return null;
}

/**
 * 将 ACP Edit 内容统一成可直接渲染的 structuredPatch 形态。
 * ACP diff 是权威来源；权限阶段尚无 content 时才回退到 rawInput。
 * hasLineNumbers 仅在完整文件或 unified patch 的 @@ 头可信时为真。
 */
export function extractToolDiff(info = {}) {
  return contentDiff(info.content) ?? rawInputDiff(info.rawInput);
}