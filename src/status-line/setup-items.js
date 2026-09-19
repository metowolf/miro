import { STATUS_LINE_ITEMS, parseStatusLineItems } from "./items.js";

const USE_COLORS_ID = "use-colors";

/** tone → Ink 颜色，与稳定态状态栏保持一致。 */
const TONE_COLORS = {
  model: "yellow",
  dir: "cyan",
  state: "green",
  accent: "blue",
  dim: null,
};

/**
 * 根据当前配置构造面板条目。
 * 已配置项在前并保持顺序，其余项按注册表顺序追加。
 */
export function buildSetupItems(configuredIds, useColors = true) {
  const { items: configured } = parseStatusLineItems(configuredIds);
  const enabled = new Set(configured);
  const orderedIds = [
    ...configured,
    ...Array.from(STATUS_LINE_ITEMS.keys()).filter((id) => !enabled.has(id)),
  ];

  return [
    {
      id: USE_COLORS_ID,
      label: "Use colors",
      description: "Apply colors to status line items",
      enabled: Boolean(useColors),
      orderable: false,
      sectionBreakAfter: true,
    },
    ...orderedIds.map((id) => {
      const item = STATUS_LINE_ITEMS.get(id);
      return {
        id,
        label: item.label,
        enabled: enabled.has(id),
        orderable: true,
      };
    }),
  ];
}

/**
 * 根据面板状态生成可直接渲染的预览 segments。
 * 运行时值缺失、为空或读取失败时回退到注册表中的 placeholder。
 */
export function buildPreviewSegments(items, snapshot = {}, { useColors = true } = {}) {
  const segments = [];

  for (const setupItem of Array.isArray(items) ? items : []) {
    if (!setupItem?.enabled || setupItem.id === USE_COLORS_ID) continue;
    const item = STATUS_LINE_ITEMS.get(setupItem.id);
    if (!item) continue;

    let text = null;
    try {
      text = item.value(snapshot);
    } catch {
      text = null;
    }
    const value = text == null || String(text).trim() === "" ? item.placeholder : String(text).trim();
    if (value == null || String(value).trim() === "") continue;

    const color = TONE_COLORS[item.tone] ?? null;
    segments.push({
      id: item.id,
      text: String(value).trim(),
      color: useColors ? color : null,
      dim: !useColors || color == null,
    });
  }

  return segments;
}
