import { STATUS_LINE_ITEMS, parseStatusLineItems } from "./items.js";

/** 状态栏 segment 分隔符。 */
export const STATUS_LINE_SEPARATOR = " · ";

/** tone → Ink 颜色；useColors=false 时统一走 dim。 */
const TONE_COLORS = {
  model: "yellow",
  dir: "cyan",
  state: "green",
  accent: "blue",
  dim: null,
};

/**
 * 由配置 id 列表 + 运行时快照生成 segments。
 * 取值为 null 的项直接跳过；非法 id 收集在 invalid 里供调用方告警。
 */
export function buildStatusLineSegments(ids, snapshot = {}, { useColors = true } = {}) {
  const { items, invalid } = parseStatusLineItems(ids);
  const segments = [];
  for (const id of items) {
    const item = STATUS_LINE_ITEMS.get(id);
    if (!item) continue;
    let text = null;
    try {
      text = item.value(snapshot);
    } catch {
      text = null;
    }
    if (text == null) continue;
    const value = String(text).trim();
    if (value.length === 0) continue;
    segments.push({
      id,
      text: value,
      color: useColors ? (TONE_COLORS[item.tone] ?? null) : null,
      dim: !useColors || TONE_COLORS[item.tone] == null,
    });
  }
  return { segments, invalid };
}

/** 纯文本渲染，供测试与非彩色场景使用。 */
export function statusLineText(ids, snapshot = {}, options = {}) {
  const { segments } = buildStatusLineSegments(ids, snapshot, options);
  return segments.map((segment) => segment.text).join(STATUS_LINE_SEPARATOR);
}
