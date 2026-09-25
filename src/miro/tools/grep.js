import { buildIgnoreFilter, linesOf, textContent, truncate } from "./shared.js";

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_FILE_BYTES = 512 * 1024;
const GREP_MAX_OUTPUT = 30_000;
const GREP_MAX_LINE_LENGTH = 500;

export const GREP_DEFINITION = {
  name: "grep",
  kind: "search",
  title: "Grep",
  description:
    "Search file contents for a pattern. Returns matching lines with file paths and line numbers. " +
    "Directory searches skip version control directories and respect parent and nested .gitignore rules. " +
    "Common dependency and build directories are also skipped unless explicitly unignored. " +
    "An explicit file path bypasses ignore rules. " +
    `Output is truncated to ${GREP_DEFAULT_LIMIT} matches by default; ` +
    `long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex or literal string)." },
      path: { type: "string", description: "Directory or file to search (default: current directory)." },
      glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'." },
      ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)." },
      literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)." },
      context: { type: "number", description: "Number of lines to show before and after each match (default: 0)." },
      limit: { type: "number", description: "Maximum number of matches to return (default: 100)." },
    },
    required: ["pattern"],
  },
};

/** 正则元字符转义，供 literal 模式复用同一套匹配管线。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把每个命中的 [index - context, index + context] 收成互不重叠的区间。
 * 相邻区间也合并：中间没有空隙，分开渲染只会多出一行重复上下文。
 */
export function mergeMatchRanges(matchIndices, contextLines, lineCount) {
  const ranges = [];
  for (const index of matchIndices) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lineCount - 1, index + contextLines);
    const last = ranges.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

/** 单条超长行截断，避免一行 minified 代码吃掉整个输出预算。 */
function clipLine(text) {
  if (text.length <= GREP_MAX_LINE_LENGTH) return { text, clipped: false };
  return { text: `${text.slice(0, GREP_MAX_LINE_LENGTH)}…`, clipped: true };
}

/**
 * Grep：目录内递归搜索内容，纯 Node 实现，不依赖 ripgrep 是否存在。
 *
 * 参数：pattern / path / glob / ignoreCase / literal / context / limit。
 */
export function grepTool(cwd) {
  return async (input) => {
    const pattern = typeof input?.pattern === "string" ? input.pattern : "";
    if (!pattern) return { error: "grep: missing required parameter 'pattern'" };

    const { glob, readFile, stat } = await import("node:fs/promises");
    const nodePath = await import("node:path");

    const literal = input?.literal === true;
    const flags = input?.ignoreCase === true ? "i" : "";
    let matcher;
    try {
      matcher = new RegExp(literal ? escapeRegExp(pattern) : pattern, flags);
    } catch (error) {
      return { error: `grep: invalid pattern: ${error.message}` };
    }

    const contextLines = Math.max(0, Number(input?.context) || 0);
    const limit = Number(input?.limit) > 0 ? Math.floor(Number(input.limit)) : GREP_DEFAULT_LIMIT;

    // path 既可指向目录也可指向单个文件；单文件时直接搜它，不再遍历。
    const rawPath = typeof input?.path === "string" && input.path.length > 0 ? input.path : ".";
    const searchRoot = nodePath.isAbsolute(rawPath) ? rawPath : nodePath.join(cwd, rawPath);

    let rootInfo;
    try {
      rootInfo = await stat(searchRoot);
    } catch {
      return { error: `grep: path not found: ${searchRoot}` };
    }

    const globPattern = typeof input?.glob === "string" && input.glob.length > 0 ? input.glob : "**/*";
    let files;
    if (rootInfo.isFile()) {
      files = [{ display: nodePath.basename(searchRoot), absolute: searchRoot }];
    } else {
      const ignoreFilter = await buildIgnoreFilter(searchRoot, { cwd });
      files = [];
      for await (const entry of glob(globPattern, {
        cwd: searchRoot,
        dot: false,
        withFileTypes: true,
        exclude: ignoreFilter.isIgnoredEntry,
      })) {
        const absolute = nodePath.join(entry.parentPath ?? entry.path, entry.name);
        if (ignoreFilter.isIgnoredPath(absolute, entry.isDirectory())) continue;
        files.push({ display: nodePath.relative(searchRoot, absolute), absolute });
      }
      files.sort((a, b) => a.display.localeCompare(b.display));
    }

    const results = [];
    let matchCount = 0;
    let limitReached = false;
    let linesClipped = false;

    for (const file of files) {
      if (limitReached) break;
      const matchIndices = [];

      let info;
      try {
        info = await stat(file.absolute);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) continue;

      let content;
      try {
        content = await readFile(file.absolute, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;

      const lines = linesOf(content);
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index])) continue;

        matchIndices.push(index);
        matchCount += 1;
        if (matchCount >= limit) {
          limitReached = true;
          break;
        }
      }

      // 上下文块按命中合并：相邻命中的 [i-context, i+context] 会重叠，
      // 逐命中输出会把同一行印两遍，既污染模型上下文也浪费单回合预算。
      if (contextLines === 0) {
        for (const matchIndex of matchIndices) {
          const { text, clipped } = clipLine(lines[matchIndex]);
          if (clipped) linesClipped = true;
          results.push(`${file.display}:${matchIndex + 1}: ${text}`);
        }
      } else {
        const matchSet = new Set(matchIndices);
        for (const range of mergeMatchRanges(matchIndices, contextLines, lines.length)) {
          for (let current = range.start; current <= range.end; current += 1) {
            const { text, clipped } = clipLine(lines[current]);
            if (clipped) linesClipped = true;
            const separator = matchSet.has(current) ? ":" : "-";
            results.push(`${file.display}${separator}${current + 1}${separator} ${text}`);
          }
        }
      }
    }

    if (matchCount === 0) {
      const output = "No matches found";
      return { output, content: textContent(output) };
    }

    const notices = [];
    if (limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    if (linesClipped) {
      notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read_file to see full lines`);
    }
    const suffix = notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "";
    const output = truncate(`${results.join("\n")}${suffix}`, GREP_MAX_OUTPUT);
    return { output, content: textContent(output) };
  };
}
