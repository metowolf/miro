import { buildIgnoreFilter, textContent, truncate } from "./shared.js";

const GLOB_DEFAULT_LIMIT = 1000;
const GLOB_MAX_OUTPUT = 30_000;

export const GLOB_DEFINITION = {
  name: "glob",
  kind: "search",
  title: "Glob",
  description:
    "Find files by glob pattern. Returns matching file paths relative to the search directory. " +
    "Skips version control directories, plus anything the project's .gitignore ignores " +
    "(falling back to common dependency and build directories when there is no .gitignore). " +
    `Output is truncated to ${GLOB_DEFAULT_LIMIT} results by default.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'.",
      },
      path: { type: "string", description: "Directory to search in (default: current directory)." },
      limit: { type: "number", description: "Maximum number of results (default: 1000)." },
    },
    required: ["pattern"],
  },
};

/**
 * Glob：按 glob 模式找文件，纯 Node 实现，不依赖 fd 是否存在。
 *
 * 参数：pattern / path / limit。
 */
export function globTool(cwd) {
  return async (input) => {
    const pattern = typeof input?.pattern === "string" ? input.pattern : "";
    if (!pattern) return { error: "glob: missing required parameter 'pattern'" };

    const { glob, stat } = await import("node:fs/promises");
    const nodePath = await import("node:path");

    const limit = Number(input?.limit) > 0 ? Math.floor(Number(input.limit)) : GLOB_DEFAULT_LIMIT;
    const rawPath = typeof input?.path === "string" && input.path.length > 0 ? input.path : ".";
    const searchRoot = nodePath.isAbsolute(rawPath) ? rawPath : nodePath.join(cwd, rawPath);

    try {
      const rootInfo = await stat(searchRoot);
      if (!rootInfo.isDirectory()) return { error: `glob: not a directory: ${searchRoot}` };
    } catch {
      return { error: `glob: path not found: ${searchRoot}` };
    }

    const ignoreFilter = await buildIgnoreFilter(searchRoot);

    const matches = [];
    let limitReached = false;
    try {
      for await (const entry of glob(pattern, {
        cwd: searchRoot,
        dot: false,
        exclude: ignoreFilter.isIgnoredEntry,
      })) {
        if (ignoreFilter.isIgnoredPath(entry)) continue;

        // 只报告文件，目录命中对调用方没有价值。
        let info;
        try {
          info = await stat(nodePath.join(searchRoot, entry));
        } catch {
          continue;
        }
        if (!info.isFile()) continue;

        matches.push(entry);
        if (matches.length >= limit) {
          limitReached = true;
          break;
        }
      }
    } catch (error) {
      return { error: `glob: invalid pattern: ${error.message}` };
    }

    if (matches.length === 0) {
      const output = "No files found matching pattern";
      return { output, content: textContent(output) };
    }

    matches.sort((a, b) => a.localeCompare(b));
    const suffix = limitReached
      ? `\n\n[${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern]`
      : "";
    const output = truncate(`${matches.join("\n")}${suffix}`, GLOB_MAX_OUTPUT);
    return { output, content: textContent(output) };
  };
}
