import { open, realpath, stat } from "node:fs/promises";
import nodePath from "node:path";

import { textContent } from "./shared.js";

const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LIMIT = 10_000;
const READ_MAX_BYTES = 512 * 1024;
const READ_OUTPUT_RESERVE_BYTES = 1024;
const READ_MAX_LINE_BYTES = 16 * 1024;
const BINARY_SAMPLE_BYTES = 4096;
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
  "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/console",
  "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
]);

export const READ_FILE_DEFINITION = {
  name: "read_file",
  kind: "read",
  title: "Read",
  description: `Read a text file from the workspace with line numbers. Defaults to ${READ_DEFAULT_LIMIT} lines and at most ${READ_MAX_BYTES / 1024} KiB; use zero-based offset/limit to page through the rest. Binary files and directories are rejected.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to read, absolute or relative to the workspace." },
      offset: { type: "integer", minimum: 0, description: "Zero-based line offset to start from." },
      limit: { type: "integer", minimum: 1, maximum: READ_MAX_LIMIT, description: "Maximum number of lines to return." },
    },
    required: ["path"],
  },
};

function inputInteger(value, name, { defaultValue, min, max }) {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return { error: `read: '${name}' must be an integer between ${min} and ${max}` };
  }
  return { value };
}

function isBinary(bytes) {
  if (bytes.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1;
  }
  return nonPrintable / bytes.length > 0.3;
}

function clipUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, clipped: false };
  let end = 0;
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return { text: `${text.slice(0, end)}… [line truncated]`, clipped: true };
}

/** 逐块读取，绝不把整个文件或单条超长行留在内存中。 */
async function readTextRange(path, offset, limit) {
  const handle = await open(path, "r");
  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead: sampleSize } = await handle.read(sample, 0, sample.length, 0);
    if (isBinary(sample.subarray(0, sampleSize))) return { error: `read: cannot read binary file: ${path}` };

    const decoder = new TextDecoder("utf-8");
    const buffer = Buffer.alloc(64 * 1024);
    const rows = [];
    let position = 0;
    let lineNumber = 0;
    let currentLine = "";
    let currentLineClipped = false;
    let outputBytes = 0;
    let more = false;
    let stopped = false;
    let linesClipped = false;

    const addText = (text) => {
      if (currentLineClipped || text === "") return;
      const clipped = clipUtf8(`${currentLine}${text}`, READ_MAX_LINE_BYTES);
      currentLine = clipped.text;
      currentLineClipped = clipped.clipped;
    };
    const finishLine = () => {
      lineNumber += 1;
      if (lineNumber <= offset) {
        currentLine = "";
        currentLineClipped = false;
        return;
      }
      if (rows.length >= limit) {
        more = true;
        stopped = true;
        return;
      }
      if (currentLineClipped) linesClipped = true;
      const line = currentLine.endsWith("\r") ? currentLine.slice(0, -1) : currentLine;
      const label = `${lineNumber}→${line}`;
      const size = Buffer.byteLength(label, "utf8") + (rows.length > 0 ? 1 : 0);
      if (outputBytes + size > READ_MAX_BYTES - READ_OUTPUT_RESERVE_BYTES) {
        more = true;
        stopped = true;
        return;
      }
      rows.push(label);
      outputBytes += size;
      currentLine = "";
      currentLineClipped = false;
    };

    while (!stopped) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        if (newline === -1) {
          addText(text.slice(start));
          break;
        }
        addText(text.slice(start, newline));
        finishLine();
        if (stopped) break;
        start = newline + 1;
      }
    }

    if (!stopped) {
      addText(decoder.decode());
      // 与既有 linesOf() 一致：文件末尾的换行不额外算一条空行。
      if (currentLine !== "" || currentLineClipped) finishLine();
    }

    if (rows.length === 0) {
      if (lineNumber === 0 && offset === 0) return { output: "[empty file]" };
      return { error: `read: offset ${offset} is beyond end of file (${lineNumber} lines total)` };
    }

    const firstLine = offset + 1;
    const lastLine = offset + rows.length;
    const notice = more
      ? `[showed lines ${firstLine}-${lastLine}; more content remains; use offset=${lastLine} for the rest]`
      : `[end of file; showed lines ${firstLine}-${lastLine} of ${lineNumber}]`;
    const clippingNotice = linesClipped
      ? `\n[one or more lines were truncated to ${READ_MAX_LINE_BYTES / 1024} KiB; use grep or terminal for an exact long-line slice]`
      : "";
    return { output: `${rows.join("\n")}\n\n${notice}${clippingNotice}` };
  } finally {
    await handle.close();
  }
}

/** Read：按行和 UTF-8 字节预算分页读取文本文件。 */
export function readTool(cwd) {
  return async (input) => {
    const rawPath = typeof input?.path === "string" && input.path.trim() ? input.path : null;
    if (!rawPath) return { error: "read: missing required parameter 'path'" };
    const parsedOffset = inputInteger(input?.offset, "offset", { defaultValue: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    if (parsedOffset.error) return { error: parsedOffset.error };
    const parsedLimit = inputInteger(input?.limit, "limit", { defaultValue: READ_DEFAULT_LIMIT, min: 1, max: READ_MAX_LIMIT });
    if (parsedLimit.error) return { error: parsedLimit.error };

    const requestedPath = nodePath.resolve(cwd, rawPath);
    if (BLOCKED_DEVICE_PATHS.has(requestedPath)) return { error: `read: refusing unsafe device path: ${requestedPath}` };

    let path;
    let info;
    try {
      path = await realpath(requestedPath);
      info = await stat(path);
    } catch (error) {
      return { error: `read: cannot read ${requestedPath}: ${error.message}` };
    }
    if (info.isDirectory()) return { error: `read: path is a directory; use glob instead: ${path}` };
    if (!info.isFile()) return { error: `read: path is not a regular file: ${path}` };

    let result;
    try {
      result = await readTextRange(path, parsedOffset.value, parsedLimit.value);
    } catch (error) {
      // stat 与打开文件之间可能被删除或改权限；工具错误要回灌给模型而非打断循环。
      return { error: `read: cannot read ${path}: ${error.message}` };
    }
    if (result.error) return { error: result.error };

    return {
      output: result.output,
      content: textContent(result.output),
      locations: [{ path, line: parsedOffset.value + 1 }],
    };
  };
}
