import { useRef } from "react";

import { Box, Text, useWindowSize } from "ink";

import { THOUGHT_PREVIEW_LINES, THOUGHT_STAT_SAMPLE_TICKS } from "../config.js";
import { formatTokens } from "../status-line/items.js";
import { toolFromGroup, useStore } from "../store.js";
import {
  sampleThoughtTokens,
  splitThinkingText,
  thinkingElapsed,
  thinkingPreview,
  thoughtStatBucket,
} from "../thinking.js";
import { formatDuration } from "../utils.js";
import { Message } from "./Message.jsx";

/**
 * 用量提示：`↑输入 ↓输出`，与状态栏的 input-tokens / output-tokens 同一套紧凑写法。
 *
 * 取的是提供方最近一次上报的读数（miro 是每次 LLM 调用，ACP 是每个回合结束时），
 * 不是累计值也不按回合清零：ACP 只在回合收尾上报，清了就永远没有数字可看。
 * 缺一侧就只印另一侧；两侧都没有（或都是 0）时返回 null，让这一行保持原样。
 */
function tokenHint(tokens) {
  const input = formatTokens(tokens?.input);
  const output = formatTokens(tokens?.output);
  const parts = [
    input == null ? null : `↑${input}`,
    output == null ? null : `↓${output}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function activeToolItem(tool, now) {
  return {
    label: tool.label,
    kind: tool.raw?.kind ?? tool.kind ?? null,
    status: tool.status,
    elapsed: tool.startedAt != null ? Math.max(0, now - tool.startedAt) : null,
    preview: tool.preview ?? null,
    command: tool.command ?? null,
    subagent: tool.subagent ?? null,
    detail: tool.detail ?? null,
    diff: tool.diff ?? null,
    hint: tool.hint ?? null,
    autoReview: tool.autoReview ?? null,
  };
}

function isBashTool(tool) {
  return tool.raw?.kind === "execute" || tool.kind === "execute" || tool.label?.name === "Bash";
}

/**
 * 当前回合最具体的那一件事只占一个活动槽：活动工具 > 已完成工具 > Thinking。
 *
 * 注意：表示「回合仍在进行」的随机动词行与 Interrupting… 都不在这里，而由常驻的
 * StatusVerb 渲染在本槽下方（即输入框的上一行），这样工具运行期间状态行不会消失，
 * 也不会被工具输出顶开。因此本组件在只有动词可显示时应当返回 null。
 *
 * cancelling 时本槽整体隐藏，让那一行 Interrupting… 单独呈现。
 *
 * awaitingInput（权限审批等阻塞式 overlay 打开）时同样整体隐藏：此时回合虽仍是
 * busy，但真正在等的是用户按键，计时每 1s 的重渲会让对话框持续抖动。这与
 * cancelling 属于同一类「等外部输入、不该有动画」的状态。
 *
 * 本槽内不再有 spinner：整个活动区只保留 StatusVerb 那一处动画，否则两行同列
 * 同字形各转各的，用户看不出它们在讲两件不同的事。
 */
export function ActivitySlot({
  now,
  busy,
  cancelling,
  activeTools,
  pendingToolGroup,
  hasBashActivity = false,
  awaitingInput = false,
}) {
  const thought = useStore((state) => state.thought);
  const thinkingDisplay = useStore((state) => state.thinkingDisplay);
  // 与状态栏的 input-tokens / output-tokens 同源：提供方最近一次上报的用量。
  const tokens = useStore((state) => state.tokens);
  /**
   * 实时估算的采样桶来自全局动画时钟；订阅桶号而不是 animationTick 本身，于是
   * 只有跨桶（见 THOUGHT_STAT_SAMPLE_TICKS）才会因此重渲一次，而不是每帧都重渲。
   * 这个槽只在回合仍在跑时印 Thinking，那时 StatusVerb 的 spinner 正持有全局
   * 时钟，桶一定在推进。
   */
  const statBucket = useStore((state) =>
    thoughtStatBucket(state.animationTick, THOUGHT_STAT_SAMPLE_TICKS)
  );
  const thoughtStatRef = useRef(null);
  const { columns = 80 } = useWindowSize();
  if (hasBashActivity) return null;
  if (cancelling) return null;
  if (awaitingInput) return null;
  if (!busy && activeTools.length === 0 && !pendingToolGroup && !thought) return null;

  const bashTools = activeTools.filter(isBashTool);
  // 子智能体自带多行展开视图（工具行 + 摘要 + 状态行），折进「N tool calls」
  // 计数里就全看不见了。并行场景下这恰恰是最需要看的东西，所以把它们从可折叠
  // 集合里摘出来，与 Bash 同等对待：各占一行，独立计时。
  const subagentTools = activeTools.filter((tool) => !isBashTool(tool) && tool.subagent);
  const foldableTools = activeTools.filter((tool) => !isBashTool(tool) && !tool.subagent);

  // 子智能体与 Bash 都各占一行，渲染方式相同。
  const liveExtras = [...subagentTools, ...bashTools].map((tool) => (
    <Message
      key={tool.toolCallId}
      block={{ role: "tool", head: true, tool: activeToolItem(tool, now) }}
      width={columns}
    />
  ));

  // 已完成摘要和后续非 Bash 工具共享同一个活动组，避免摘要消失、计时归零、
  // 单个 Edit 完成后又突然被折回摘要。
  if ((pendingToolGroup && (!thought || foldableTools.length > 0)) || foldableTools.length > 1) {
    const groupedItems = [
      ...(pendingToolGroup?.items ?? []),
      ...foldableTools.map((tool) => activeToolItem(tool, now)),
    ];
    const startedAt = pendingToolGroup?.startedAt ?? foldableTools.reduce(
      (earliest, tool) => tool.startedAt == null ? earliest : Math.min(earliest, tool.startedAt),
      now
    );
    const liveGroup = {
      ...(pendingToolGroup ?? {}),
      items: groupedItems,
      hint: pendingToolGroup?.hint ?? foldableTools.find((tool) => tool.hint)?.hint ?? null,
      startedAt,
      finishedAt: now,
    };
    return (
      <Box flexDirection="column">
        {groupedItems.length > 0 ? (
          <Message
            block={{ role: "tool", head: true, tool: toolFromGroup(liveGroup, { live: busy, now }) }}
            reviewHint={Boolean(pendingToolGroup)}
            width={columns}
          />
        ) : null}
        {liveExtras}
      </Box>
    );
  }

  // 有子智能体在跑时，即使只有它们也要全部渲染，而不是只留最后一个。
  if (subagentTools.length > 0) {
    const active = foldableTools.at(-1);
    return (
      <Box flexDirection="column">
        {active ? (
          <Message block={{ role: "tool", head: true, tool: activeToolItem(active, now) }} width={columns} />
        ) : null}
        {liveExtras}
      </Box>
    );
  }

  const active = activeTools.at(-1);
  if (active) {
    return <Message block={{ role: "tool", head: true, tool: activeToolItem(active, now) }} width={columns} />;
  }

  // 没有更具体的内容时交给 StatusVerb，这里不再重复渲染一行动词。
  if (!thought) return null;

  const parsed = splitThinkingText(thought.text);
  const hasText = Boolean(parsed.body.trim());
  // 折叠时这段预览并不渲染：正文越长，分段成本越高，别白算一份。
  const previewLines = hasText && thought.expanded
    ? thinkingPreview(thought.text, Math.max(1, columns - 2), THOUGHT_PREVIEW_LINES)
    : null;
  const elapsed = formatDuration(thinkingElapsed(thought, now));
  // 思考进行中，`thought.text` 是唯一实时信号：提供方只在回合收尾上报一次用量，
  // 直接读 state.tokens 会让这一行整段思考期间卡在上一个读数（比如 `↓199`）不动。
  // 按已到达正文估算输出 token，让 `↓` 从 0 随内容增长；尚无内容时回落到最近一次
  // 上报读数，保留「没回报用量就原样」的语义。思考行只印输出（↓），输入在思考期
  // 恒定，没有跟着流动的意义。
  //
  // 估算不跟着思考批次（50ms）重算：正文每批只多几个字符，而这里要把整段正文
  // 重新分段一遍。按采样桶取值后，同一个桶里的渲染结果逐字相同，Ink 比较输出后
  // 直接跳过写入——动态区因此只剩 StatusVerb 的 spinner 在动。
  const thoughtStat = sampleThoughtTokens(thoughtStatRef.current, thought.text, statBucket);
  thoughtStatRef.current = thoughtStat;
  const liveOutput = formatTokens(thoughtStat.tokens);
  const io = liveOutput != null ? `↓${liveOutput}` : tokenHint(tokens);
  // hidden 只隐藏正文与语义标题；用户显式展开后仍可临时查看当前内容。
  const title = thinkingDisplay === "hidden" && !thought.expanded
    ? null
    : thought.title ?? parsed.title;
  // 计时在左、用量在右；两者都可能暂时没有（不足 1 秒、agent 还没回报用量）。
  const statusParts = [elapsed, io].filter(Boolean);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        {/*
          这一行刻意用与定稿 thought 块相同的静态 ∴，不用 spinner：下方常驻的
          StatusVerb 已经在同一列转圈，两处动画字形一致、相位又不同步，看起来
          像界面在两个地方各自忙。「还在跑」由 StatusVerb 表达，这里只说「在想什么」。
        */}
        <Box width={2} flexShrink={0}><Text color="cyan">∴</Text></Box>
        <Text dimColor wrap="truncate-end">
          {title
            ? `Thinking: ${[title, ...statusParts].join(" · ")}`
            : statusParts.length > 0
              ? `Thinking… (${statusParts.join(" · ")})`
              : "Thinking…"}
          {/* esc 提示同样交给 StatusVerb，活动槽不重复一行状态。 */}
          {hasText ? " · ctrl+o to review" : ""}
        </Text>
      </Box>
      {previewLines ? (
        <Box paddingLeft={2} marginTop={1} height={THOUGHT_PREVIEW_LINES} flexShrink={0} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {previewLines.join("\n")}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
