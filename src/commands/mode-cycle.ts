/** 返回下一个 modeId；无可切换项时返回 null。 */
export function getNextModeId(modes) {
  if (!modes || !Array.isArray(modes.availableModes)) return null;
  const list = modes.availableModes;
  if (list.length <= 1) return null;

  const current = modes.currentModeId;
  const index = list.findIndex((mode) => mode.id === current);
  const nextIndex = (index + 1) % list.length;
  return list[nextIndex]?.id ?? null;
}
