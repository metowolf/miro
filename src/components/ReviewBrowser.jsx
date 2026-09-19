import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";

import { renderMarkdown } from "../markdown.js";
import { splitThinkingText, wrapVisualRows } from "../thinking.js";
import { formatDuration } from "../utils.js";
import { DiffView, diffLineCount } from "./DiffView.jsx";
import { Picker } from "./picker/Picker.jsx";
import { footerHint as pickerFooterHint } from "./picker/picker-keys.js";

// 整屏框架恒占 5 行：顶栏（内容 1 行 + 下边框 1 行）+ 底栏（上边框 1 行 + 内容 1 行 + 下边框 1 行）。
// 顶栏与底栏都被钉成单行文本（见下方 wrap="truncate-end"），所以这个常量不会再漂移。
//
// 底栏为什么连下边框一起画：整屏帧之间的切换（列表 → 详情）时，Ink 从带光标锚点的
// 上一帧回到底部会差一行（它按「光标停在最后一帧之后」推，而整屏帧不写末尾换行，
// 光标就停最后一行上），擦除因此漏掉最下面一行；一条满宽的分隔线每次都会被完整重写，
// 正好把上一帧残留在那行的尾巴盖掉。空行不行：Ink 会剪掉行尾空白。
const FRAME_CHROME_ROWS = 5;
// 正文区的左右内边距：内嵌的 picker 要按扣掉这两格之后的宽度排版。
const FRAME_BODY_PADDING_X = 1;

/** 框架正文区高度。列表、详情与内嵌 picker 共用同一个预算，避免各自算一套。 */
function frameBodyRows(rows) {
  return Math.max(3, rows - FRAME_CHROME_ROWS);
}

/**
 * Ctrl+O 的整屏窗口：顶栏（Review · 当前页标题）+ 固定高度的正文 + 底栏提示。
 * 列表、详情、Agent 子工具三层共用它，因此窗口几何只有一处定义，打开窗口
 * 会把 transcript 顶出屏幕——三层都是整屏的，不会只剩底部一小块。
 */
function ReviewFrame({ label, footer, rows, children }) {
  return (
    <Box flexDirection="column" height={rows}>
      <Box
        borderStyle="single"
        borderColor="cyan"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {/* 标题过长必须以 … 截断而不能折行，否则外层固定 height 会被顶破、
            标题尾巴会叠印到正文首行；截断作用在整行上，Review 前缀因此永远完整保留。 */}
        <Text wrap="truncate-end">
          <Text bold inverse color="cyan">Review</Text>
          {label ? (
            <>
              <Text dimColor> · </Text>
              <Text bold>{label}</Text>
            </>
          ) : null}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        height={frameBodyRows(rows)}
        paddingX={FRAME_BODY_PADDING_X}
        overflow="hidden"
      >
        {children}
      </Box>
      <Box
        borderStyle="single"
        borderColor="gray"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        <Text dimColor wrap="truncate-end">{footer}</Text>
      </Box>
    </Box>
  );
}

const DETAIL_SECTION_COLORS = {
  input: "yellow",
  output: "green",
  locations: "blue",
  request: "magenta",
  tools: "cyan",
};

function detailLines(item, width) {
  const status = item.status ?? "unknown";
  // 不足 1 秒不显示计时（formatDuration 返回 null），只留状态本身。
  const duration = item.elapsed == null ? null : formatDuration(item.elapsed);
  const rows = [{
    kind: "status",
    status,
    text: `Status: ${status}${duration ? ` · ${duration}` : ""}`,
  }];
  const sections = [
    ["input", "Input", item.detail?.input],
    ["output", "Output", item.detail?.output],
    ["locations", "Locations", item.detail?.locations],
  ];
  for (const [section, title, text] of sections) {
    if (!text) continue;
    rows.push({ kind: "blank", text: "" }, { kind: "section", section, text: title });
    for (const line of String(text).split("\n")) {
      const wrapped = wrapVisualRows(line, Math.max(1, width - 2));
      for (const part of wrapped) rows.push({ kind: "content", section, text: part });
    }
  }
  if (sections.every(([, , text]) => !text)) {
    for (const line of item.preview?.lines ?? []) {
      for (const part of wrapVisualRows(line, Math.max(1, width - 2))) {
        rows.push({ kind: "content", section: "output", text: part });
      }
    }
  }
  return rows;
}

function subagentLines(item, width, { includeTools = true } = {}) {
  const subagent = item?.subagent ?? {};
  const request = subagent.request ?? {};
  const duration = item?.elapsed == null ? null : formatDuration(item.elapsed);
  const rows = [{
    kind: "status",
    status: item?.status ?? "unknown",
    text: `Status: ${item?.status ?? "unknown"}${duration ? ` · ${duration}` : ""}`,
  }];
  const addSection = (section, title, value) => {
    if (value == null || String(value).length === 0) return;
    rows.push({ kind: "blank", text: "" }, { kind: "section", section, text: title });
    for (const line of String(value).split("\n")) {
      for (const part of wrapVisualRows(line, Math.max(1, width - 2))) {
        rows.push({ kind: "content", section, text: part });
      }
    }
  };

  const requestFields = [
    ["Description", request.description],
    ["Model", request.model],
    ["Effort", request.effort],
  ].filter(([, value]) => value != null && String(value).length > 0)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  addSection("request", "Request", requestFields);
  addSection("request", "Task", request.message ?? subagent.taskSummary);
  addSection("output", "Output", subagent.text || "No output retained.");

  const tools = includeTools ? (subagent.tools ?? []).filter((tool) => !tool.removed) : [];
  if (tools.length > 0) {
    rows.push({ kind: "blank", text: "" }, { kind: "section", section: "tools", text: `Tool calls (${tools.length})` });
    for (const tool of tools) {
      const label = tool.args ? `${tool.name}(${tool.args})` : tool.name;
      rows.push({ kind: "content", section: "tools", text: `${tool.status ?? ""} ${label}`.trim() });
      if (tool.result) {
        for (const line of String(tool.result).split("\n")) {
          for (const part of wrapVisualRows(`  ${line}`, Math.max(1, width - 2))) {
            rows.push({ kind: "content", section: "output", text: part });
          }
        }
      }
    }
  }
  return rows;
}

function statusColor(status) {
  if (["completed", "done", "success"].includes(status)) return "green";
  if (["failed", "error", "rejected"].includes(status)) return "red";
  return "yellow";
}

function DetailLine({ line }) {
  if (line.kind === "blank") return <Text> </Text>;
  if (line.kind === "status") {
    return <Text bold color={statusColor(line.status)}>{line.text}</Text>;
  }
  const color = DETAIL_SECTION_COLORS[line.section] ?? "cyan";
  if (line.kind === "section") {
    return <Text bold inverse color={color}>{` ${line.text} `}</Text>;
  }
  return (
    <Text wrap="truncate-end">
      <Text bold color={color}>│ </Text>
      <Text>{line.text.length > 0 ? line.text : " "}</Text>
    </Text>
  );
}

function wrapRenderedMarkdown(text, width) {
  const rendered = renderMarkdown(text);
  try {
    return Bun.wrapAnsi(rendered, Math.max(1, width), {
      hard: true,
      wordWrap: true,
      trim: false,
    }).split("\n");
  } catch {
    return rendered.split("\n");
  }
}

function entryLabel(entry) {
  if (entry?.kind === "thought") {
    const thought = entry.thought;
    const title = thought.title ?? splitThinkingText(thought.text).title;
    const duration = thought.durationMs == null ? null : formatDuration(thought.durationMs);
    return [title ? `Thought: ${title}` : "Thought", duration].filter(Boolean).join(" · ");
  }
  if (entry?.kind === "bash") {
    const command = entry.card?.command ?? "";
    return command ? `Shell: ${command}` : "Shell";
  }
  if (entry?.kind === "subagent") {
    const item = entry.item;
    const label = item?.label?.args
      ? `${item.label.name}(${item.label.args})`
      : item?.label?.name ?? "Sub-agent";
    return `Sub-agent: ${label}`;
  }
  const item = entry?.item;
  const label = item?.label?.args
    ? `${item.label.name}(${item.label.args})`
    : item?.label?.name ?? "Tool";
  return `Tool: ${label}`;
}

function entryType(entry) {
  if (entry?.kind === "subagent") return "Agent";
  if (entry?.kind === "thought") return "Thought";
  if (entry?.kind === "bash") return "Shell";
  return "Tool";
}

function entryTitle(entry) {
  if (entry?.kind === "thought") {
    return entry.thought?.title ?? splitThinkingText(entry.thought?.text).title ?? "Thinking";
  }
  if (entry?.kind === "bash") return entry.card?.command ?? "Shell";
  const item = entry?.item;
  return item?.label?.args ? `${item.label.name}(${item.label.args})` : item?.label?.name ?? "Tool";
}

// 列表的左栏宽度：序号（按总数变宽）+ 2 空格 + 类型。类型最长是 Thought（7 列）。
const TYPE_COLUMN_WIDTH = 7;

function listLeftColumn(index, total, type) {
  return `${String(index + 1).padStart(String(total).length, " ")}  ${type.padEnd(TYPE_COLUMN_WIDTH)}`;
}

function listItem(entry, index, total) {
  return {
    value: index,
    // 左栏固定为序号和类型，右栏只放 title；不要把工具输出或 thinking 正文挤进列表。
    label: listLeftColumn(index, total, entryType(entry)),
    right: entryTitle(entry),
  };
}

/**
 * 列表列头。与 listItem 共用 TYPE_COLUMN_WIDTH，且 Title 前只留 1 格
 * （Picker 的 compactColumns 固定用 1 格间距），两边因此落在同一列；
 * Picker 会按行标记宽度把列头整体缩进，与行首的标记列对齐。
 */
function listHeader(total) {
  return `${"#".padStart(String(total).length, " ")}  ${"Type".padEnd(TYPE_COLUMN_WIDTH)} Title`;
}

function subagentToolEntries(entry) {
  return (entry?.item?.subagent?.tools ?? [])
    .filter((tool) => !tool.removed)
    .map((tool, index) => ({
      id: `${entry.id ?? "subagent"}:child:${index}`,
      kind: "tool",
      item: {
        label: { name: tool.name ?? "Tool", args: tool.args ?? "" },
        status: tool.status,
        detail: tool.result == null ? undefined : { output: tool.result },
      },
    }));
}

function ReviewList({ label, entries, selected, onSelect, onBack, canGoBack = false }) {
  const { rows = 24, columns = 80 } = useWindowSize();
  return (
    <ReviewFrame label={label} rows={rows} footer={pickerFooterHint({ canGoBack })}>
      <Picker
        embed={{
          rows: frameBodyRows(rows),
          columns: Math.max(1, columns - FRAME_BODY_PADDING_X * 2),
        }}
        subtitle={listHeader(entries.length)}
        items={entries.map((entry, index) => listItem(entry, index, entries.length))}
        selected={selected}
        color="cyan"
        compactColumns
        canGoBack={canGoBack}
        onSelect={(row) => onSelect(row.value)}
        onCancel={onBack}
        emptyText="No retained items"
      />
    </ReviewFrame>
  );
}

function ReviewDetail({ entry, position, onBack, onOpenTools, onStep }) {
  const { rows = 24, columns = 80 } = useWindowSize();
  const [offset, setOffset] = useState(0);
  const bodyRows = frameBodyRows(rows);
  const contentWidth = Math.max(1, columns - 2);
  const { index = 0, total = 1 } = position ?? {};
  // 左右切到下一条时回到顶部：新条目沿用上一条的滚动位置只会显得卡在中间。
  useEffect(() => {
    setOffset(0);
  }, [entry?.id]);
  const thoughtLines = useMemo(() => {
    if (entry?.kind !== "thought") return [];
    const body = splitThinkingText(entry.thought?.text).body;
    return body ? wrapRenderedMarkdown(body, contentWidth) : ["No retained details."];
  }, [entry, contentWidth]);
  const toolLines = useMemo(() => {
    if (entry?.kind !== "tool" || entry.item?.diff) return [];
    return detailLines(entry.item, contentWidth);
  }, [entry, contentWidth]);
  const subagentDetailLines = useMemo(() => {
    if (entry?.kind !== "subagent") return [];
    return subagentLines(entry.item, contentWidth, { includeTools: false });
  }, [entry, contentWidth]);
  // shell 输出已经是逐行的终端文本，不再走 markdown；只在超宽时折行，与工具详情
  // 共用同一套行账本（没有 "│ " 前缀，所以不吃那 2 列的宽度预算）。
  const bashLines = useMemo(() => {
    if (entry?.kind !== "bash") return [];
    const card = entry.card ?? {};
    const out = [];
    for (const line of card.lines ?? []) {
      out.push({
        err: Boolean(line.err),
        text: wrapVisualRows(line.text, contentWidth).join("\n"),
      });
    }
    // 已定稿进 transcript 的卡片只保留了预览，窗口里看到的同样不是全部，得说明。
    if (card.hidden > 0) out.push({ text: `… ${card.hidden} more lines not retained` });
    return out;
  }, [entry, contentWidth]);
  const isDiff = entry?.kind === "tool" && !!entry.item?.diff;
  const diffRows = isDiff ? diffLineCount(entry.item.diff, contentWidth) : 0;
  const lineCount = isDiff
    ? diffRows
    : entry?.kind === "thought"
      ? thoughtLines.length
      : entry?.kind === "bash"
        ? bashLines.length
        : entry?.kind === "subagent"
          ? subagentDetailLines.length
          : toolLines.length;
  // DiffView 在 maxLines 之外还会渲染 header 行、「… N earlier lines」与「… +N lines」
  // 三种提示行，它们都不计入 maxLines。保守起见按最大额外行数（3）扣减每屏可见内容行：
  // 宁可极端情况下少显示 1-2 行，也不让总输出顶破正文区高度、触发 Yoga 压缩与叠印。
  const DIFF_CHROME_ROWS = 3;
  const pageRows = isDiff ? Math.max(1, bodyRows - DIFF_CHROME_ROWS) : bodyRows;
  const maxOffset = Math.max(0, lineCount - pageRows);

  const hasSubagentTools = entry?.kind === "subagent" && subagentToolEntries(entry).length > 0;
  // 左右切到下一条后，上一条的 offset 可能落在新条目的可滚范围之外；渲染期夹紧。
  const safeOffset = Math.min(offset, maxOffset);

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.return && hasSubagentTools) return onOpenTools();
    // 左右切上下一条目：列表本身用 ↑↓ 选择，详情里的左右键不能又去翻长文本。
    if (key.leftArrow) return onStep?.(-1);
    if (key.rightArrow) return onStep?.(1);
    if (key.home) return setOffset(0);
    if (key.end) return setOffset(maxOffset);
    if (key.upArrow) return setOffset((value) => Math.max(0, value - 1));
    if (key.downArrow) return setOffset((value) => Math.min(maxOffset, value + 1));
    if (key.pageUp) return setOffset((value) => Math.max(0, value - pageRows));
    if (key.pageDown) return setOffset((value) => Math.min(maxOffset, value + pageRows));
  });

  // 多条目时标题带位置、底栏广告左右键；只有一条时这两个提示都不出现。
  const footer = [
    "↑↓/Pg/Home/End scroll",
    total > 1 ? "←→ switch item" : null,
    hasSubagentTools ? "Enter to view tool calls" : null,
    "Esc to go back",
    maxOffset > 0
      ? `${safeOffset + 1}-${Math.min(lineCount, safeOffset + pageRows)}/${lineCount}`
      : null,
  ].filter(Boolean).join(" · ");

  return (
    <ReviewFrame
      label={total > 1 ? `${index + 1}/${total} · ${entryLabel(entry)}` : entryLabel(entry)}
      rows={rows}
      footer={footer}
    >
      {isDiff ? (
        <DiffView
          diff={entry.item.diff}
          mode="full"
          offset={safeOffset}
          maxLines={pageRows}
          width={contentWidth}
        />
      ) : entry?.kind === "tool" ? (
        toolLines.slice(safeOffset, safeOffset + pageRows).map((line, lineIndex) => (
          <DetailLine key={`${entry?.id ?? "entry"}-${safeOffset}-${lineIndex}`} line={line} />
        ))
      ) : entry?.kind === "bash" ? (
        bashLines.slice(safeOffset, safeOffset + pageRows).map((line, lineIndex) => (
          <Text
            key={`${entry?.id ?? "entry"}-${safeOffset}-${lineIndex}`}
            dimColor
            color={line.err ? "yellow" : undefined}
            wrap="truncate-end"
          >
            {line.text.length > 0 ? line.text : " "}
          </Text>
        ))
      ) : entry?.kind === "subagent" ? (
        subagentDetailLines.slice(safeOffset, safeOffset + pageRows).map((line, lineIndex) => (
          <DetailLine key={`${entry?.id ?? "entry"}-${safeOffset}-${lineIndex}`} line={line} />
        ))
      ) : thoughtLines.slice(safeOffset, safeOffset + pageRows).map((line, lineIndex) => (
        <Text key={`${entry?.id ?? "entry"}-${safeOffset}-${lineIndex}`} wrap="truncate-end">
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </ReviewFrame>
  );
}

/**
 * 某个列表里的详情页要翻的那一列：根列表与 Agent 子工具列表各自翻自己那一列，
 * 左右键因此始终在「打开当前详情的那个列表」里移动。
 */
function detailList(entries, page) {
  if (page.kind !== "tool-detail") return entries;
  return subagentToolEntries(entries[page.selected] ?? null);
}

/** Ctrl+O 的分层查看器：列表 → 详情 → Agent 子工具列表 → 工具详情。 */
export function ReviewBrowser({ entries = [], initialIndex = 0, onClose }) {
  const initial = Math.max(0, Math.min(entries.length - 1, initialIndex));
  const [page, setPage] = useState({ kind: "root", selected: initial });

  if (page.kind === "root") {
    return <ReviewList
      label={`${entries.length} item${entries.length === 1 ? "" : "s"}`}
      entries={entries}
      selected={page.selected}
      onSelect={(selected) => setPage({ kind: "detail", selected })}
      onBack={onClose}
    />;
  }

  if (page.kind === "agent-tools") {
    const tools = subagentToolEntries(entries[page.selected] ?? null);
    return <ReviewList
      label="Agent tool calls"
      entries={tools}
      selected={page.toolSelected}
      onSelect={(toolSelected) => setPage({ kind: "tool-detail", selected: page.selected, toolSelected })}
      onBack={() => setPage({ kind: "detail", selected: page.selected })}
      canGoBack
    />;
  }

  const list = detailList(entries, page);
  const selected = page.kind === "detail" ? page.selected : page.toolSelected;
  // 到头就停住（不环绕）：翻过头会让人以为看的是同一条。
  const step = (delta) => {
    const next = Math.max(0, Math.min(list.length - 1, selected + delta));
    if (next === selected) return;
    setPage(page.kind === "detail"
      ? { kind: "detail", selected: next }
      : { kind: "tool-detail", selected: page.selected, toolSelected: next });
  };

  return <ReviewDetail
    entry={list[selected] ?? null}
    position={{ index: selected, total: list.length }}
    onBack={() => setPage(page.kind === "detail"
      ? { kind: "root", selected: page.selected }
      : { kind: "agent-tools", selected: page.selected, toolSelected: page.toolSelected })}
    onOpenTools={() => setPage({ kind: "agent-tools", selected: page.selected, toolSelected: 0 })}
    onStep={step}
  />;
}
