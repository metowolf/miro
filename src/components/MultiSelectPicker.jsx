import { Box, Text, useInput } from "ink";
import { useReducer, useRef } from "react";

import { useInputCursor } from "../hooks/use-input-cursor.js";
import { stringWidth } from "../markdown-width.js";

export const MULTI_SELECT_MAX_VISIBLE = 10;
const PREVIEW_SEPARATOR = " · ";

function cleanItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    enabled: Boolean(item.enabled),
    orderable: item.orderable !== false,
  }));
}

function searchableText(item) {
  return [item.id, item.name, item.label, item.description]
    .filter((value) => value != null)
    .join(" ")
    .toLowerCase();
}

export function filterMultiSelectItems(items, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => searchableText(item).includes(needle));
}

export function createMultiSelectState(items) {
  const normalized = cleanItems(items);
  return {
    items: normalized,
    query: "",
    selectedId: normalized[0]?.id ?? null,
  };
}

function selectedVisibleIndex(state, visible) {
  const index = visible.findIndex((item) => item.id === state.selectedId);
  return index < 0 ? 0 : index;
}

/** 纯状态机同时供组件和按键行为测试使用。 */
export function multiSelectReducer(state, action) {
  switch (action.type) {
    case "move-cursor": {
      const visible = filterMultiSelectItems(state.items, state.query);
      if (visible.length === 0) return state;
      const index = selectedVisibleIndex(state, visible);
      const next = (index + action.delta + visible.length) % visible.length;
      return { ...state, selectedId: visible[next].id };
    }
    case "toggle": {
      if (action.id == null) return state;
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.id ? { ...item, enabled: !item.enabled } : item
        ),
      };
    }
    case "reorder": {
      // 搜索结果不是完整顺序，过滤时禁止排序以避免意外移动隐藏条目。
      if (state.query || action.id == null) return state;
      const index = state.items.findIndex((item) => item.id === action.id);
      const target = index + action.delta;
      if (index < 0 || target < 0 || target >= state.items.length) return state;
      if (state.items[index].orderable === false || state.items[target].orderable === false) {
        return state;
      }
      const items = [...state.items];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...state, items };
    }
    case "set-query": {
      const query = action.query;
      const visible = filterMultiSelectItems(state.items, query);
      return { ...state, query, selectedId: visible[0]?.id ?? null };
    }
    default:
      return state;
  }
}

/**
 * onConfirm 的稳定返回结构。items 包含 use-colors 及所有未勾选项，并保留当前顺序。
 */
export function multiSelectConfirmation(state) {
  const items = state.items.map((item) => ({ ...item }));
  return {
    items,
    useColors: Boolean(items.find((item) => item.id === "use-colors")?.enabled),
  };
}

function windowStart(index, total, size) {
  if (total <= size) return 0;
  return Math.max(0, Math.min(index - Math.floor(size / 2), total - size));
}

function sanitizeInput(input) {
  return String(input ?? "").replace(/[\r\n]+/g, "").replace(/[\u0000-\u001F\u007F]/g, "");
}

function itemName(item) {
  if (item.name != null) return String(item.name);
  if (item.id === "use-colors") return "Use colors";
  return String(item.id ?? "");
}

function itemDescription(item) {
  if (item.description != null) return String(item.description);
  if (item.label != null && String(item.label) !== itemName(item)) return String(item.label);
  return "";
}

function previewSegments(preview) {
  if (Array.isArray(preview)) return preview;
  if (Array.isArray(preview?.segments)) return preview.segments;
  return null;
}

export function MultiSelectPicker({
  title,
  subtitle,
  items = [],
  columns = 80,
  renderPreview,
  onConfirm,
  onCancel,
}) {
  const [state, dispatch] = useReducer(multiSelectReducer, items, createMultiSelectState);
  const visibleItems = filterMultiSelectItems(state.items, state.query);
  const index = selectedVisibleIndex(state, visibleItems);
  const selected = visibleItems[index] ?? null;
  const useColors = Boolean(state.items.find((item) => item.id === "use-colors")?.enabled);
  // 搜索框的真实光标：这一行是 wrap="truncate"，超宽只截断不折行
  // （见 use-input-cursor.js）。
  const queryRef = useRef(null);
  useInputCursor(queryRef, stringWidth(state.query), { truncate: true });

  useInput((input, key) => {
    if (key.escape) {
      if (state.query) dispatch({ type: "set-query", query: "" });
      else onCancel();
      return;
    }
    if (key.return) {
      onConfirm(multiSelectConfirmation(state));
      return;
    }
    if (key.upArrow) {
      dispatch({ type: "move-cursor", delta: -1 });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: "move-cursor", delta: 1 });
      return;
    }
    if (input === " ") {
      if (selected) dispatch({ type: "toggle", id: selected.id });
      return;
    }
    if (key.leftArrow || (key.ctrl && input === "h")) {
      if (selected) dispatch({ type: "reorder", id: selected.id, delta: -1 });
      return;
    }
    if (key.rightArrow || (key.ctrl && input === "l")) {
      if (selected) dispatch({ type: "reorder", id: selected.id, delta: 1 });
      return;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: "set-query", query: [...state.query].slice(0, -1).join("") });
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.pageUp || key.pageDown) return;
    if (key.home || key.end) return;
    const text = sanitizeInput(input);
    if (text) dispatch({ type: "set-query", query: state.query + text });
  });

  const size = Math.min(visibleItems.length, MULTI_SELECT_MAX_VISIBLE);
  const start = windowStart(index, visibleItems.length, size);
  const visible = visibleItems.slice(start, start + size);
  const above = start;
  const below = Math.max(0, visibleItems.length - start - size);
  const preview = renderPreview?.(state.items, { useColors });
  const segments = previewSegments(preview);
  const hasSegments = segments && segments.length > 0;
  const hasCustomPreview = segments == null && preview != null && preview !== "";
  const innerWidth = Math.max(24, columns - 4);

  return (
    <Box flexDirection="column">
      <Text inverse bold>{` ${title} `}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}

      <Box marginTop={1} borderStyle="single" borderColor={state.query ? "cyan" : "gray"} paddingX={1}>
        {/* ref 挂在内层：量到的才是文本区（含宽度与起点），边框与内边距自己带上。 */}
        <Box ref={queryRef}>
          <Text wrap="truncate">
            {state.query || <Text dimColor>Type to search...</Text>}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {above > 0 ? <Text dimColor>{`↑ ${above} more above`}</Text> : null}
        {visible.map((item, offset) => {
          const active = start + offset === index;
          const description = itemDescription(item);
          return (
            <Box key={item.id ?? `${start}-${offset}`} flexDirection="column">
              <Text wrap="truncate">
                <Text color={active ? "cyan" : undefined} bold={active}>
                  {active ? "> " : "  "}[{item.enabled ? "x" : " "}] {itemName(item)}
                </Text>
                {description ? <Text dimColor>  {description}</Text> : null}
              </Text>
              {(item.sectionBreakAfter || item.section_break_after) ? (
                <Text dimColor>{"  "}{"─".repeat(Math.max(1, innerWidth - 2))}</Text>
              ) : null}
            </Box>
          );
        })}
        {below > 0 ? <Text dimColor>{`↓ ${below} more below`}</Text> : null}
        {visibleItems.length === 0 ? <Text dimColor>No matching items</Text> : null}
      </Box>

      <Box marginTop={1}>
        <Text wrap="truncate" dimColor={!useColors || (!hasSegments && !hasCustomPreview)}>
          {hasSegments
            ? segments.map((segment, segmentIndex) => (
                <Text key={segment.id ?? segmentIndex}>
                  {segmentIndex > 0 ? <Text dimColor>{PREVIEW_SEPARATOR}</Text> : null}
                  <Text
                    color={useColors ? segment.color : undefined}
                    dimColor={!useColors || segment.dim}
                  >
                    {segment.text}
                  </Text>
                </Text>
              ))
            : hasCustomPreview ? preview : <Text dimColor>Status line hidden</Text>}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Space to toggle · ←/→ to move · Enter to save · Esc to cancel · type to search
        </Text>
      </Box>
    </Box>
  );
}
