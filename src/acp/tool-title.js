import os from "node:os";
import path from "node:path";
import process from "node:process";

/** 工具调用终态：进入后从动态区定稿进 scrollback。 */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** shell 输出最多展示的行数，超出以 +N lines 收尾。 */
export const TOOL_PREVIEW_MAX_LINES = 5;

/** 命令正文的保留上限：只为挡住畸形超长参数，正常命令远小于此。 */
const COMMAND_TEXT_MAX_CHARS = 10_000;

/** 预览单行最大字符数。 */
const PREVIEW_LINE_MAX_CHARS = 200;

/** 完整审阅仍需有内存上限，避免单个工具结果撑爆会话文件。 */
const TOOL_DETAIL_MAX_CHARS = 200_000;

/**
 * 从 ACP content 块提取文本预览；只取 text 块，无文本则不渲染预览。
 * @returns {{ lines: string[], more: number } | null}
 */
export function extractToolPreview(content) {
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const block of content) {
    if (
      block?.type === "content" &&
      block.content?.type === "text" &&
      typeof block.content.text === "string"
    ) {
      texts.push(block.content.text);
    }
  }
  if (texts.length === 0) return null;
  const joined = texts.join("\n").replace(/\n+$/, "");
  if (joined.trim().length === 0) return null;
  const lines = joined.split("\n");
  const shown = lines
    .slice(0, TOOL_PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_LINE_MAX_CHARS ? `${line.slice(0, PREVIEW_LINE_MAX_CHARS - 1)}…` : line
    );
  return { lines: shown, more: Math.max(0, lines.length - shown.length) };
}

/** 从 rawOutput 取预览：优先 stdout，其次 stderr。 */
export function extractToolOutputPreview(rawOutput) {
  if (rawOutput == null || typeof rawOutput !== "object") return null;
  const texts = [rawOutput.stdout, rawOutput.stderr].filter(
    (text) => typeof text === "string" && text.trim().length > 0
  );
  if (texts.length === 0) return null;
  return extractToolPreview([
    { type: "content", content: { type: "text", text: texts.join("\n") } },
  ]);
}

function extractOutputText(rawOutput) {
  if (rawOutput == null || typeof rawOutput !== "object") return "";
  return [rawOutput.stdout, rawOutput.stderr]
    .filter((text) => typeof text === "string" && text.trim().length > 0)
    .join("\n");
}

function firstNonEmptyLine(text) {
  if (typeof text !== "string") return "";
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const flat = line.trim();
    if (flat.length > 0) return flat;
  }
  return "";
}

function truncatePreviewLine(text) {
  return text.length > PREVIEW_LINE_MAX_CHARS
    ? `${text.slice(0, PREVIEW_LINE_MAX_CHARS - 1)}…`
    : text;
}

/**
 * 命令正文按原样保留（换行不压平、不按字符数截断），折行与取舍留给渲染层。
 *
 * 这里不能像 formatToolLabel 那样先压成一行：heredoc 脚本会变成一条读不出结构的
 * 标题，而长单行命令能显示多少取决于当时的终端宽度，只有渲染时才知道。
 */
export function commandText(rawInput) {
  const command = rawInput?.command;
  if (typeof command !== "string") return null;
  const normalized = command.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (normalized.trim().length === 0) return null;
  return normalized.length > COMMAND_TEXT_MAX_CHARS
    ? `${normalized.slice(0, COMMAND_TEXT_MAX_CHARS)}…`
    : normalized;
}

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block?.type === "content" &&
        block.content?.type === "text" &&
        typeof block.content.text === "string"
    )
    .map((block) => block.content.text)
    .join("\n");
}

function clippedDetail(text) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (value.length <= TOOL_DETAIL_MAX_CHARS) return value;
  return `${value.slice(0, TOOL_DETAIL_MAX_CHARS)}\n… detail truncated`;
}

function safeJson(value) {
  if (value == null) return "";
  if (typeof value === "string") return clippedDetail(value);
  try {
    return clippedDetail(JSON.stringify(value, (key, item) => {
      if (key === "data" && typeof item === "string" && item.length > 120) {
        return `[binary data: ${item.length} chars]`;
      }
      return item;
    }, 2));
  } catch {
    return clippedDetail(String(value));
  }
}

/**
 * 为完整工具审阅保留结构化的输入、输出和位置。预览仍走上面的紧凑摘要。
 */
export function buildToolDetail(info = {}) {
  const output = extractOutputText(info.rawOutput) || textContent(info.content);
  return {
    kind: info.kind ?? null,
    title: typeof info.title === "string" ? info.title : null,
    input: safeJson(info.rawInput),
    output: clippedDetail(output),
    locations: safeJson(info.locations),
  };
}

function imageContent(content) {
  if (!Array.isArray(content)) return null;
  return (
    content.find((block) => block?.type === "content" && block.content?.type === "image")?.content ??
    null
  );
}

function imageBytes(image) {
  for (const key of ["bytes", "byteLength", "size", "fileSize"]) {
    if (typeof image?.[key] === "number" && Number.isFinite(image[key]) && image[key] >= 0) {
      return image[key];
    }
  }
  if (typeof image?.data !== "string" || image.data.length === 0) return null;
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((image.data.length * 3) / 4) - padding);
}

function formatImageBytes(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Read 结果只保留摘要；行数由文本推导，正文若附带说明可能略有偏差。
 * @returns {{ lines: string[], more: number } | null}
 */
export function summarizeReadResult(info = {}) {
  const outputText = extractOutputText(info.rawOutput);
  const contentText = textContent(info.content);
  const text = outputText || contentText;

  if (info.status === "failed") {
    const error = firstNonEmptyLine(text);
    return error ? { lines: [truncatePreviewLine(error)], more: 0 } : null;
  }

  if (text.trim().length > 0) {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    const lines = normalized.split("\n");
    return {
      lines: [`Read ${lines.length} ${lines.length === 1 ? "line" : "lines"}`],
      more: 0,
    };
  }

  const image = imageContent(info.content);
  if (!image) return null;
  const size = formatImageBytes(imageBytes(image));
  return { lines: [`Read image${size ? ` (${size})` : ""}`], more: 0 };
}

/**
 * edit 工具无 diff 可渲染时的摘要：整文件写入（apply_content 等形态）只报行数，
 * 不把文件首行当预览。失败态仍显示错误首行。
 * @returns {{ lines: string[], more: number } | null}
 */
function summarizeEditResult(info = {}) {
  if (info.status === "failed") {
    const error = firstNonEmptyLine(extractOutputText(info.rawOutput) || textContent(info.content));
    return error ? { lines: [truncatePreviewLine(error)], more: 0 } : null;
  }

  const applyContent = info.rawInput?.apply_content;
  const text = typeof applyContent === "string" && applyContent.length > 0
    ? applyContent
    : textContent(info.content);
  if (text.trim().length === 0) return null;

  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return { lines: [`Wrote ${lines.length} ${lines.length === 1 ? "line" : "lines"}`], more: 0 };
}

/** Read 与普通工具单行摘要，execute 保留原有 shell 多行预览。 */
export function summarizeToolResult(info = {}) {
  const isRead = info.kind === "read" || (info.kind == null && info.name === "Read");
  if (isRead) return summarizeReadResult(info);
  if (info.kind === "execute") {
    return extractToolOutputPreview(info.rawOutput) ?? extractToolPreview(info.content);
  }
  const isEdit = info.kind === "edit" || (info.kind == null && info.name === "Edit");
  if (isEdit) return summarizeEditResult(info);

  const text = firstNonEmptyLine(extractOutputText(info.rawOutput) || textContent(info.content));
  return text ? { lines: [truncatePreviewLine(text)], more: 0 } : null;
}

/** ACP ToolKind → 展示名。不含 other，以便回退到 agent 的 title。 */
const KIND_NAMES = {
  read: "Read",
  edit: "Edit",
  execute: "Bash",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
  delete: "Delete",
  move: "Move",
};

/** 线格式工具名：给模型看的 snake_case，不是给人看的展示名。 */
const WIRE_TOOL_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

/**
 * miro provider 同时上报线格式名（`read_file`）与展示名（kind / title），
 * 直接取前者会让同一个工具在 miro 上显示成 `read_file(...)`、在 ACP 上显示成
 * `Read(...)`。所以 snake_case 名降级为兜底，只有真的没有展示名时才用它。
 */
function preferredDisplayName(name, kind, title) {
  const wire = typeof name === "string" ? name.trim() : "";
  const byKind = KIND_NAMES[kind] ?? "";
  const byTitle = typeof title === "string" ? title.trim() : "";
  if (wire && WIRE_TOOL_NAME.test(wire)) return byKind || byTitle || wire;
  return wire || byKind || byTitle || "Tool";
}

/** rawInput 中按序探测的路径类键。 */
const PATH_KEYS = ["path", "file_path", "filePath", "abs_path", "filename", "url", "uri", "sub_content_event_value"];

/** rawInput 中按序探测的命令/查询类键。 */
const COMMAND_KEYS = ["command", "query", "pattern", "search_term", "sub_content"];

const MAX_ARGS_DISPLAY_CHARS = 160;

/** cwd 内用相对路径，home 下用 ~/…，否则原样。 */
export function displayPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return "";
  try {
    const relativePath = path.relative(process.cwd(), filePath);
    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return relativePath;
    }
    const home = os.homedir();
    if (home && filePath.startsWith(home + path.sep)) {
      return `~${filePath.slice(home.length)}`;
    }
  } catch {
    // ignore
  }
  return filePath;
}

/** 换行折为空格，超长截断。 */
function truncate(text) {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  if (flat.length <= MAX_ARGS_DISPLAY_CHARS) return flat;
  return `${flat.slice(0, MAX_ARGS_DISPLAY_CHARS - 1)}…`;
}

function pickString(input, keys) {
  if (input == null || typeof input !== "object") return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * @param {object} info ACP 工具调用字段（均可缺失）：name、kind、title、rawInput、locations
 * @returns {{ name: string, args: string }}
 */
export function formatToolLabel(info) {
  const { name, kind, title, rawInput, locations } = info ?? {};

  if (rawInput?.tool_call_name === "spawn_agent") {
    const agentName =
      (typeof rawInput.sub_content === "string" && rawInput.sub_content.trim()) ||
      (typeof title === "string" && title.trim()) ||
      "子智能体";
    const message = typeof rawInput.message === "string" ? rawInput.message : "";
    const summary = message.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    return { name: truncate(agentName), args: truncate(summary) };
  }

  const displayName = preferredDisplayName(name, kind, title);

  let args = "";
  const location = Array.isArray(locations) ? locations[0] : null;
  const pathArg = pickString(rawInput, PATH_KEYS);
  const commandArg = pickString(rawInput, COMMAND_KEYS);
  // 搜索类工具的 path 只是搜索范围，pattern 才是用户真正想看的东西，
  // 所以这里让 pattern 优先于 path。
  const preferCommand = kind === "search" && commandArg;

  if (preferCommand) {
    args = commandArg;
  } else if (location && typeof location.path === "string" && location.path.length > 0) {
    args = displayPath(location.path);
    if (typeof location.line === "number") args += `:${location.line}`;
  } else if (pathArg) {
    args = displayPath(pathArg);
  } else if (commandArg) {
    args = commandArg;
  } else if (typeof title === "string" && title.trim() && title.trim() !== displayName) {
    args = title.trim();
  }

  return { name: truncate(displayName), args: truncate(args) };
}
