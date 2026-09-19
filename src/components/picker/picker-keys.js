/**
 * picker 的按键语义归一。
 *
 * 所有键位判断集中在此，组件只消费语义化的 action。
 * 将来若要接键位配置，只需改这一个文件。
 */

/** 去掉换行与控制字符：终端可能把粘贴合并成一个 chunk。 */
export function sanitizeInput(input) {
  return String(input ?? "")
    .replace(/[\r\n]+/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "");
}

/**
 * 这些键一律不进入搜索串，交还给全局快捷键。
 */
function isReservedKey(key) {
  return Boolean(
    key.ctrl ||
      key.meta ||
      key.tab ||
      key.pageUp ||
      key.pageDown ||
      key.leftArrow ||
      key.rightArrow ||
      key.home ||
      key.end,
  );
}

/**
 * 把 ink 的 (input, key) 翻译成 picker action。
 *
 * searchable 为 true 时 j/k 归搜索串，为 false 时绑定为上下移动——
 * 这是有意的取舍（字符不能同时既是导航又是查询），而非偶然的不一致。
 *
 * 返回值形如：
 *   { type: "move", delta: -1 | 1 }
 *   { type: "confirm" }
 *   { type: "cancel" }
 *   { type: "clear-query" }
 *   { type: "append", text }
 *   { type: "backspace" }
 *   { type: "none" }
 */
export function pickerAction(input, key, { searchable = true, hasQuery = false } = {}) {
  if (key.escape) {
    // 有 query 时 Esc 先清空查询，再次按下才取消——两级，不再有第三级。
    return hasQuery ? { type: "clear-query" } : { type: "cancel" };
  }
  if (key.return) return { type: "confirm" };

  if (key.upArrow) return { type: "move", delta: -1 };
  if (key.downArrow) return { type: "move", delta: 1 };

  if (!searchable) {
    if (input === "k") return { type: "move", delta: -1 };
    if (input === "j") return { type: "move", delta: 1 };
    return { type: "none" };
  }

  if (key.backspace || key.delete) return { type: "backspace" };
  if (isReservedKey(key)) return { type: "none" };

  const text = sanitizeInput(input);
  return text ? { type: "append", text } : { type: "none" };
}

/**
 * 底部提示按当前能力生成，不再由调用方传字符串——
 * 文案因此永远不会和实际键位漂移。
 */
export function footerHint({ searchable = true, canGoBack = false } = {}) {
  const parts = [];
  if (searchable) parts.push("Type to filter");
  parts.push("↑↓ to select", "Enter to confirm");
  parts.push(canGoBack ? "Esc to go back" : "Esc to cancel");
  return parts.join("  ·  ");
}
