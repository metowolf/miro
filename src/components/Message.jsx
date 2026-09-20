import { Box, Text, useStdout } from "ink";
import { memo } from "react";

import { formatTokens, subagentDisplay } from "../acp/subagent.js";
import { TERMINAL_STATUSES } from "../acp/tool-title.js";
import { autoReviewNote } from "../auto-review-note.js";
import {
  BLACK_CIRCLE,
  TREE_BLANK_PREFIX,
  TREE_LAST,
  TREE_LAST_PREFIX,
  TREE_MID_PREFIX,
  TREE_VERTICAL_PREFIX,
} from "../figures.js";
import { COMMAND_PREVIEW_ROWS } from "../config.js";
import { renderMarkdown } from "../markdown.js";
import { stringWidth } from "../markdown-width.js";
import { splitThinkingText, wrapVisualRows } from "../thinking.js";
import { formatDuration } from "../utils.js";
import { Banner } from "./Banner.jsx";
import { BashCard } from "./BashCard.jsx";
import { DiffView } from "./DiffView.jsx";
import { PlanMessage } from "./PlanMessage.jsx";
import { ProposedPlanMessage } from "./ProposedPlanMessage.jsx";

const ROLE_STYLES = {
  user: { marker: ">", markerColor: "gray", dim: true },
  assistant: { marker: BLACK_CIRCLE, markerColor: "green" },
  system: { marker: "✻", markerColor: "cyan", dim: true },
  thought: { marker: "∴", markerColor: "cyan", dim: true },
  tool: { marker: BLACK_CIRCLE, markerColor: "yellow", dim: true },
  toolUpdate: { marker: TREE_LAST, markerColor: "gray", dim: true },
  bashInput: { marker: "!", markerColor: "magenta" },
  bashOutput: { marker: TREE_LAST, markerColor: "gray", dim: true },
  stderr: { marker: "⚠", markerColor: "yellow", dim: true },
  error: { marker: "✗", markerColor: "red" },
};

/** 进行中 dim、成功绿、失败/取消红。 */
function toolDotProps(status) {
  if (status === "completed") return { color: "green" };
  if (status === "failed" || status === "cancelled") return { color: "red" };
  return { dimColor: true };
}

function SubRow({ first, children }) {
  return (
    <Box flexDirection="row">
      <Box width={5} flexShrink={0}>
        <Text dimColor>{first ? TREE_LAST_PREFIX : TREE_BLANK_PREFIX}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor wrap="truncate-end">
          {children}
        </Text>
      </Box>
    </Box>
  );
}

function SubagentMessage({ block }) {
  const { label, status, elapsed, subagent } = block.tool;
  const display = subagentDisplay(subagent);
  const running = status !== "completed" && status !== "failed" && status !== "cancelled";

  const statsParts = [];
  if (display.toolCount > 0) {
    statsParts.push(`${display.toolCount} tool ${display.toolCount === 1 ? "use" : "uses"}`);
  }
  const tokens = formatTokens(display.tokens);
  if (tokens) statsParts.push(`${tokens} tokens`);
  // 不足 1 秒的时长不占位置：formatDuration 返回 null，stats 里不留空片段。
  const duration = elapsed == null ? null : formatDuration(elapsed);
  if (duration) statsParts.push(duration);
  const stats = statsParts.join(" · ");

  let rowIndex = 0;
  const nextFirst = () => rowIndex++ === 0;

  return (
    <Box flexDirection="column" marginTop={block.head ? 1 : 0}>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text {...toolDotProps(status)}>{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            <Text bold color="magenta">
              {label.name}
            </Text>
            {label.args ? `(${label.args})` : ""}
          </Text>
        </Box>
      </Box>
      {display.rows.map((row, index) => (
        <SubRow key={index} first={nextFirst()}>
          {row}
        </SubRow>
      ))}
      {display.moreTools > 0 ? (
        <SubRow first={nextFirst()}>+{display.moreTools} more tool uses</SubRow>
      ) : null}
      {!running && display.textLine ? (
        <SubRow first={nextFirst()}>{display.textLine}</SubRow>
      ) : null}
      {running ? (
        <SubRow first={nextFirst()}>Running…{stats ? ` (${stats})` : ""}</SubRow>
      ) : (
        <SubRow first={nextFirst()}>
          {status === "completed" ? "Done" : status === "cancelled" ? "Cancelled" : "Failed"}
          {stats ? ` (${stats})` : ""}
        </SubRow>
      )}
    </Box>
  );
}

/**
 * 命令按 cell 宽度折行，并吃掉「因为放不下才另起」那些续行左侧的空格：断点落在
 * 词间时，`│   git diff` 会比正文多缩两格，看起来像对错了列。
 *
 * 逐个逻辑行折而不是把整段丢给 wrapVisualRows，就是为了只吃这一种空格：heredoc
 * 里的脚本靠自己的缩进表达层级，连那部分一起 trim 掉就读不出结构了。
 */
function wrapCommandRows(command, { firstWidth, width }) {
  const rows = [];
  for (const logicalLine of String(command).split("\n")) {
    const wrapped = wrapVisualRows(logicalLine, width, {
      firstWidth: rows.length === 0 ? firstWidth : width,
    });
    rows.push(wrapped[0] ?? "");
    for (const row of wrapped.slice(1)) rows.push(row.replace(/^ +/, ""));
  }
  return rows;
}

function ToolMessage({ block, reviewHint, width }) {
  const { stdout } = useStdout();
  const columns = width ?? stdout?.columns ?? 80;
  const { label, group, status, elapsed, hint, preview, command, diff, autoReview } = block.tool;
  const name = group ? group.name : label.name;
  const elapsedText = elapsed != null ? formatDuration(elapsed) : null;
  // 命令按实际终端宽度折行后才知道能不能塞进标题：塞得下就保持紧凑的
  // Bash(cmd) 单行，塞不下才把首行接在标题后、其余折到下面——标题里那个
  // 截成 `…` 的版本，恰好把命令最要紧的尾部（跑哪些文件、重定向到哪）全丢了。
  //
  // 计时的宽度在**每一行**都预留：真正需要它的只有承载计时的末行，但按行给不同
  // 限额会让「折出几行」反过来决定限额，绕不出去。统一预留只让折行点早几列，
  // 换来的是计时永远不会把命令挤掉一截。
  const elapsedReserve = elapsedText ? stringWidth(` (${elapsedText})`) : 0;
  const hintReserve = reviewHint ? stringWidth(` · ctrl+o to review`) : 0;
  const commandRows =
    command && !group
      ? wrapCommandRows(command, {
          width: Math.max(1, columns - 5 - elapsedReserve),
          firstWidth: Math.max(1, columns - 2 - stringWidth(name) - 1 - elapsedReserve - hintReserve),
        })
      : [];
  const showCommand = commandRows.length > 1;
  // 首行归标题，剩下的行留给下面的续行区，合起来仍是最多 COMMAND_PREVIEW_ROWS 行。
  const bodyCommandRows = showCommand ? commandRows.slice(1, COMMAND_PREVIEW_ROWS) : [];
  const hiddenCommandRows = showCommand
    ? Math.max(0, commandRows.length - COMMAND_PREVIEW_ROWS)
    : 0;
  const args = group || showCommand ? null : label.args;
  // 流式参数（new_string 前缀）算出的 diff 是半成品，渲染会逐 chunk 抖动；
  // 只有 ACP 权威 diff（complete）或工具终态定稿后才展示。
  const showDiff =
    diff != null && (diff.complete === true || TERMINAL_STATUSES.has(status));
  const allChildItems = group?.items ?? [];
  // 长组同时保留最早上下文和最新调用；刚完成的 Edit 不会立刻从摘要里消失。
  const childItems = allChildItems.length > 4
    ? [...allChildItems.slice(0, 3), allChildItems.at(-1)]
    : allChildItems;
  const hiddenItems = Math.max(0, (group?.items?.length ?? 0) - childItems.length);
  return (
    <Box flexDirection="column" marginTop={block.head ? 1 : 0}>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text {...toolDotProps(status)}>{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            <Text bold>{name}</Text>
            {args ? `(${args})` : ""}
            {/* 展开成块时标题后面接命令首行，计时随命令末行走，不再钉在这里。 */}
            {showCommand ? ` ${commandRows[0]}` : ""}
            {group?.summary ? <Text dimColor> · {group.summary}</Text> : null}
            {showDiff ? <Text dimColor> · +{diff.additions ?? 0} -{diff.deletions ?? 0}</Text> : null}
            {!showCommand && elapsedText ? <Text dimColor> ({elapsedText})</Text> : null}
            {reviewHint ? <Text dimColor> · ctrl+o to review</Text> : null}
          </Text>
        </Box>
      </Box>
      {childItems.map((item, index) => (
        <Box key={index} flexDirection="row">
          <Box width={5} flexShrink={0}><Text dimColor>{index === childItems.length - 1 && hiddenItems === 0 ? TREE_LAST_PREFIX : TREE_MID_PREFIX}</Text></Box>
          <Text dimColor wrap="truncate-end">
            {item.label?.name ?? "Tool"}{item.label?.args ? `(${item.label.args})` : ""}
          </Text>
        </Box>
      ))}
      {hiddenItems > 0 ? (
        <Box flexDirection="row"><Box width={5} flexShrink={0}><Text dimColor>{TREE_LAST_PREFIX}</Text></Box><Text dimColor>+{hiddenItems} more calls</Text></Box>
      ) : null}
      {showCommand ? (
        <Box flexDirection="column">
          {bodyCommandRows.map((row, index) => (
            <Box key={index} flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text dimColor>{TREE_VERTICAL_PREFIX}</Text>
              </Box>
              <Box flexGrow={1}>
                {/* 命令用默认前景色，与审批框里的命令一致；上色会凭空多出一套语义。 */}
                <Text wrap="truncate-end">
                  {row.length > 0 ? row : " "}
                  {index === bodyCommandRows.length - 1 && hiddenCommandRows === 0 && elapsedText ? (
                    <Text dimColor> ({elapsedText})</Text>
                  ) : null}
                </Text>
              </Box>
            </Box>
          ))}
          {hiddenCommandRows > 0 ? (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text dimColor>{TREE_VERTICAL_PREFIX}</Text>
              </Box>
              <Text dimColor>
                … +{hiddenCommandRows} lines{elapsedText ? ` (${elapsedText})` : ""}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {hint ? (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text dimColor>{TREE_LAST_PREFIX}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate-end">
              {hint}
            </Text>
          </Box>
        </Box>
      ) : null}
      {autoReview ? (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text dimColor>{TREE_LAST_PREFIX}</Text>
          </Box>
          <Box flexGrow={1}>
            {/* 被阻断的理由要整句读得到，只有它换行；其余状态保持单行截断。 */}
            <Text
              dimColor={autoReview.status !== "blocked"}
              color={autoReview.status === "blocked" ? "red" : autoReview.status === "checking" ? "yellow" : undefined}
              wrap={autoReview.status === "blocked" ? "wrap" : "truncate-end"}
            >
              {autoReviewNote(autoReview)}
            </Text>
          </Box>
        </Box>
      ) : null}
      {showDiff ? (
        <Box paddingLeft={5}>
          <DiffView
            diff={diff}
            mode="preview"
            maxLines={8}
            width={Math.max(1, columns - 5)}
            showHeader={false}
          />
        </Box>
      ) : null}
      {diff && !showDiff ? (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text dimColor>{TREE_LAST_PREFIX}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate-end">
              Editing{diff.path ? ` ${diff.path}` : ""}…
            </Text>
          </Box>
        </Box>
      ) : null}
      {!diff && preview?.lines?.length > 0 ? (
        <Box flexDirection="column">
          {preview.lines.map((line, index) => (
            <Box key={index} flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text dimColor>{index === 0 && !hint ? TREE_LAST_PREFIX : TREE_BLANK_PREFIX}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor wrap="truncate-end">
                  {line.length > 0 ? line : " "}
                </Text>
              </Box>
            </Box>
          ))}
          {preview.more > 0 ? (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text dimColor>{TREE_BLANK_PREFIX}</Text>
              </Box>
              <Text dimColor>… +{preview.more} lines</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * 一段消息：左侧固定两列放角标，右侧交给 Yoga 折行。
 * `reviewHint` 只由活动区传入：<Static> 里的历史行写出后不再重绘，
 * 印上去的 "ctrl+o to review" 会在下一个块出现后失效。
 *
 * memo 是刻意的：<Static> 里的历史块会随 App 的每次重渲被 React 重新执行，
 * 而 assistant 块每次都要重跑一遍 markdown 解析。store 从不原地
 * 改写块对象（appendBlock 之后只读），所以按引用比较足以跳过全部历史块；
 * 活动区那些每帧新建的 block 对象引用不同，照常重渲。
 */
export const Message = memo(function Message({ block, reviewHint = false, width }) {
  if (block.role === "banner") return <Banner />;
  if (block.role === "bashCard" && block.card) return <BashCard card={block.card} />;
  if (block.role === "tool" && block.tool?.subagent) return <SubagentMessage block={block} />;
  if (block.role === "tool" && block.tool) {
    return <ToolMessage block={block} reviewHint={reviewHint} width={width} />;
  }
  if (block.role === "plan" && block.plan) return <PlanMessage block={block} />;
  if (block.role === "proposedPlan") return <ProposedPlanMessage block={block} />;

  if (block.role === "thought" && block.thought) {
    if (block.thought.displayMode === "hidden") return null;
    const body = splitThinkingText(block.thought.text).body;
    const showBody = block.thought.displayMode === "full" && body.length > 0;
    const detailsMissing = block.thought.hasContent && !block.thought.text;
    return (
      <Box flexDirection="column" marginTop={block.head || block.gap ? 1 : 0}>
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}><Text color="cyan">∴</Text></Box>
          <Box flexGrow={1}>
            <Text dimColor wrap="truncate-end">
              {block.text}{detailsMissing ? " · details not retained" : ""}
            </Text>
          </Box>
        </Box>
        {showBody ? (
          <Box paddingLeft={2} marginTop={1}>
            <Text dimColor>{renderMarkdown(body)}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (block.role === "user") {
    return (
      <Box
        marginTop={block.head || block.gap ? 1 : 0}
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
      >
        <Text bold>{block.text.length > 0 ? block.text : " "}</Text>
      </Box>
    );
  }

  const style = ROLE_STYLES[block.role] ?? ROLE_STYLES.system;
  // assistant 正文经 marked 渲染为 ANSI 字符串；其余角色保持纯文本。
  const text = block.role === "assistant" && block.text.length > 0 ? renderMarkdown(block.text) : block.text;

  return (
    <Box flexDirection="row" marginTop={block.head || block.gap ? 1 : 0}>
      <Box width={2} flexShrink={0}>
        <Text color={style.markerColor}>{block.head ? style.marker : " "}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor={style.dim}>{text.length > 0 ? text : " "}</Text>
      </Box>
    </Box>
  );
});
