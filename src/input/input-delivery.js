/** 输入交付的纯逻辑：组件只负责按键接线，client 只负责当前回合的收件箱。 */
export function submissionIntent({ tab = false, shift = false, completion = false, bash = false, busy = false }) {
  if (!tab || shift || completion || bash || !busy) return null;
  return "queue";
}

export function normalizeInput(item) {
  return {
    text: typeof item?.text === "string" ? item.text : "",
    display: typeof item?.display === "string" ? item.display : null,
    ...(typeof item?.id === "string" && item.id ? { id: item.id } : {}),
  };
}

/** 检查点确认优先于可能滞后的 UI 快照；剩余引导恢复成暂停的下一轮输入。 */
export function recoverInputDelivery(uiState, appliedInputs = [], blocks = []) {
  const visible = new Set(blocks.map((block) => block.inputId).filter(Boolean));
  const applied = new Set([...visible, ...appliedInputs.map((input) => input.id)]);
  const recoveredBlocks = [...blocks];
  for (const input of appliedInputs) {
    if (visible.has(input.id)) continue;
    recoveredBlocks.push({ role: "user", text: input.display ?? input.text, inputId: input.id, head: true });
    visible.add(input.id);
  }
  if (!uiState) return { uiState, blocks: recoveredBlocks };
  const pending = (uiState.pendingInputs ?? []).filter((input) => !applied.has(input.id));
  const queued = uiState.queuedInputs.filter((input) => !applied.has(input.id));
  const seen = new Set(pending.map((input) => input.id));
  const recoveredQueue = [...pending, ...queued.filter((input) => !input.id || !seen.has(input.id))];
  return {
    blocks: recoveredBlocks,
    uiState: {
      ...uiState,
      queuedInputs: recoveredQueue,
      ...(uiState.pendingInputs ? { pendingInputs: [] } : {}),
      ...(pending.length || uiState.queuePaused ? { queuePaused: recoveredQueue.length > 0 } : {}),
    },
  };
}
