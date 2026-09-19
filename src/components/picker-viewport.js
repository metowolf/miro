/** picker 在不同终端高度下的展示密度。 */
export function pickerDensity(rows) {
  const height = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
  if (height < 9) return "minimal";
  if (height < 16) return "compact";
  return "full";
}

/**
 * 按终端剩余行数裁切列表，并始终把当前选中项留在窗口中。
 * reservedRows 包含边框、搜索框、标题和提示等列表外的行。
 */
export function pickerViewport({
  index,
  total,
  rows,
  reservedRows,
  maxVisible = 10,
  minVisible = 1,
}) {
  const count = Math.max(0, Math.floor(total));
  if (count === 0) return { index: 0, size: 0, start: 0, end: 0, above: 0, below: 0 };

  const height = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
  const selected = Math.max(0, Math.min(Math.floor(index), count - 1));
  const budget = Math.max(minVisible, height - Math.max(0, reservedRows));
  const size = Math.min(count, Math.max(1, Math.min(maxVisible, budget)));
  const start = count <= size
    ? 0
    : Math.max(0, Math.min(selected - Math.floor(size / 2), count - size));
  const end = start + size;

  return {
    index: selected,
    size,
    start,
    end,
    above: start,
    below: Math.max(0, count - end),
  };
}
