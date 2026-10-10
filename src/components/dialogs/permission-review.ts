import { extractToolDiff } from "../../transcript/tool-diff.ts";

function isMcpCall(toolCall) {
  return toolCall?.name === "mcp_call";
}

export function permissionTitle(toolCall) {
  if (isMcpCall(toolCall)) return "MCP tool call";
  switch (toolCall?.kind) {
    case "execute": return "Bash command";
    case "edit": return "Edit file";
    case "read": return "Read file";
    case "delete": return "Delete file";
    case "fetch": return "Fetch";
    case "plan": return "Plan";
    default: return toolCall?.title || "Tool call";
  }
}

function inputText(input) {
  if (input == null) return "";
  try { return JSON.stringify(input, null, 2); }
  catch { return String(input); }
}

export function permissionReview(toolCall) {
  // 远端字段没有本地文件/命令语义，必须保留完整参数供用户核对。
  if (isMcpCall(toolCall)) return { diff: null, text: inputText(toolCall.rawInput) };
  const diff = extractToolDiff(toolCall);
  if (toolCall?.command) return { diff, text: String(toolCall.command) };
  const input = toolCall?.rawInput;
  if (input != null && typeof input === "object") {
    // 计划正文是 markdown，避免转为带转义字符的 JSON。
    if (typeof input.plan === "string") return { diff, text: input.plan };
    const path = input.path ?? input.file_path ?? input.filePath ?? input.filename;
    const body = input.patch ?? input.diff ?? input.content ?? input.new_content ?? input.newText;
    if (typeof body === "string") return { diff, text: `${path ? `Path: ${path}\n\n` : ""}${body}` };
  }
  return { diff, text: inputText(input) };
}
