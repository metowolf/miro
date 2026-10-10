/** 与 Composer 的草稿判定一致：空白和粘贴块也算内容。 */
export function composerHasDraft(snapshot) {
  return Boolean(snapshot?.value) || (snapshot?.pastes?.size ?? 0) > 0;
}

/** 运行中有草稿时，用一行操作提示替代常规状态栏。 */
export function inputHint({ busy, hasDraft, canSteer, queuedCount = 0, queuePaused = false }: any) {
  if (!busy || !hasDraft) return null;
  const action = canSteer
    ? "Enter to steer · Tab to queue"
    : "Enter/Tab to queue · steering unavailable";
  const queue = queuedCount > 0
    ? ` · ${queuedCount} message${queuedCount > 1 ? "s" : ""} queued${queuePaused ? " · paused" : ""}`
    : "";
  return `${action} · Ctrl+Q to review queue${queue}`;
}
