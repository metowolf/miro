/**
 * Token 用量调试日志。
 *
 * 默认关闭；设置 `MIRO_DEBUG_USAGE=1` 后，miro 链路在三个层次各打一行到
 * stderr（TUI 下 stdout 归 Ink，诊断只能走 stderr）：
 *
 *   [miro:usage] sse      … 网关返回的原始 SSE usage 分片
 *   [miro:usage] backend  … pi-ai 归一化后的 usage
 *   [miro:usage] loop     … agent-loop 上报给 store 的 payload
 *
 * 用来定位「cache write 一直是 0」这类问题：究竟是网关根本没上报，还是中间
 * 某一层把它丢了。三层对齐看，缺在哪一层一目了然。
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function usageDebugEnabled() {
  return TRUTHY.has(String(process.env.MIRO_DEBUG_USAGE ?? "").trim().toLowerCase());
}

function safeJson(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** scope 用固定词（sse/backend/loop），payload 是对象或已序列化好的字符串。 */
export function logUsageDebug(scope, payload) {
  if (!usageDebugEnabled()) return;
  const detail = typeof payload === "string" ? payload : safeJson(payload);
  process.stderr.write(`[miro:usage] ${scope} ${detail}\n`);
}
