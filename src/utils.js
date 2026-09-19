export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

let counter = 0;

export function nextId() {
  counter += 1;
  return `b${counter}`;
}

/**
 * 时长只按整数秒展示；不足 1 秒返回 null 而不是 "0s"。
 *
 * 「0s」没有任何信息量（大多数工具调用都跑不到一秒），但各调用点都把它拼进
 * ` · ${duration}` 之类的片段里，所以这里返回 null 而不是空串：空串会留下一串
 * 孤立的分隔符，调用方必须显式按「有没有值」决定整段计时是否渲染。
 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds === 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
