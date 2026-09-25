import { stringWidth } from "../../markdown-width.js";
import { pickerViewport } from "../picker-viewport.js";
import { truncateToCellWidth } from "./picker-rows.js";

/** 内联补全给输入框、底栏和提示留空间，极矮窗口至少保留当前候选。 */
export function completionViewport({ index, total, rows, inputRows = 3, surroundingRows = 3 }) {
  return pickerViewport({
    index,
    total,
    rows,
    // 输入框高度含边框；外侧预算含上边距、状态栏和排队提示。
    // 再留一行操作提示和一行余量，避免候选把 live region 顶成整屏帧。
    reservedRows: Math.max(3, inputRows) + surroundingRows + 2,
    maxVisible: 8,
  });
}

/** 窄窗口先缩提示，始终优先保留真实的位置/总数。 */
export function completionHint(width, viewport, total) {
  const position = total > viewport.size ? `${viewport.index + 1}/${total}` : "";
  const budget = width - stringWidth(position) - (position ? 2 : 0);
  const hint = [
    "↑↓ to select · Tab/Enter to complete · Esc to dismiss",
    "↑↓ · Tab/Enter · Esc",
    "Tab · Esc",
  ].find((text) => stringWidth(text) <= budget) ?? "";
  return truncateToCellWidth([hint, position].filter(Boolean).join("  "), width);
}
