import {
  diffContent,
  linesOf,
  resolveToolPath,
  truncate,
} from "./shared.js";

const EDIT_PREVIEW_LINES = 400;

export const WRITE_FILE_DEFINITION = {
  name: "write_file",
  kind: "edit",
  title: "Edit",
  description: "Write full file content. Existing files are replaced; used for create and rewrite.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to write, absolute or relative to the workspace." },
      content: { type: "string", description: "Full new file content." },
    },
    required: ["path", "content"],
  },
};

/**
 * Edit：整文件写入。
 *
 * 执行后的 content 带 oldText / newText；审批阶段只有 rawInput.content，
 * extractToolDiff 的 content 分支把它收成新建预览（此时还没读过旧文件）。
 */
export function writeFileTool(cwd) {
  return async (input) => {
    const path = resolveToolPath(cwd, input);
    if (!path) return { error: "edit: missing required parameter 'path'" };
    if (typeof input?.content !== "string") {
      return { error: "edit: missing required parameter 'content' (full file text)" };
    }

    // 路径权限由 agent-loop 统一审批；这里不能再次拦截已获授权的越界写入。
    let oldText = null;
    try {
      oldText = await Bun.file(path).text();
    } catch {
      oldText = null;
    }

    try {
      await Bun.write(path, input.content);
    } catch (error) {
      return { error: `edit: cannot write ${path}: ${error.message}` };
    }

    const lines = linesOf(input.content).length;
    const output = `Wrote ${lines} ${lines === 1 ? "line" : "lines"} to ${path}`;
    const previewOld = oldText == null ? null : truncate(oldText, EDIT_PREVIEW_LINES * 200);
    return {
      output,
      content: diffContent(path, previewOld, truncate(input.content, EDIT_PREVIEW_LINES * 200)),
      locations: [{ path }],
    };
  };
}

// 兼容拆分前的公开导出名。
export const editTool = writeFileTool;
