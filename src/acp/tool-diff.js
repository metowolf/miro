const DIFF_CONTEXT_LINES = 3;
const MAX_MYERS_DISTANCE = 1_000;

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

function get(map, key) {
  return map.has(key) ? map.get(key) : Number.NEGATIVE_INFINITY;
}

/** Myers 行级 diff；极端大改动退化为整段删除/新增，避免无界内存占用。 */
function diffLineOperations(oldLines, newLines) {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  let frontier = new Map([[1, 0]]);
  const trace = [];
  const limit = Math.min(oldLength + newLength, MAX_MYERS_DISTANCE);

  for (let distance = 0; distance <= limit; distance += 1) {
    const current = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x;
      if (
        diagonal === -distance ||
        (diagonal !== distance && get(frontier, diagonal - 1) < get(frontier, diagonal + 1))
      ) {
        x = get(frontier, diagonal + 1);
      } else {
        x = get(frontier, diagonal - 1) + 1;
      }
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (x < oldLength && y < newLength && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      current.set(diagonal, x);
      if (x >= oldLength && y >= newLength) {
        trace.push(current);
        return backtrackOperations(trace, oldLines, newLines);
      }
    }
    trace.push(current);
    frontier = current;
  }

  return [
    ...oldLines.map((text) => ({ type: "remove", text })),
    ...newLines.map((text) => ({ type: "add", text })),
  ];
}

function backtrackOperations(trace, oldLines, newLines) {
  let x = oldLines.length;
  let y = newLines.length;
  const reversed = [];

  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1];
    const diagonal = x - y;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && get(previous, diagonal - 1) < get(previous, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1;
    const previousX = get(previous, previousDiagonal);
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ type: "context", text: oldLines[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push({ type: "add", text: newLines[y - 1] });
      y -= 1;
    } else {
      reversed.push({ type: "remove", text: oldLines[x - 1] });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    reversed.push({ type: "context", text: oldLines[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ type: "remove", text: oldLines[--x] });
  }
  while (y > 0) {
    reversed.push({ type: "add", text: newLines[--y] });
  }
  return reversed.reverse();
}

function hunksFromOperations(operations) {
  const annotated = [];
  const changes = [];
  let oldLine = 1;
  let newLine = 1;

  for (const operation of operations) {
    const item = { ...operation, oldLine, newLine };
    annotated.push(item);
    if (operation.type !== "context") changes.push(annotated.length - 1);
    if (operation.type !== "add") oldLine += 1;
    if (operation.type !== "remove") newLine += 1;
  }
  if (changes.length === 0) return [];

  const ranges = [];
  for (const index of changes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(annotated.length, index + DIFF_CONTEXT_LINES + 1);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map(({ start, end }) => {
    const selected = annotated.slice(start, end);
    const oldLines = selected.filter((line) => line.type !== "add").length;
    const newLines = selected.filter((line) => line.type !== "remove").length;
    const first = selected[0];
    return {
      oldStart: oldLines === 0 ? Math.max(0, first.oldLine - 1) : first.oldLine,
      oldLines,
      newStart: newLines === 0 ? Math.max(0, first.newLine - 1) : first.newLine,
      newLines,
      lines: selected.map((line) => {
        const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        return `${prefix}${line.text}`;
      }),
    };
  });
}

function fromTexts({ path, oldText, newText, source, complete, oldMissing = false }) {
  if (typeof newText !== "string" || (!oldMissing && typeof oldText !== "string")) return null;
  const normalizedOld = normalizedText(oldMissing ? "" : oldText);
  const normalizedNew = normalizedText(newText);
  const operations = diffLineOperations(splitLines(normalizedOld), splitLines(normalizedNew));
  return {
    path: typeof path === "string" && path.length > 0 ? path : null,
    oldText: oldMissing ? null : normalizedOld,
    newText: normalizedNew,
    hunks: hunksFromOperations(operations),
    additions: operations.filter((line) => line.type === "add").length,
    deletions: operations.filter((line) => line.type === "remove").length,
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
  if (typeof value !== "string") return null;
  const token = value.trim().split(/\s+/)[0];
  if (!token || token === "/dev/null") return null;
  return token.startsWith("a/") || token.startsWith("b/") ? token.slice(2) : token;
}

function parseUnifiedPatch(patch, fallbackPath) {
  if (typeof patch !== "string" || patch.trim().length === 0) return null;
  const lines = normalizedText(patch).split("\n");
  let oldHeader = null;
  let newHeader = null;
  let path = fallbackPath;
  const hunks = [];
  let additions = 0;
  let deletions = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      oldHeader = line.slice(4).trim().split(/\s+/)[0];
      continue;
    }
    if (line.startsWith("+++ ")) {
      newHeader = line.slice(4).trim().split(/\s+/)[0];
      path = cleanPatchPath(line.slice(4)) ?? path ?? cleanPatchPath(oldHeader);
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const hunk = {
      oldStart: Number(match[1]),
      oldLines: match[2] == null ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] == null ? 1 : Number(match[4]),
      lines: [],
    };
    while (index + 1 < lines.length && !lines[index + 1].startsWith("@@ ")) {
      const body = lines[index + 1];
      if (body.startsWith("\\ No newline at end of file")) {
        index += 1;
        continue;
      }
      if (!body.startsWith(" ") && !body.startsWith("+") && !body.startsWith("-")) break;
      hunk.lines.push(body);
      if (body.startsWith("+")) additions += 1;
      if (body.startsWith("-")) deletions += 1;
      index += 1;
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0) return null;
  const operation = oldHeader === "/dev/null" ? "create" : newHeader === "/dev/null" ? "delete" : "update";
  return {
    path: path ?? cleanPatchPath(newHeader) ?? cleanPatchPath(oldHeader),
    oldText: null,
    newText: null,
    hunks,
    additions,
    deletions,
    operation,
    source: "patch",
    complete: false,
    hasLineNumbers: true,
  };
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

