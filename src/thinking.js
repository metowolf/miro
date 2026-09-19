import { stringWidth } from "./markdown-width.js";

const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export const THINKING_DISPLAY_MODES = ["compact", "full", "hidden"];
export const DEFAULT_THINKING_DISPLAY_MODE = "compact";

export const THINKING_DISPLAY_CHOICES = [
  {
    value: "compact",
    name: "Compact",
    description: "Show a semantic one-line summary; open details with Ctrl+O",
  },
  {
    value: "full",
    name: "Full",
    description: "Show the thinking body when each block is finalized",
  },
  {
    value: "hidden",
    name: "Hidden",
    description: "Keep thinking out of the visible transcript",
  },
];

/** settings 手改坏时回落到 compact；旧 show/hide 值兼容迁移。 */
export function normalizeThinkingDisplayMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (THINKING_DISPLAY_MODES.includes(normalized)) return normalized;
  if (normalized === "show") return "full";
  if (normalized === "hide") return "compact";
  return DEFAULT_THINKING_DISPLAY_MODE;
}

export function matchThinkingDisplayMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return THINKING_DISPLAY_CHOICES.find(
    (choice) => choice.value === normalized || choice.name.toLowerCase() === normalized
  ) ?? null;
}

/** OpenAI 类摘要把首个粗体段落作为语义标题。 */
export function splitThinkingText(text) {
  const content = String(text ?? "").trim();
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/);
  if (!match) return { title: null, body: content };
  return {
    title: match[1].trim() || null,
    body: content.slice(match[0].length).trimEnd(),
  };
}

/**
 * 相邻两片思考内容之间仍算「在想」的最大间隔。
 *
 * 超过它就不是思考间隙，而是请求等待：模型想完之后要写工具参数、等工具结果，
 * 甚至整轮重发（只产出 reasoning 就收流时），那段时间 UI 上那一行还挂着
 * Thinking…，但把它计进思考耗时会让一次两秒的思考显示成 20s。
 */
export const THINKING_ACTIVE_GAP_MS = 1_000;

/** 一片思考内容到达时累计的流动时间：间隔超过上限的部分当作等待丢掉。 */
export function advanceThinking(thought, now) {
  const previousAt = thought?.activeAt ?? thought?.startedAt;
  if (previousAt == null) return { activeAt: now, activeMs: thought?.activeMs ?? 0 };
  const gap = Math.min(Math.max(0, now - previousAt), THINKING_ACTIVE_GAP_MS);
  return { activeAt: now, activeMs: (thought.activeMs ?? 0) + gap };
}

/**
 * thinking 只计算思考内容真正在流动的时间；暂停中的尾段同样被排除。
 *
 * 没有片段流过（伪工具「规划中」撑起来的 thought）时没有 activeAt 可依据，
 * 那种情况下它的存活期本身就是「在想」，仍按整段墙钟时间计算。
 */
export function thinkingElapsed(thought, now = Date.now()) {
  if (thought?.startedAt == null) return 0;
  const activeMs = thought.activeMs ?? 0;
  const tail = thought.activeAt == null
    ? Math.max(0, now - thought.startedAt)
    : Math.min(Math.max(0, now - thought.activeAt), THINKING_ACTIVE_GAP_MS);
  const pauseTail = thought.pausedAt == null ? 0 : Math.max(0, now - thought.pausedAt);
  return Math.max(0, activeMs + tail - (thought.pausedMs ?? 0) - pauseTail);
}

/**
 * 纯文本按终端 cell 宽度硬折行，CJK/emoji 不按 JS 字符长度误算。
 *
 * `firstWidth` 只作用于整段文本的**第一个物理行**：调用方可能让首行与别的内容
 * 共享一行（工具标题后面接命令首行），那一行能用的列数比其余行少。
 */
export function wrapVisualRows(text, width, { firstWidth = width } = {}) {
  const limitOf = (emitted) => Math.max(1, Math.floor(emitted === 0 ? firstWidth : width));
  const rows = [];
  for (const logicalLine of String(text ?? "").replace(/\n+$/, "").split("\n")) {
    if (logicalLine.length === 0) {
      rows.push("");
      continue;
    }
    let row = "";
    let cells = 0;
    const characters = GRAPHEME_SEGMENTER
      ? Array.from(GRAPHEME_SEGMENTER.segment(logicalLine), (part) => part.segment)
      : Array.from(logicalLine);
    for (const character of characters) {
      const next = Math.max(1, stringWidth(character));
      if (row && cells + next > limitOf(rows.length)) {
        rows.push(row);
        row = "";
        cells = 0;
      }
      row += character;
      cells += next;
    }
    rows.push(row);
  }
  return rows;
}

/** 展开预览按实际物理行保留尾部，并用首行说明省略量。 */
export function thinkingPreview(text, width, maxRows) {
  const rows = wrapVisualRows(splitThinkingText(text).body, width);
  const limit = Math.max(1, Math.floor(maxRows));
  if (rows.length <= limit) return rows;
  if (limit === 1) return [`… ${rows.length} earlier rows`];
  const kept = rows.slice(-(limit - 1));
  return [`… ${rows.length - kept.length} earlier rows`, ...kept];
}

/**
 * 思考进行中按已流式到达的正文估算输出 token。
 *
 * 提供方只在回合收尾上报用量（miro 是每轮一次，ACP 是 PromptResponse.usage），
 * 直接读 state.tokens 会让「还在想」这一行整段思考期间卡在上一个读数（比如
 * `↓199`）不动。唯一实时信号是随思考内容增长的 thought.text，据此估算让
 * `↓` 从 0 跟着内容往上走。
 *
 * 估算按终端 cell 宽度走：CJK/emoji 约 1 token/字符，窄字符约 1 token/4 字符，
 * 与 markdown-width 的视角一致；它不是 provider 的真实计数，只作「还在产出」的
 * 实时指示。尚无内容返回 0（让调用方回退到最近一次上报读数）。
 *
 * 它要对整段正文分段，成本随正文长度线性增长，因此调用方按采样桶而非每个思考
 * 批次重算（见 sampleThoughtTokens）。
 */
export function estimateThoughtOutputTokens(text) {
  const content = String(text ?? "");
  if (content.length === 0) return 0;
  const characters = GRAPHEME_SEGMENTER
    ? Array.from(GRAPHEME_SEGMENTER.segment(content), (part) => part.segment)
    : Array.from(content);
  let tokens = 0;
  for (const character of characters) {
    tokens += Math.max(1, stringWidth(character)) >= 2 ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * 动画时钟 tick → 采样桶号：估算读数按桶取值，同一个桶内不再重算。
 *
 * 桶取自全局动画时钟（每 100ms 一个 tick），不另起定时器：各自跑间隔的东西会
 * 落在不同的提交里，而 Ink 的真实光标只在「上报过位置的那次提交」里回到输入格。
 */
export function thoughtStatBucket(tick, everyTicks) {
  const step = Number.isFinite(everyTicks) ? Math.max(1, Math.floor(everyTicks)) : 1;
  const value = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0;
  return Math.floor(value / step);
}

/**
 * 取一次估算读数：同一个桶内、且正文只是继续增长时沿用上一次的结果。
 *
 * 这就是「节流」所在：50ms 一批的思考内容不会带着这一行数字一起重算、重画。
 * 换了一段思考（正文不再是上一次采样内容的续写）或被 50KB 上限截断时立即重新
 * 采样，否则新的 Thinking 行会先印着上一段的 `↓` 数字，直到跨桶才纠正。
 * 尚无内容时估算为 0，调用方据此回退到最近一次上报读数。
 */
export function sampleThoughtTokens(previous, text, bucket) {
  const content = String(text ?? "");
  if (previous != null && previous.bucket === bucket && content.startsWith(previous.text)) {
    return previous;
  }
  return { bucket, text: content, tokens: estimateThoughtOutputTokens(content) };
}

/**
 * 摘要恒定一行；duration 为 null（不足 1 秒）时整段计时都不出现，
 * 拼成 ` · null`（或没意义的 ` · 0s`）都会破坏这一行的可读性。
 */
export function thoughtSummaryText(thought, duration) {
  const title = thought?.title ?? splitThinkingText(thought?.text).title;
  const stamp = duration ? ` · ${duration}` : "";
  return title ? `Thought: ${title}${stamp}` : `Thought${stamp}`;
}
