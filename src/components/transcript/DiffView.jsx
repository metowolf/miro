import { Box, Text, useStdout } from "ink";

const DEFAULT_PREVIEW_LINES = 10;
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemes(value) {
  const text = String(value ?? "");
  return segmenter
    ? [...segmenter.segment(text)].map(({ segment }) => segment)
    : Array.from(text);
}

// 覆盖源码展示所需的 wcwidth 规则：组合字符宽度为零，CJK 与 emoji 占两格。
// 保持为本地实现，避免仅为一个视图组件增加运行时依赖。
function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) {
    const point = character.codePointAt(0);
    if (point === 0x200d || /\p{Mark}/u.test(character)) continue;
    if (point < 0x20 || (point >= 0x7f && point < 0xa0)) continue;
    width += (
      point >= 0x1100 && (
        point <= 0x115f || point === 0x2329 || point === 0x232a ||
        (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
        (point >= 0xac00 && point <= 0xd7a3) ||
        (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xfe10 && point <= 0xfe19) ||
        (point >= 0xfe30 && point <= 0xfe6f) ||
        (point >= 0xff00 && point <= 0xff60) ||
        (point >= 0xffe0 && point <= 0xffe6) ||
        (point >= 0x20000 && point <= 0x3fffd)
      )
    ) ? 2 : 1;
  }
  return width;
}

function displayWidth(value) {
  return graphemes(value).reduce((total, item) => total + graphemeWidth(item), 0);
}

function takeWidth(value, columns) {
  if (columns <= 0) return ["", String(value ?? "")];
  let used = 0;
  let head = "";
  let tail = "";
  for (const item of graphemes(value)) {
    const itemWidth = graphemeWidth(item);
    if (tail || (used > 0 && used + itemWidth > columns)) tail += item;
    // 双格字素无法塞入剩余的一格；以占位符消费该位置，保证折行持续推进。
    else if (used === 0 && itemWidth > columns) {
      head += "?";
      used += 1;
    }
    else {
      head += item;
      used += itemWidth;
    }
  }
  return [head, tail];
}

function fit(value, columns) {
  const text = String(value ?? "");
  if (displayWidth(text) <= columns) return text;
  if (columns <= 1) return takeWidth("…", columns)[0];
  return `${takeWidth(text, columns - 1)[0]}…`;
}

function lineKind(type) {
  if (["+", "add", "added", "addition", "insert"].includes(type)) return "add";
  if (["-", "del", "delete", "deleted", "deletion", "remove"].includes(type)) return "delete";
  return "context";
}

function hunkRows(hunk, { showLineNumbers = true } = {}) {
  const startOld = hunk?.oldStart ?? hunk?.oldLine;
  const startNew = hunk?.newStart ?? hunk?.newLine;
  let oldLine = showLineNumbers && startOld != null ? Number(startOld) : null;
  let newLine = showLineNumbers && startNew != null ? Number(startNew) : null;
  const rows = [];

  for (const input of Array.isArray(hunk?.lines) ? hunk.lines : []) {
    if (typeof input === "string" && input.startsWith("\\ No newline")) continue;
    const rawType = typeof input === "string" ? input[0] : input?.type ?? input?.kind;
    const kind = lineKind(rawType);
    const content = typeof input === "string"
      ? (["+", "-", " "].includes(input[0]) ? input.slice(1) : input)
      : String(input?.content ?? input?.text ?? "");
    const explicitOld = showLineNumbers && typeof input === "object"
      ? input?.oldLine ?? input?.oldLineNumber
      : undefined;
    const explicitNew = showLineNumbers && typeof input === "object"
      ? input?.newLine ?? input?.newLineNumber
      : undefined;
    const row = {
      kind,
      content: content.replace(/\t/g, "  "),
      oldLine: kind === "add" ? null : explicitOld ?? oldLine,
      newLine: kind === "delete" ? null : explicitNew ?? newLine,
    };
    rows.push(row);
    if (kind !== "add" && (explicitOld ?? oldLine) != null) oldLine = (explicitOld ?? oldLine) + 1;
    if (kind !== "delete" && (explicitNew ?? newLine) != null) newLine = (explicitNew ?? newLine) + 1;
  }
  return rows;
}

function logicalRows(diff) {
  const showLineNumbers = diff?.hasLineNumbers !== false;
  const rows = [];
  for (const [index, hunk] of (diff?.hunks ?? []).entries()) {
    if (index > 0) rows.push({ kind: "separator", content: "…" });
    rows.push(...hunkRows(hunk, { showLineNumbers }));
  }
  return rows;
}

function gutterWidth(rows) {
  const highest = rows.reduce(
    (value, row) => Math.max(value, row.oldLine ?? 0, row.newLine ?? 0),
    1,
  );
  return String(highest).length;
}

function rowsHaveLineNumbers(rows) {
  return rows.some((row) => row.oldLine != null || row.newLine != null);
}

function physicalRows(rows, columns) {
  const numbered = rowsHaveLineNumbers(rows);
  const digits = numbered ? gutterWidth(rows) : 0;
  const normalPrefixWidth = numbered ? digits * 2 + 4 : 2;
  const compact = !numbered || columns < normalPrefixWidth + 2;
  const prefixWidth = compact ? Math.min(2, columns) : normalPrefixWidth;
  const contentWidth = Math.max(1, columns - prefixWidth);
  const output = [];

  for (const row of rows) {
    if (row.kind === "separator") {
      output.push({ ...row, prefix: compact ? "" : " ".repeat(normalPrefixWidth) });
      continue;
    }
    const marker = row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " ";
    const firstPrefix = compact
      ? `${marker} `.slice(0, prefixWidth)
      : `${row.oldLine == null ? "".padStart(digits) : String(row.oldLine).padStart(digits)} ${row.newLine == null ? "".padStart(digits) : String(row.newLine).padStart(digits)} ${marker} `;
    const continuationPrefix = " ".repeat(prefixWidth);
    let remaining = row.content.length > 0 ? row.content : " ";
    let first = true;
    do {
      const [content, rest] = takeWidth(remaining, contentWidth);
      output.push({ ...row, prefix: first ? firstPrefix : continuationPrefix, content });
      remaining = rest;
      first = false;
    } while (remaining.length > 0);
  }
  return output;
}

function operationLabel(operation) {
  if (operation === "create") return "Create";
  if (operation === "delete") return "Delete";
  return "Edit";
}

/**
 * 终端宽度安全的 unified diff 渲染器。
 * `hunks` 同时接受 structuredPatch 字符串行和带显式行号的对象行；
 * `hasLineNumbers === false` 时不渲染行号栏（片段 diff 的 1 起算偏移不可信）；
 * `maxLines`、`offset` 均按折行后的物理行计数，供历史预览和滚动审阅复用。
 */
export function diffLineCount(diff, width = 80) {
  const columns = Math.max(1, Math.floor(width));
  return physicalRows(logicalRows(diff), columns).length;
}

export function DiffView({ diff, mode = "preview", maxLines, offset = 0, width, showHeader = true }) {
  const { stdout } = useStdout();
  const columns = Math.max(1, Math.floor(width ?? stdout?.columns ?? 80));
  const rows = physicalRows(logicalRows(diff), columns);
  const start = Math.max(0, Math.floor(offset));
  const limit = maxLines == null
    ? (mode === "preview" ? DEFAULT_PREVIEW_LINES : Infinity)
    : Math.max(0, Math.floor(maxLines));
  const visible = rows.slice(start, Number.isFinite(limit) ? start + limit : undefined);
  const hiddenAfter = Math.max(0, rows.length - start - visible.length);
  const hiddenBefore = Math.min(start, rows.length);
  const stats = `+${diff?.additions ?? 0} -${diff?.deletions ?? 0}`;
  const title = `${operationLabel(diff?.operation)} ${diff?.path || "(unknown file)"} · ${stats}`;

  return (
    <Box flexDirection="column" width={columns}>
      {showHeader ? <Text bold>{fit(title, columns)}</Text> : null}
      {hiddenBefore > 0 ? <Text dimColor>{fit(`… ${hiddenBefore} earlier lines`, columns)}</Text> : null}
      {visible.map((row, index) => {
        const color = row.kind === "add" ? "green" : row.kind === "delete" ? "red" : undefined;
        return (
          <Text key={`${start}-${index}`} color={color} dimColor={row.kind === "separator"}>
            {fit(`${row.prefix}${row.content}`, columns)}
          </Text>
        );
      })}
      {hiddenAfter > 0 ? (
        <Text dimColor>{fit(`… +${hiddenAfter} lines`, columns)}</Text>
      ) : null}
    </Box>
  );
}

