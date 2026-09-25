/**
 * 上下文压缩的纯逻辑层：什么时候压、从哪里切、拿什么提示词去摘要。
 *
 * 这里刻意不碰 LLM、不碰 messages 数组本身，全部是可单测的纯函数。真正
 * 发请求与替换历史在 agent-loop.js —— 拆开的理由是阈值与切点是最容易出错
 * 的部分（切错一刀就是 provider 400），必须能脱离网络单独验证。
 *
 * 阈值取比例而非绝对预留（pi 用 `window - 16384`，fx 用 `usable * 80%`）：
 * miro 的 contextWindow 来自用户可改的 models.json，32K 到 200K 都有，
 * 绝对预留在小窗口上一开场就触发、在大窗口上又压得太晚。
 */
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

/** 高水位：占用达到可用额度的这个比例就压缩。 */
export const COMPACTION_HIGH_WATER_RATIO = 0.8;
/** 摘要后期望的常驻占用，用于反推摘要自身的 token 预算。 */
export const COMPACTION_TARGET_RATIO = 0.1;
/** 尾部原样保留的预算比例。留太多会让压缩几乎不省空间。 */
export const COMPACTION_KEEP_RECENT_RATIO = 0.2;
/**
 * 摘要请求自身要留的余量比例。
 *
 * 摘要请求把整段历史当输入发出去，它自己也可能超窗。留出这一档之后，
 * 超过额度的历史会被 planCompaction 判为 oversized，走分块摘要。
 */
export const COMPACTION_RESERVE_RATIO = 0.15;

/**
 * 摘要提示词。结构化模板而非「请总结」：自由格式的摘要在多轮迭代后会
 * 退化成越来越短的空话，固定小标题能迫使模型逐项交代，也让下一次压缩
 * 有稳定的字段可以更新。
 */
export const SUMMARIZATION_SYSTEM_PROMPT = [
  "You are a context summarization assistant.",
  "Read the conversation and produce a structured checkpoint summary that another assistant will use to continue the work.",
  "Do NOT continue the conversation. Do NOT answer any question inside it. Output ONLY the summary.",
].join("\n");

const SUMMARY_TEMPLATE = [
  "## Goal",
  "[What is the user trying to accomplish?]",
  "",
  "## Constraints & Preferences",
  '- [Constraints or preferences the user stated, or "(none)"]',
  "",
  "## Progress",
  "### Done",
  "- [x] [Completed work]",
  "",
  "### In Progress",
  "- [ ] [Current work]",
  "",
  "### Blocked",
  "- [Blockers, or omit if none]",
  "",
  "## Key Decisions",
  "- **[Decision]**: [Rationale]",
  "",
  "## Next Steps",
  "1. [What should happen next]",
  "",
  "## Critical Context",
  '- [Data, paths, or references needed to continue, or "(none)"]',
].join("\n");

const REQUIRED_SUMMARY_HEADINGS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
];

const SUCCESSFUL_SUMMARY_FINISH_REASONS = new Set(["stop", "end_turn", "completed"]);

/**
 * 摘要是破坏性历史替换的依据，必须先确认响应完整。结构不完全时仍可软接受，
 * 但截断、过滤、取消、工具调用或未知终态一律失败关闭。
 */
export function validateSummaryResult(result = {}) {
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (result.cancelled) return { ok: false, reason: "summary_cancelled" };
  if (Array.isArray(result.calls) && result.calls.length > 0) {
    return { ok: false, reason: "summary_tool_call" };
  }
  if (!SUCCESSFUL_SUMMARY_FINISH_REASONS.has(result.finishReason)) {
    return { ok: false, reason: "summary_incomplete" };
  }
  if (text.length === 0) return { ok: false, reason: "empty_summary" };

  const exact = REQUIRED_SUMMARY_HEADINGS.every((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}\\s*$`, "m").test(text);
  });
  return { ok: true, text, schemaStatus: exact ? "exact" : "soft_fallback" };
}

/** 压缩只有确实缩小并重新落入高水位内才算成功。 */
export function validateCompactionAdmission({ before, after, highWater } = {}) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(highWater)) {
    return { ok: false, reason: "post_admission_failed" };
  }
  if (after >= before || after > highWater) return { ok: false, reason: "post_admission_failed" };
  return { ok: true };
}

/** 首次压缩用的指令。 */
export const SUMMARIZATION_PROMPT = [
  "The messages above are a conversation to summarize.",
  "",
  "Use this EXACT format:",
  "",
  SUMMARY_TEMPLATE,
  "",
  "Keep each section concise. Preserve exact file paths, function names, commands, and error messages verbatim.",
].join("\n");

/**
 * 已有摘要时用的指令。
 *
 * 迭代更新而不是重新摘要全部历史：重新摘要会把上一轮摘要再摘一遍，
 * 早期决策经过两三轮就被压成一句空话。
 */
export const UPDATE_SUMMARIZATION_PROMPT = [
  "The messages above are NEW messages to fold into the existing summary given in <previous-summary>.",
  "",
  "RULES:",
  "- PRESERVE all still-relevant information from the previous summary.",
  "- ADD new progress, decisions, and context from the new messages.",
  '- MOVE items from "In Progress" to "Done" when they were completed.',
  "- UPDATE Next Steps to reflect the current state.",
  "- PRESERVE exact file paths, function names, commands, and error messages verbatim.",
  "- Drop items that are genuinely no longer relevant.",
  "",
  "Use this EXACT format:",
  "",
  SUMMARY_TEMPLATE,
  "",
  "Keep each section concise.",
].join("\n");

/** 摘要消息注入历史时的包裹文本，便于识别与剥离。 */
export const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n";
export const SUMMARY_SUFFIX =
  "\n\nContinue the work from this summary. The messages after it are the retained recent history.";

/**
 * 压缩刚发生时注入历史 / transcript 的可见提示。
 *
 * 摘要消息自己只说「之前被压成了摘要」，不带水位数字；模型看不到状态栏，
 * 用户也只能从水位骤降猜。这条提示两边各看一次：历史里让模型知道自己
 * 刚丢了一段，transcript 里让用户知道界面不是坏了。
 */
export const COMPACTION_NOTICE_PREFIX = "[miro] Context compacted:";

function formatTokenCount(value) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  const rounded = Math.round(tokens);
  if (rounded >= 1000) return `${Math.round(rounded / 1000)}k`;
  return String(rounded);
}

export function formatCompactionNotice({ before, after } = {}) {
  return `${COMPACTION_NOTICE_PREFIX} ${formatTokenCount(before)} → ${formatTokenCount(after)} tokens. Earlier turns were summarized; continue from the retained recent history.`;
}

export function isCompactionNotice(message) {
  return message?.role === "system" && typeof message.content === "string" && message.content.startsWith(COMPACTION_NOTICE_PREFIX);
}

/** 上一轮的压缩提示过期了：再压一次时数字已经变了，留着只会打架。 */
export function dropCompactionNotices(messages) {
  if (!Array.isArray(messages)) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactionNotice(messages[index])) messages.splice(index, 1);
  }
}

/** 判断一条历史消息是否是压缩摘要（用于取上一次摘要、以及避免重复压缩）。 */
export function isSummaryMessage(message) {
  return message?.role === "system" && message?.miro_compaction === true;
}

/** 构造注入历史的摘要消息。 */
export function createSummaryMessage(summary) {
  return {
    role: "system",
    content: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`,
    // 自定义标记而不是靠文本前缀匹配：用户自己的消息可能恰好包含同样的话。
    miro_compaction: true,
  };
}

/** 从摘要消息里取回裸摘要正文，供下一次迭代更新使用。 */
export function summaryTextOf(message) {
  if (!isSummaryMessage(message)) return null;
  const content = typeof message.content === "string" ? message.content : "";
  const start = content.startsWith(SUMMARY_PREFIX) ? SUMMARY_PREFIX.length : 0;
  const end = content.endsWith(SUMMARY_SUFFIX) ? content.length - SUMMARY_SUFFIX.length : content.length;
  return content.slice(start, end);
}

/**
 * 一条消息的文本量，与 agent-loop 的水位估算口径保持一致。
 *
 * 必须把 tool_calls 的参数和 reasoning_content 算进去：工具密集的会话里
 * 这两块常比正文还多，漏算会让切点选得过于靠后，压完还是超窗。
 */
export function messageText(message) {
  const parts = [];
  if (typeof message?.content === "string") parts.push(message.content);
  else if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (typeof block?.text === "string") parts.push(block.text);
    }
  }
  if (typeof message?.reasoning_content === "string") parts.push(message.reasoning_content);
  for (const call of message?.tool_calls ?? []) {
    parts.push(call?.function?.name ?? "");
    const args = call?.function?.arguments;
    if (typeof args === "string") parts.push(args);
  }
  return parts.join("\n");
}

/** 把一段消息渲染成摘要请求的输入正文。 */
export function conversationText(messages) {
  const lines = [];
  for (const message of messages) {
    const role = message?.role ?? "unknown";
    const text = messageText(message);
    if (text.length === 0) continue;
    lines.push(`[${role}] ${text}`);
  }
  return lines.join("\n\n");
}

/**
 * 估算一段消息的 token 数。
 *
 * estimate 由调用方注入（backend.estimateTokens），这样这个模块不依赖任何
 * 具体 provider，测试里可以注入「字符数即 token 数」得到精确断言。
 */
export function estimateMessagesTokens(messages, estimate) {
  let total = 0;
  for (const message of messages) total += estimate(messageText(message));
  return total;
}

/**
 * 压缩决策。
 *
 * @param {object} input
 * @param {number} input.used 当前占用（优先用 provider 回报的真实值）
 * @param {number} input.contextWindow 模型上下文窗口
 * @param {"automatic"|"manual"|"overflow"} input.trigger
 * @param {boolean} input.enabled
 * @returns {{ compact: boolean, reason: string, highWater: number, targetTokens: number, keepRecentTokens: number, reserveTokens: number }}
 */
export function planCompaction({
  used = 0,
  contextWindow = 0,
  trigger = "automatic",
  enabled = true,
} = {}) {
  const usable = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  const highWater = Math.floor(usable * COMPACTION_HIGH_WATER_RATIO);
  const plan = {
    compact: false,
    reason: "below_threshold",
    highWater,
    targetTokens: Math.floor(usable * COMPACTION_TARGET_RATIO),
    keepRecentTokens: Math.floor(usable * COMPACTION_KEEP_RECENT_RATIO),
    reserveTokens: Math.floor(usable * COMPACTION_RESERVE_RATIO),
  };

  if (!enabled && trigger !== "manual") return { ...plan, reason: "disabled" };
  if (usable === 0) return { ...plan, reason: "unknown_window" };
  // 手动命令绕过自动开关；超窗恢复只绕过水位，仍尊重自动开关。
  if (trigger === "manual" || trigger === "overflow") return { ...plan, compact: true, reason: trigger };
  if (used >= highWater) return { ...plan, compact: true, reason: "threshold" };
  return plan;
}

/**
 * 某个下标能否作为切点。
 *
 * 这是整个模块最关键的约束。带 tool_calls 的 assistant 消息后面必须紧跟
 * 每个 tool_call_id 对应的 tool 消息，切在中间会留下孤儿 tool_call 或
 * 无主 tool 应答，OpenAI 兼容实现与 Anthropic 都会直接 400，而且是整条
 * 会话之后每次请求都失败。
 *
 * 因此合法切点只有两类：user 消息，以及不带 tool_calls 的 assistant 消息。
 * tool 消息与带 tool_calls 的 assistant 都不可切。system 也不可切 —— 那些是
 * plan/空响应提醒，由 agent-loop 自己按环境状态增删，不该被压缩搬动。
 */
export function isValidCutPoint(messages, index) {
  if (index <= 0 || index >= messages.length) return false;
  const message = messages[index];
  if (message?.role === "tool") return false;
  if (message?.role === "system") return false;
  if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return false;
  }
  // 前一条带着 tool_calls 时，这一条必须是它的 tool 应答，不能在此切开。
  const previous = messages[index - 1];
  if (previous?.role === "assistant" && Array.isArray(previous.tool_calls) && previous.tool_calls.length > 0) {
    return false;
  }
  return true;
}

/** 列出所有合法切点下标（升序）。 */
export function validCutPoints(messages) {
  const points = [];
  for (let index = 1; index < messages.length; index += 1) {
    if (isValidCutPoint(messages, index)) points.push(index);
  }
  return points;
}

/**
 * 选切点：从尾部往前累加 token，够 keepRecentTokens 就停，再向后吸附到
 * 最近的合法切点。
 *
 * 吸附方向是「向后」（往新的方向）而不是向前：向前会把更多消息划进保留区，
 * 保留区反而超过预算，压缩就白做了。宁可少保留一点。
 *
 * @returns {number} 首条保留消息的下标；0 表示没有可压缩的部分
 */
export function findCutPoint(messages, keepRecentTokens, estimate) {
  const points = validCutPoints(messages);
  if (points.length === 0) return 0;

  let accumulated = 0;
  let boundary = messages.length;
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    accumulated += estimate(messageText(messages[index]));
    boundary = index;
    if (accumulated >= keepRecentTokens) break;
  }

  // 第一个 >= boundary 的合法切点。都比 boundary 小时取最后一个，
  // 至少保证切出点东西来（否则长 tool 链会让压缩永远无法进行）。
  for (const point of points) {
    if (point >= boundary) return point;
  }
  return points[points.length - 1];
}

/**
 * 把历史切成「待摘要」「保留」两段。
 *
 * @returns {{ toSummarize: Array, retained: Array, previousSummary: string|null, cutIndex: number, systemNotices: Array }}
 */
export function splitForCompaction(messages, keepRecentTokens, estimate) {
  // 上一次的摘要单独取出：它不进待摘要段（否则被二次压缩），而是作为
  // <previous-summary> 交给模型迭代更新。
  let previousSummary = null;
  for (const message of messages) {
    const text = summaryTextOf(message);
    if (text != null) previousSummary = text;
  }

  const cutIndex = findCutPoint(messages, keepRecentTokens, estimate);
  if (cutIndex <= 0) {
    return { toSummarize: [], retained: messages.slice(), previousSummary, cutIndex: 0, systemNotices: [] };
  }

  const head = messages.slice(0, cutIndex);
  const retained = messages.slice(cutIndex);
  // 环境状态类的 system 提醒（plan 模式、空响应催促）原样保留：它们描述
  // 当下的环境而不是对话内容，摘要成一句话就失效了。agent-loop 每轮会
  // 自行增删，这里只负责不把它们弄丢。
  const systemNotices = head.filter(
    (message) => message?.role === "system" && !isSummaryMessage(message) && !isCompactionNotice(message),
  );
  const toSummarize = head.filter((message) => message?.role !== "system");

  return { toSummarize, retained, previousSummary, cutIndex, systemNotices };
}

/**
 * 构造摘要请求的 messages。
 *
 * 单独一次无工具的请求，而不是在主对话里插一句「请总结」：后者会污染
 * 历史，而且模型可能顺手接着干活。
 */
export function buildSummaryRequest({ toSummarize, previousSummary = null, instructions = "" }) {
  const body = [`<conversation>\n${conversationText(toSummarize)}\n</conversation>`];
  if (previousSummary) body.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  body.push(previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
  if (instructions.trim()) body.push(`Additional summarization instructions:\n${instructions.trim()}`);
  return [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: body.join("\n\n") },
  ];
}

/**
 * 把待摘要段按预算切块。
 *
 * 摘要请求自身也可能超窗（历史本来就是因为太大才要压）。分块后逐块摘要、
 * 再把各块摘要拼起来，避免「因为上下文太大所以无法压缩上下文」的死锁。
 * 只在必要时分块：单块能装下时返回一个块，行为与不分块完全一致。
 */
export function planSummaryChunks(toSummarize, chunkBudget, estimate) {
  if (toSummarize.length === 0) return [];
  if (!Number.isFinite(chunkBudget) || chunkBudget <= 0) return [toSummarize];

  const chunks = [];
  let current = [];
  let currentTokens = 0;
  for (const message of toSummarize) {
    const tokens = estimate(messageText(message));
    // 单条就超预算时让它独占一块：切不动的东西硬塞进别的块只会让那块更糟。
    if (current.length > 0 && currentTokens + tokens > chunkBudget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 多块摘要合并成一份。单块时原样返回，不加多余标题。 */
export function mergeChunkSummaries(summaries) {
  const usable = summaries.filter((text) => typeof text === "string" && text.trim().length > 0);
  if (usable.length === 0) return "";
  if (usable.length === 1) return usable[0].trim();
  return usable
    .map((text, index) => `### Part ${index + 1} of ${usable.length}\n\n${text.trim()}`)
    .join("\n\n");
}

/** 判断一次失败是否是上下文超窗；vendor 特征与限流排除交给 pi-ai。 */
export function isContextOverflowError(error) {
  if (!error) return false;
  if (error.contextOverflow === true) return true;
  // 只归一化兼容网关的旧格式，不绕过上游对限流文案的排除。
  const errorMessage = [error.code, error.message ?? String(error)]
    .filter(Boolean)
    .join("\n")
    .replace(/prompt_too_long/gi, "prompt is too long")
    .replace(/input length and `max_tokens` exceed/gi, "exceeds the context window");
  return isContextOverflow({ stopReason: "error", errorMessage });
}
