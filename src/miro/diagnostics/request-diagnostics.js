import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value == null || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonical(value[key]);
  return output;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block?.text === "string" ? block.text : "").join("");
}

/** 只哈希实际 system prompt 与工具 schema；消息历史不参与。 */
export function assemblyFingerprint(messages, tools) {
  const systemPrompt = (messages ?? [])
    .filter((message) => message?.role === "system")
    .map((message) => textContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const encoded = JSON.stringify(canonical({ systemPrompt, tools: tools ?? [] }));
  return {
    hash: createHash("sha256").update(encoded).digest("hex").slice(0, 16),
    systemBytes: Buffer.byteLength(systemPrompt),
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(tools ?? [])),
    toolCount: Array.isArray(tools) ? tools.length : 0,
  };
}

/** 按 tool_call_id 把历史里的工具结果字节量归因到工具名，不返回原始内容。 */
export function toolContextStats(messages) {
  const names = new Map();
  for (const message of messages ?? []) {
    if (message?.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call?.id != null) names.set(String(call.id), call?.function?.name ?? "unknown");
    }
  }

  const totals = new Map();
  let totalBytes = 0;
  let largest = null;
  for (const message of messages ?? []) {
    if (message?.role !== "tool") continue;
    const id = String(message.tool_call_id ?? "");
    const name = names.get(id) ?? "unknown";
    const bytes = Buffer.byteLength(textContent(message.content));
    totalBytes += bytes;
    totals.set(name, (totals.get(name) ?? 0) + bytes);
    if (largest == null || bytes > largest.bytes) largest = { name, toolCallId: id, bytes };
  }

  return {
    totalBytes,
    byTool: [...totals.entries()]
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name)),
    largest,
  };
}
