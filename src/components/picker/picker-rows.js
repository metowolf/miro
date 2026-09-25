/**
 * picker 的行模型归一化与布局计算（纯函数，便于单测）。
 *
 * 行模型故意做宽（groupName / right / current / disabled），
 * 避免调用方因为装不下自己的字段而绕过通用组件另抄一套。
 */

import { stringWidth } from "../../markdown-width.js";

/**
 * 归一化单行。label 缺省时依次回落 name → value。
 * 返回对象保留原始 item 于 source，供 onSelect 回传完整领域对象。
 */
export function normalizeItem(item, index) {
  const raw = item ?? {};
  const value = raw.value;
  const label = raw.label ?? raw.name ?? (value == null ? "" : String(value));
  return {
    // 用「下标:value」而不是裸 value：两个提供方共用同一 id 时 Ink 会把
    // 重复 key 绘成幽灵行（同一条模型刷出多份、箭头同时出现在好几行上）。
    key: value == null ? `row-${index}` : `${index}:${value}`,
    value,
    label: String(label),
    description: raw.description == null ? "" : String(raw.description),
    groupName: raw.groupName == null ? "" : String(raw.groupName),
    right: raw.right == null ? "" : String(raw.right),
    current: Boolean(raw.current),
    disabled: Boolean(raw.disabled),
    disabledReason: raw.disabledReason == null ? "" : String(raw.disabledReason),
    source: raw,
  };
}

export function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map(normalizeItem);
}

/** 首个可选行下标；全部不可选时返回 0。 */
export function firstSelectableIndex(rows) {
  const index = rows.findIndex((row) => !row.disabled);
  return index === -1 ? 0 : index;
}

/**
 * 初始选中下标：显式 selected 优先（且必须可选），否则定位到 current 项，
 * 再否则取首个可选行。这样没有 current 概念的 picker
 * 迁移后能自动落在当前值上。
 */
export function initialIndex(rows, selected) {
  if (rows.length === 0) return 0;
  if (Number.isInteger(selected) && selected >= 0 && selected < rows.length && !rows[selected].disabled) {
    return selected;
  }
  const current = rows.findIndex((row) => row.current && !row.disabled);
  if (current !== -1) return current;
  return firstSelectableIndex(rows);
}

/**
 * 按 delta 移动并跳过 disabled 行，环绕。
 * 无可选行时返回原下标，避免死循环。
 */
export function moveIndex(rows, index, delta) {
  const total = rows.length;
  if (total === 0) return 0;
  if (!rows.some((row) => !row.disabled)) return index;

  const step = delta < 0 ? -1 : 1;
  let cursor = index;
  for (let hop = 0; hop < total; hop += 1) {
    cursor = (cursor + step + total) % total;
    if (!rows[cursor].disabled) return cursor;
  }
  return index;
}

/** 按终端 cell 宽度截断，避免 CJK/emoji 把右栏挤出边界。 */
export function truncateToCellWidth(text, width) {
  const source = String(text ?? "");
  const limit = Math.max(0, Math.floor(width));
  if (stringWidth(source) <= limit) return source;
  if (limit === 0) return "";
  if (limit === 1) return "…";

  let output = "";
  for (const character of source) {
    if (stringWidth(output + character) > limit - 1) break;
    output += character;
  }
  return `${output}…`;
}

const pathGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function pathCells(text, width, fromEnd = false) {
  const parts = Array.from(pathGraphemes.segment(text), (part) => part.segment);
  if (fromEnd) parts.reverse();
  const kept = [];
  let used = 0;
  for (const part of parts) {
    const cells = stringWidth(part);
    if (used + cells > width) break;
    kept.push(part);
    used += cells;
  }
  return (fromEnd ? kept.reverse() : kept).join("");
}

/** 路径只在展示时省略中段，优先保留 basename、扩展名和目录尾斜线。 */
export function truncatePathToCellWidth(text, width) {
  const source = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g,
    (char) => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" }[char] ?? "�"));
  const limit = Math.max(0, Math.floor(width));
  if (stringWidth(source) <= limit) return source;
  if (limit === 0) return "";
  if (limit === 1) return "…";

  const slash = source.lastIndexOf("/", source.endsWith("/") ? source.length - 2 : source.length - 1);
  const basename = source.slice(slash + 1);
  if (slash >= 0) {
    const suffix = source.slice(slash);
    if (stringWidth(suffix) < limit) {
      return `${pathCells(source.slice(0, slash), limit - 1 - stringWidth(suffix))}…${suffix}`;
    }
    if (stringWidth(basename) < limit) return `…${basename}`;
  }
  const suffix = pathCells(basename, Math.floor((limit - 1) / 2), true);
  return `${pathCells(basename, limit - 1 - stringWidth(suffix))}…${suffix}`;
}

/**
 * 左右两栏布局：右栏最多占内容宽度的一半，左栏吃掉剩余空间。
 * 内容宽度过窄（< 8）时放弃右栏，全部给左栏。
 */
export function splitRowWidth(innerWidth, prefixWidth, rightText) {
  const contentWidth = Math.max(0, innerWidth - prefixWidth);
  const value = String(rightText ?? "");
  const showRight = Boolean(value) && contentWidth >= 8;
  const rightWidth = showRight
    ? Math.min(stringWidth(value), Math.max(3, Math.floor(contentWidth / 2)))
    : 0;
  const leftWidth = Math.max(0, contentWidth - rightWidth - (showRight ? 1 : 0));
  return { showRight, leftWidth, rightWidth, contentWidth };
}

/**
 * 紧凑两列布局：左栏只占 label 的实际宽度、右栏紧贴其后（间距恒为 1 格），
 * 于是两列的起始位置与终端宽度无关——调用方给出的列头因此能和行用同一套
 * 宽度推导对齐。宽度只剩一格时放弃右栏，回退成单栏。
 */
export function compactRowWidth(innerWidth, prefixWidth, labelText) {
  const contentWidth = Math.max(0, innerWidth - prefixWidth);
  const leftWidth = Math.min(stringWidth(labelText), Math.max(0, contentWidth - 1));
  const rightWidth = Math.max(0, contentWidth - leftWidth - 1);
  return { showRight: rightWidth > 0, leftWidth, rightWidth, contentWidth };
}
