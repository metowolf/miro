import { chmod, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { diffContent, resolveToolPath, truncate } from "./shared.js";

const EDIT_PREVIEW_LINES = 400;
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const encoder = new TextEncoder();
/** 严格解码：非法 UTF-8 直接抛错，避免把 U+FFFD 乱码写回、毁掉原始字节。 */
const decoder = new TextDecoder("utf-8", { fatal: true });

export const EDIT_FILE_DEFINITION = {
  name: "edit_file",
  kind: "edit",
  title: "Edit",
  description:
    "Edit an existing file by text replacement. Matching tries exact text first, then unique line-trimmed and Unicode-normalized fallbacks. Each edits[].oldText must identify one block (unless an exact match uses replaceAll) and must not overlap another edit; all edits match against the original content. Prefer this over write_file for local changes so you do not restate the whole file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to edit, absolute or relative to the workspace." },
      edits: {
        type: "array",
        description:
          "One or more replacements applied to the original file. Merge nearby or overlapping changes into a single edit.",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description: "Exact text to replace. Must be unique in the file; include surrounding context if needed.",
            },
            newText: { type: "string", description: "Replacement text." },
            replaceAll: {
              type: "boolean",
              description:
                "Set true to replace every occurrence of oldText (e.g. renaming a symbol throughout the file). Defaults to false, which rejects an ambiguous oldText.",
            },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
};

/** 归一化模型给出的 edits，兼容字符串、单个对象与顶层简写。 */
function normalizeEdits(input) {
  const isEdit = (value) =>
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.oldText === "string" &&
    typeof value.newText === "string";

  let raw = input?.edits;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: "edit_file: 'edits' is a string but not valid JSON" };
    }
  }

  const edits = [];
  if (Array.isArray(raw)) edits.push(...raw);
  else if (isEdit(raw)) edits.push(raw);
  if (isEdit(input)) edits.push({ oldText: input.oldText, newText: input.newText });

  if (edits.length === 0) {
    return { error: "edit_file: missing required parameter 'edits' (array of { oldText, newText })" };
  }
  for (const [index, edit] of edits.entries()) {
    if (!isEdit(edit)) {
      return { error: `edit_file: edits[${index}] must have string 'oldText' and 'newText'` };
    }
    if (edit.replaceAll !== undefined && typeof edit.replaceAll !== "boolean") {
      return { error: `edit_file: edits[${index}].replaceAll must be a boolean` };
    }
    if (edit.oldText === "") {
      return { error: `edit_file: edits[${index}].oldText must not be empty; use write_file to create a file` };
    }
  }
  return { edits };
}

/**
 * 行尾风格：`crlf`（全部 \r\n）、`lf`（全部 \n）、`mixed`（\r\n 与裸 \n 混用，或存在孤立 \r）。
 *
 * 只有 `crlf` 能安全地整文件做 \n ⇄ \r\n 往返；`mixed` 一旦整文件归一化就会抹平差异，
 * 所以只把它当匹配视图，落盘时再按原文拼接，未改动的行尾保持字节不变。
 */
function detectLineStyle(text) {
  let hasCrlf = false;
  let hasBareLf = false;
  let hasLoneCr = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\r") {
      if (text[index + 1] === "\n") {
        hasCrlf = true;
        index += 1;
      } else {
        hasLoneCr = true;
      }
    } else if (char === "\n") {
      hasBareLf = true;
    }
  }
  if (hasLoneCr || (hasCrlf && hasBareLf)) return "mixed";
  if (hasCrlf) return "crlf";
  return "lf";
}

/**
 * 构造匹配视图：只把 \r\n 折成 \n，孤立 \r 作为普通内容字符保留。
 *
 * 同时返回「视图下标 → 原文偏移」映射：视图里的每个字符都能定位回原文，
 * 于是替换可以只重写命中的区间，其余部分按原文原样拼回。
 */
function buildModelView(text) {
  let view = "";
  const map = [];
  for (let index = 0; index < text.length; index += 1) {
    map.push(index);
    if (text[index] === "\r" && text[index + 1] === "\n") {
      view += "\n";
      index += 1;
    } else {
      view += text[index];
    }
  }
  map.push(text.length);
  return { view, map };
}

/** 模型给的文本收进匹配视图：只折叠 \r\n，保留孤立 \r。 */
function toModelViewText(text) {
  return text.replace(/\r\n/g, "\n");
}

function hasUtf8Bom(bytes) {
  return bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

/** 读取原始字节并做严格 UTF-8 解码，保留 BOM；拒绝二进制与非 UTF-8。 */
async function readFileForEdit(path) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const bom = hasUtf8Bom(bytes);
  const body = bom ? bytes.slice(UTF8_BOM.length) : bytes;
  if (body.includes(0)) {
    throw new Error("looks like a binary file (contains NUL bytes)");
  }
  let text;
  try {
    text = decoder.decode(body);
  } catch {
    throw new Error("is not valid UTF-8 text; convert it to UTF-8 first (e.g. with `iconv`)");
  }
  return { bom, style: detectLineStyle(text), text };
}

/** 写回时只恢复 BOM：行尾已在拼接阶段按原文处理，这里不再做全局换行转换。 */
function encodeFile(text, { bom }) {
  const body = encoder.encode(text);
  if (!bom) return body;
  const bytes = new Uint8Array(UTF8_BOM.length + body.length);
  bytes.set(UTF8_BOM);
  bytes.set(body, UTF8_BOM.length);
  return bytes;
}

function lineRecords(text) {
  const records = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") continue;
    records.push({ start, end: index, text: text.slice(start, index) });
    start = index + 1;
  }
  return records;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

/** 非重叠扫描：命中后从 needle 末尾继续，避免 "aa" 在 "aaa" 里被算成互相重叠的两处。 */
function allExactMatches(text, needle) {
  const matches = [];
  for (let start = text.indexOf(needle); start !== -1; start = text.indexOf(needle, start + needle.length)) {
    matches.push({ start, end: start + needle.length });
  }
  return matches;
}

/** 精确失败时才启用：以整行 trim 比较，仍要求候选唯一。 */
function trimmedLineMatches(text, needle) {
  const source = lineRecords(text);
  const target = lineRecords(needle);
  const matches = [];
  for (let index = 0; index + target.length <= source.length; index += 1) {
    if (!target.every((line, offset) => source[index + offset].text.trim() === line.text.trim())) continue;
    const last = source[index + target.length - 1];
    matches.push({ start: source[index].start, end: needle.endsWith("\n") ? last.start : last.end });
  }
  return matches;
}

/**
 * 模糊匹配只做模型抄写时常见的等价折叠，不改行首缩进，也不折叠正文中的
 * 普通空白。逐行处理保证换行结构不变，命中位置才能安全映回原文。
 */
export function normalizeForFuzzyMatch(text) {
  return String(text)
    .split("\n")
    .map((line) =>
      line
        .normalize("NFKC")
        .trimEnd()
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    )
    .join("\n");
}

function normalizeFuzzyLine(line) {
  return normalizeForFuzzyMatch(line);
}

/** NFKC 可能把一个原字符展开成多个字符；边界向外取整，绝不切开原字符。 */
function mapNfkcColumnToOriginal(line, column, kind) {
  if (column === 0) return 0;
  if (line.normalize("NFKC") === line) return column;
  const normalizedLength = (chars) => line.slice(0, chars).normalize("NFKC").length;
  let low = 0;
  let high = line.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (normalizedLength(middle) <= column) low = middle;
    else high = middle - 1;
  }
  if (normalizedLength(low) === column) return low;
  return kind === "start" ? low : low + 1;
}

function mapNormalizedPositionToOriginal(text, position, kind) {
  const lines = text.split("\n");
  let originalOffset = 0;
  let normalizedOffset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedEnd = normalizedOffset + normalizeFuzzyLine(line).length;
    const last = index === lines.length - 1;
    if (position < normalizedEnd || (position === normalizedEnd && (last || kind === "end"))) {
      return originalOffset + mapNfkcColumnToOriginal(line, position - normalizedOffset, kind);
    }
    if (position === normalizedEnd) return originalOffset + line.length;
    originalOffset += line.length + 1;
    normalizedOffset = normalizedEnd + 1;
  }
  return text.length;
}

/**
 * 在归一化空间找出所有非重叠命中，再映回原文。保真守卫会拒绝映射边界
 * 向外扩张后吞进额外字符的情况（例如 oldText="ix" 命中原文 "ﬁx"）。
 */
function normalizedMatches(text, needle) {
  const normalizedText = normalizeForFuzzyMatch(text);
  const normalizedNeedle = normalizeForFuzzyMatch(needle);
  if (normalizedNeedle.length === 0) return [];
  const matches = [];
  for (
    let position = normalizedText.indexOf(normalizedNeedle);
    position !== -1;
    position = normalizedText.indexOf(normalizedNeedle, position + normalizedNeedle.length)
  ) {
    const start = mapNormalizedPositionToOriginal(text, position, "start");
    const end = mapNormalizedPositionToOriginal(text, position + normalizedNeedle.length, "end");
    if (normalizeForFuzzyMatch(text.slice(start, end)) !== normalizedNeedle) continue;
    if (!matches.some((match) => match.start === start && match.end === end)) matches.push({ start, end });
  }
  return matches;
}

function matchSummary(text, matches) {
  const shown = matches.slice(0, 4);
  const lines = shown.map(({ start, end }) => {
    const first = lineNumberAt(text, start);
    const last = lineNumberAt(text, Math.max(start, end - 1));
    return first === last ? String(first) : `${first}-${last}`;
  });
  const context = shown.map(({ start }) => {
    const line = text.slice(start, text.indexOf("\n", start) === -1 ? text.length : text.indexOf("\n", start));
    return `line ${lineNumberAt(text, start)}: ${truncate(line.trim(), 120)}`;
  });
  return `${matches.length} match${matches.length === 1 ? "" : "es"} at line${matches.length === 1 ? "" : "s"} ${lines.join(", ")}${matches.length > lines.length ? ", …" : ""}; context: ${context.join(" | ")}`;
}

/**
 * 在匹配视图里定位一处 edit，返回视图坐标下的若干区间或错误。
 *
 * 唯一命中时返回单区间；`replaceAll` 打开且精确命中多次时返回全部精确区间。
 */
function spansForEdit(view, edit, index) {
  const exact = allExactMatches(view, edit.oldText);
  if (exact.length === 1) return { spans: [{ ...exact[0], index, viaTrim: false, viaNormalized: false }] };
  if (exact.length > 1) {
    if (edit.replaceAll) {
      return { spans: exact.map((match) => ({ ...match, index, viaTrim: false, viaNormalized: false })) };
    }
    return {
      error: `edit_file: edits[${index}].oldText appears ${matchSummary(view, exact)}; include more surrounding context to make it unique, or set replaceAll: true to replace every occurrence`,
    };
  }

  // 兜底匹配不参与 replaceAll：缩进不一致时“全替”太危险，仍要求候选唯一。
  const trimmed = trimmedLineMatches(view, edit.oldText);
  if (trimmed.length === 1) {
    return { spans: [{ ...trimmed[0], index, viaTrim: true, viaNormalized: false }] };
  }
  if (trimmed.length > 1) {
    return {
      error: `edit_file: edits[${index}].oldText was not found exactly; line-trimmed matching found ${matchSummary(view, trimmed)}. Include more context to make it unique`,
    };
  }
  // 与 trim 兜底一样，归一化匹配不参与 replaceAll，且必须唯一。
  const normalized = normalizedMatches(view, edit.oldText);
  if (normalized.length === 1) {
    return { spans: [{ ...normalized[0], index, viaTrim: false, viaNormalized: true }] };
  }
  if (normalized.length > 1) {
    return {
      error: `edit_file: edits[${index}].oldText was not found exactly; normalized matching found ${matchSummary(view, normalized)}. Include more context to make it unique`,
    };
  }
  return {
    error: `edit_file: edits[${index}].oldText was not found (exact, line-trimmed, or normalized match); read_file to confirm the current on-disk content`,
  };
}

/**
 * 逐条施加替换，全部以原文为基准匹配，并拒绝非唯一或重叠区间。
 *
 * 匹配在归一化视图里做（\r\n 折成 \n），落盘区间再映射回原文偏移，只重写命中的
 * 片段；新文本的行尾按文件风格展开（纯 CRLF 用 CRLF，纯 LF 用 LF，混合时沿用被
 * 替换片段自身的风格）。未命中的部分字节不变，因此 mixed 文件不会被整体抹平。
 */
function applyEdits(original, style, edits) {
  const { view, map } = buildModelView(original);
  const spans = [];
  let trimmedCount = 0;
  let normalizedCount = 0;

  for (const [index, edit] of edits.entries()) {
    const found = spansForEdit(view, { ...edit, oldText: toModelViewText(edit.oldText) }, index);
    if (found.error) return { error: found.error };
    for (const span of found.spans) {
      const start = map[span.start];
      const end = map[span.end];
      const eol =
        style === "crlf"
          ? "\r\n"
          : style === "lf"
            ? "\n"
            : original.slice(start, end).includes("\r\n")
              ? "\r\n"
              : "\n";
      spans.push({
        index,
        start,
        end,
        viaTrim: span.viaTrim,
        viaNormalized: span.viaNormalized,
        newText: toModelViewText(edit.newText).replace(/\n/g, eol),
      });
      if (span.viaTrim) trimmedCount += 1;
      if (span.viaNormalized) normalizedCount += 1;
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) {
      return {
        error: `edit_file: edits[${spans[i - 1].index}] and edits[${spans[i].index}] overlap; merge them into one edit`,
      };
    }
  }

  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += original.slice(cursor, span.start) + span.newText;
    cursor = span.end;
  }
  result += original.slice(cursor);
  return { content: result, count: spans.length, trimmedCount, normalizedCount };
}

/** 同目录临时文件写入后替换，避免崩溃或磁盘错误留下半截目标文件。 */
async function atomicWrite(path, content, format) {
  const temp = join(dirname(path), `.miro-edit-${Bun.randomUUIDv7()}.tmp`);
  try {
    const metadata = await stat(path);
    await writeFile(temp, encodeFile(content, format));
    await chmod(temp, metadata.mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 解析出真实写入目标：path 若是符号链接，rename 到链接会把链接本身换掉。 */
async function resolveWriteTarget(path) {
  try {
    return await realpath(path);
  } catch {
    // 读得到却 realpath 失败（例如 /proc 下的伪文件）时退回原路径。
    return path;
  }
}

/** Edit file：按精确文本替换改动已有文件，一次调用可含多处替换。 */
export function editFileTool(cwd) {
  return async (input) => {
    const path = resolveToolPath(cwd, input);
    if (!path) return { error: "edit_file: missing required parameter 'path'" };

    const normalized = normalizeEdits(input);
    if (normalized.error) return { error: normalized.error };

    // 路径权限由 agent-loop 统一审批；这里不能再次拦截已获授权的越界写入。
    let file;
    try {
      file = await readFileForEdit(path);
    } catch (error) {
      return { error: `edit_file: cannot read ${path}: ${error.message}` };
    }

    const applied = applyEdits(file.text, file.style, normalized.edits);
    if (applied.error) return { error: applied.error };

    // 替换后内容没变时不落盘：避免无意义的 mtime 变化与空 diff。
    if (applied.content === file.text) {
      return {
        output: `No changes to make in ${path}: oldText and newText produce identical content`,
        locations: [{ path }],
      };
    }

    try {
      await atomicWrite(await resolveWriteTarget(path), applied.content, file);
    } catch (error) {
      return { error: `edit_file: cannot write ${path}: ${error.message}` };
    }

    const count = applied.count;
    const blocks = `${count} ${count === 1 ? "block" : "blocks"}`;
    const trimNote =
      applied.trimmedCount > 0
        ? ` (${applied.trimmedCount} via line-trimmed match; re-read to confirm whitespace)`
        : "";
    const normalizedNote =
      applied.normalizedCount > 0
        ? ` (${applied.normalizedCount} via normalized match; re-read to confirm Unicode punctuation and spacing)`
        : "";
    return {
      output: `Replaced ${blocks} in ${path}${trimNote}${normalizedNote}`,
      content: diffContent(
        path,
        truncate(file.text, EDIT_PREVIEW_LINES * 200),
        truncate(applied.content, EDIT_PREVIEW_LINES * 200),
      ),
      locations: [{ path }],
    };
  };
}
