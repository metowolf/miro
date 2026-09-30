import { Box, Text, useInput, useWindowSize } from "ink";
import { useState } from "react";

import { permissionReview, permissionTitle } from "../permission-review.js";
import { DiffView, diffLineCount } from "./DiffView.jsx";

const MAX_BODY_LINES = 5;
const MAX_VISIBLE_OPTIONS = 3;

function windowStart(index, total, size) {
  if (total <= size) return 0;
  return Math.max(0, Math.min(index - Math.floor(size / 2), total - size));
}

/** 计划审批的配色与提问与写操作不同：它不是一个危险动作，而是一个决策点。 */
function isPlanReview(toolCall) {
  return toolCall?.kind === "plan";
}

export function PermissionDialog({ toolCall, items, escapeValue, onResolve }) {
  const { rows = 24, columns = 80 } = useWindowSize();
  const [index, setIndex] = useState(0);
  const [scroll, setScroll] = useState(0);
  const { diff, text } = permissionReview(toolCall);
  const rawReview = text.replace(/\r\n?/g, "\n");
  const allLines = rawReview ? rawReview.split("\n") : [];
  const planReview = isPlanReview(toolCall);
  // 计划通常比一个 diff 长得多，默认就要展开；折叠成 5 行等于让用户盲批。
  const expanded =
    planReview ||
    Boolean(diff) ||
    toolCall?.kind === "edit" ||
    toolCall?.kind === "delete" ||
    allLines.length > MAX_BODY_LINES;
  const bodyBudget = expanded ? Math.max(MAX_BODY_LINES, rows - 12) : MAX_BODY_LINES;
  const diffWidth = Math.max(1, columns - 6);
  const diffPageRows = Math.max(1, bodyBudget - 2);
  const diffRows = diff ? diffLineCount(diff, diffWidth) : 0;
  const pageSize = diff ? diffPageRows : bodyBudget;
  const maxScroll = Math.max(0, (diff ? diffRows : allLines.length) - pageSize);
  const command = allLines.slice(scroll, scroll + bodyBudget);

  useInput((input, key) => {
    if (key.escape) {
      onResolve(escapeValue ?? null);
      return;
    }
    if (key.pageUp) {
      setScroll((value) => Math.max(0, value - pageSize));
      return;
    }
    if (key.pageDown) {
      setScroll((value) => Math.min(maxScroll, value + pageSize));
      return;
    }
    if (items.length === 0) return;
    if (key.upArrow || input === "k") {
      setIndex((value) => (value - 1 + items.length) % items.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((value) => (value + 1) % items.length);
      return;
    }
    const digit = Number.parseInt(input, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= items.length) {
      onResolve(items[digit - 1].value);
      return;
    }
    if (key.return) onResolve(items[index].value);
  });

  const title = permissionTitle(toolCall);
  const accent = toolCall?.kind === "delete" ? "red" : planReview ? "cyan" : "yellow";
  const visibleSize = Math.min(items.length, MAX_VISIBLE_OPTIONS);
  const visibleStart = windowStart(index, items.length, visibleSize);
  const visibleItems = items.slice(visibleStart, visibleStart + visibleSize);

  return (
    <Box
      flexDirection="column"
      borderStyle={expanded ? "single" : "round"}
      borderLeft={!expanded}
      borderRight={!expanded}
      borderColor={accent}
      paddingX={1}
    >
      <Text bold color={accent}>
        {planReview ? "Ready to code?" : expanded ? `Review ${title}` : title}
      </Text>

      {diff ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <DiffView
            diff={diff}
            mode="full"
            offset={scroll}
            maxLines={diffPageRows}
            width={diffWidth}
            showHeader={false}
          />
        </Box>
      ) : command.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {command.map((line, offset) => (
            <Text key={`${scroll}-${offset}`} color={toolCall?.kind === "delete" ? "red" : undefined}>
              {line || " "}
            </Text>
          ))}
          {maxScroll > 0 ? (
            <Text dimColor>… lines {scroll + 1}-{Math.min(allLines.length, scroll + bodyBudget)} of {allLines.length}</Text>
          ) : null}
        </Box>
      ) : null}
      {toolCall?.title && toolCall.title !== title ? (
        <Box paddingLeft={2}>
          <Text dimColor>{toolCall.title}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text>{planReview ? "Would you like to proceed with this plan?" : "Do you want to proceed?"}</Text>
      </Box>
      {visibleItems.map((item, offset) => {
        const itemIndex = visibleStart + offset;
        const active = itemIndex === index;
        return (
          <Text key={item.value ?? offset} color={active ? accent : undefined} bold={active}>
            {active ? "❯ " : "  "}
            {itemIndex + 1}. {item.label}
          </Text>
        );
      })}
      {items.length === 0 ? <Text dimColor>(No options available · Esc to cancel)</Text> : null}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ to select · Enter to confirm · Esc to cancel
          {expanded && maxScroll > 0 ? " · PgUp/PgDn review" : ""}
          {items.length > visibleSize ? ` · ${index + 1}/${items.length}` : ""}
        </Text>
      </Box>
    </Box>
  );
}