/**
 * 发给 provider 前的历史合法化。主循环正常路径已经保证每个调用恰有一条结果；
 * 这里兜住恢复、压缩和异常历史，避免一条孤儿结果让整个会话永久 400。
 */

export const SYNTHETIC_TOOL_RESULT = "No result provided (history was incomplete)";

function callsOf(message) {
  return Array.isArray(message?.tool_calls) ? message.tool_calls.filter((call) => call?.id != null) : [];
}

/**
 * 不修改输入；工具结果按声明顺序输出，孤儿与重复项丢弃，缺失项补错误桩。
 */
export function normalizeOutboundMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const output = [];

  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (message?.role === "tool") continue;
    output.push(message);

    if (message?.role !== "assistant") continue;
    const calls = callsOf(message);
    if (calls.length === 0) continue;

    const declared = new Set(calls.map((call) => String(call.id)));
    const results = new Map();
    let cursor = index + 1;
    while (cursor < source.length && source[cursor]?.role === "tool") {
      const result = source[cursor];
      const id = String(result.tool_call_id ?? "");
      if (declared.has(id) && !results.has(id)) results.set(id, result);
      cursor += 1;
    }

    for (const call of calls) {
      const id = String(call.id);
      output.push(results.get(id) ?? {
        role: "tool",
        tool_call_id: id,
        content: SYNTHETIC_TOOL_RESULT,
        miro_synthetic: true,
      });
    }
    index = cursor - 1;
  }

  return output;
}
