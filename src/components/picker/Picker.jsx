import { Box, Text, useInput, useStdout } from "ink";
import { useMemo, useRef, useState } from "react";

import { useInputCursor } from "../../hooks/use-input-cursor.js";
import { pickerDensity, pickerViewport } from "../picker-viewport.js";
import { stringWidth } from "../../markdown-width.js";
import { filterItems, highlightSegments } from "./picker-filter.js";
import { footerHint as buildFooterHint, pickerAction } from "./picker-keys.js";
import {
  compactRowWidth,
  initialIndex,
  moveIndex,
  normalizeItems,
  splitRowWidth,
  truncateToCellWidth,
} from "./picker-rows.js";

const MAX_VISIBLE = 10;

/** 箭头表示当前项，空白保持未选中行对齐。 */
const MARKER_ACTIVE = "→ ";
const MARKER_IDLE = "  ";

/**
 * 通用单选 picker。
 *
 * 渲染与按键全部统一在此，调用方只提供声明式参数——
 * 新增 picker 不需要写新组件。
 */
export function Picker({
  title,
  subtitle,
  items = [],
  selected = null,
  color = "cyan",
  searchable = true,
  searchPlaceholder = "Type to filter…",
  emptyText = "No matching items",
  footerHint,
  canGoBack = false,
  // 紧凑两列用于像 Ctrl+O 查看器这种「类型 + title」表格：右栏紧贴左栏且列位置
  // 与终端宽度无关，因此 subtitle 会被当成列头按行标记宽度缩进对齐；
  // 其他 picker 仍保持右栏靠右、subtitle 为普通说明文字。
  compactColumns = false,
  // 为 false 时仍保持挂载（保留查询串与选中行），但不再消费按键，
  // 供调用方在下钻时隐藏上一级面板。
  active = true,
  // 整屏框架（Ctrl+O 查看器）把 picker 放进自己的正文区时传入该区的尺寸
  // `{ rows, columns }`：传了就不再画自带的标题与底部提示（两者归框架所有），
  // 行数与列宽也改用这个尺寸——按整个终端算会让末行被框架下边框裁掉、右栏被挤出边界。
  embed = null,
  renderRight,
  onSelect,
  onCancel,
}) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = normalizeItems(items);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => initialIndex(rows, selected));

  const filtered = useMemo(() => (searchable ? filterItems(rows, query) : rows), [rows, query, searchable]);

  // 过滤后下标可能越界：每次渲染都夹紧，不缓存派生状态。
  const clamped = Math.max(0, Math.min(index, filtered.length - 1));

  const setQueryAndReset = (next) => {
    setQuery(next);
    // 查询变化后回到顶部：此时还拿不到新的过滤结果，交由渲染期夹紧与 move 跳过 disabled。
    setIndex(0);
  };

  useInput((input, key) => {
    const action = pickerAction(input, key, { searchable, hasQuery: query.length > 0 });

    switch (action.type) {
      case "cancel":
        onCancel?.();
        return;
      case "clear-query":
        setQueryAndReset("");
        return;
      case "confirm": {
        const row = filtered[clamped];
        if (!row) return;
        // 过滤后下标可能落在 disabled 行上；跳到最近可选行再确认，避免 Enter 静默失效。
        if (row.disabled) {
          const next = moveIndex(filtered, clamped, 1);
          if (next !== clamped && !filtered[next]?.disabled) setIndex(next);
          return;
        }
        onSelect?.(row.source, row);
        return;
      }
      case "move":
        if (filtered.length === 0) return;
        setIndex(moveIndex(filtered, clamped, action.delta));
        return;
      case "append":
        setQueryAndReset(query + action.text);
        return;
      case "backspace":
        if (query.length > 0) setQueryAndReset([...query].slice(0, -1).join(""));
        return;
      default:
    }
  }, { isActive: active });

  const windowRows = embed ? embed.rows : stdout?.rows;
  const embedded = embed != null;
  const density = pickerDensity(windowRows);
  const showTitle = !embedded && density !== "minimal" && Boolean(title);
  const showSubtitle = density === "full" && Boolean(subtitle);
  const showSearch = searchable && density !== "minimal";
  const showHint = !embedded && density === "full";
  const spacious = density === "full";

  // 搜索框的真实光标：中文过滤时输入法要靠它定位预编辑串（见 use-input-cursor.js）。
  // 这一行是 wrap="truncate"，超宽只截断不折行，所以走 truncate 夹位。
  // 嵌入整屏框架时补一行偏移：Ink 在整屏帧里算锚点会差一行（见 rowOffset 的说明）。
  const searchRef = useRef(null);
  useInputCursor(searchRef, active && showSearch ? stringWidth("> " + query) : null, {
    truncate: true,
    rowOffset: embedded ? 1 : 0,
  });

  // 标题、说明、搜索、提示和位置计数占用的行数预算。嵌入框架时标题与提示在框架上，
  // 不在正文区的账里，说明行也直接顶在框架的顶栏下（不留上边距）。
  const reservedRows = embedded
    ? (showSubtitle ? 1 : 0) +
      (showSearch ? (spacious ? 2 : 1) : 0) +
      (spacious ? 1 : 0) +
      1
    : 1 +
      (showTitle ? 1 : 0) +
      (showSubtitle ? 1 : 0) +
      (showSearch ? (spacious ? 2 : 1) : 0) +
      (showHint ? 2 : 0) +
      2;

  const viewport = pickerViewport({
    index: clamped,
    total: filtered.length,
    rows: windowRows,
    reservedRows,
    maxVisible: MAX_VISIBLE,
  });

  const visible = filtered.slice(viewport.start, viewport.end);
  // 列表不包裹卡片边框，直接使用可用宽度（嵌入框架时是框架正文区的宽度）。
  const innerWidth = Math.max(embed ? embed.columns : columns, 1);
  const hint = footerHint ?? buildFooterHint({ searchable, canGoBack });

  const renderLabel = (row, active) => {
    const segments = searchable && query ? highlightSegments(row.label, query) : [{ text: row.label, hit: false }];
    return segments.map((segment, offset) => (
      <Text
        key={`${row.key}-seg-${offset}`}
        color={segment.hit || active ? color : undefined}
        bold={segment.hit}
        underline={segment.hit}
      >
        {segment.text}
      </Text>
    ));
  };

  const renderRow = (row, offset) => {
    const active = viewport.start + offset === viewport.index;
    const marker = innerWidth >= 2 ? (active ? MARKER_ACTIVE : MARKER_IDLE) : active ? "→" : " ";
    const right = renderRight ? String(renderRight(row.source, row) ?? "") : row.right;
    const normalLayout = splitRowWidth(innerWidth, marker.length, right);
    const compactLayout = compactRowWidth(innerWidth, marker.length, row.label);
    const compact = compactColumns && Boolean(right) && compactLayout.showRight;
    const layout = compact ? compactLayout : normalLayout;
    // [group] 与 (current) 是接在 label 之后的行尾标记，必须先占掉左栏预算，
    // 否则窄终端下它们会把右栏挤出边界或自己被 wrap="truncate" 直接截掉。
    const groupText = row.groupName && !layout.showRight ? ` [${row.groupName}]` : "";
    const currentText = row.current ? " (current)" : "";
    const suffixWidth = stringWidth(groupText) + stringWidth(currentText);
    const label = truncateToCellWidth(row.label, Math.max(0, layout.leftWidth - suffixWidth));
    const shownRight = layout.showRight ? truncateToCellWidth(right, layout.rightWidth) : "";
    // 用 cell 宽度而非 .length 计算间距：CJK/emoji 占两格，否则右栏会错位。
    // 紧凑两列固定留 1 格，右栏起始列才不会随 title 长度漂移。
    const gap = !layout.showRight
      ? 0
      : compact
        ? 1
        : Math.max(
            1,
            innerWidth - marker.length - stringWidth(label) - suffixWidth - stringWidth(shownRight)
          );

    return (
      <Text key={row.key} dimColor={row.disabled} wrap="truncate">
        <Text color={active && !row.disabled ? color : undefined}>{marker}</Text>
        {/* 选中态以整行主题色区分，不额外加粗；未选中的说明保持弱化。 */}
        {row.disabled ? label : renderLabel({ ...row, label }, active)}
        {groupText ? <Text dimColor={!active}>{groupText}</Text> : null}
        {currentText ? <Text dimColor={!active}>{currentText}</Text> : null}
        {layout.showRight ? (
          <>
            {" ".repeat(gap)}
            <Text color={active && !row.disabled ? color : undefined} dimColor={!active}>{shownRight}</Text>
          </>
        ) : null}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {showTitle ? (
        <Text bold color={color}>
          {title}
        </Text>
      ) : null}
      {showSubtitle ? (
        <Box marginTop={embedded ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            {compactColumns ? `${" ".repeat(MARKER_ACTIVE.length)}${subtitle}` : subtitle}
          </Text>
        </Box>
      ) : null}

      {showSearch ? (
        <Box marginTop={spacious ? 1 : 0} ref={searchRef}>
          <Text wrap="truncate">
            <Text color={color}>{"> "}</Text>
            {query ? <Text>{query}</Text> : <Text dimColor>{searchPlaceholder}</Text>}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={spacious ? 1 : 0}>
        {visible.map(renderRow)}
        {filtered.length === 0 ? <Text dimColor>{emptyText}</Text> : null}
        {viewport.above > 0 || viewport.below > 0 ? (
          <Text dimColor>{`  (${viewport.index + 1}/${filtered.length})`}</Text>
        ) : null}
      </Box>

      {showHint ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate">
            {hint}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
