import { create } from "zustand";

import {
  createSubagentState,
  extractRawText,
  updateSubagentState,
} from "./acp/subagent.js";
import {
  commandText,
  extractToolOutputPreview,
  extractToolPreview,
  buildToolDetail,
  formatToolLabel,
  summarizeToolResult,
  TERMINAL_STATUSES,
} from "./acp/tool-title.js";
import { buildBashCardLines, previewBashLines } from "./bash.js";
import { BASH_PREVIEW_LINES, MAX_TRANSCRIPT_LENGTH } from "./config.js";
import {
  advanceThinking,
  DEFAULT_THINKING_DISPLAY_MODE,
  normalizeThinkingDisplayMode,
  splitThinkingText,
  thinkingElapsed,
  thoughtSummaryText,
} from "./thinking.js";
import { formatDuration, nextId } from "./utils.js";
import { extractToolDiff } from "./acp/tool-diff.js";

/** 挂在模块级，避免进入 React 订阅链路。 */
let recorder = null;

export function setRecorder(next) {
  recorder = next;
}

/** blocks 已定稿进 <Static>；pending 是动态区里的流式尾巴。 */

const bannerBlock = () => ({ id: nextId(), role: "banner", text: "", head: true });

function appendBlock(state, block, record = true) {
  const entry = { id: nextId(), ...block };
  const diffLength = entry.tool?.diff == null
    ? 0
    : JSON.stringify(entry.tool.diff).length;
  const entryLength = (entry.text?.length ?? 0) +
    (entry.thought?.text?.length ?? 0) +
    (entry.tool?.hint?.length ?? 0) +
    diffLength;
  const length = state.length + entryLength;

  if (record && recorder) recorder.recordBlock(entry);

  if (length > MAX_TRANSCRIPT_LENGTH) {
    return { ...state, blocks: [entry], length: entryLength, epoch: state.epoch + 1 };
  }

  return { ...state, blocks: [...state.blocks, entry], length };
}

function commitPending(state) {
  const { pending } = state;
  if (!pending || pending.text.length === 0) return { ...state, pending: null };
  const text = pending.text.replace(/\n+$/, "");
  if (text.length === 0) return { ...state, pending: null };
  return { ...appendBlock(flushToolGroup(state), { ...pending, text }), pending: null };
}

const STREAM_BLOCK_MAX_CHARS = 300;
const MAX_THOUGHT_TEXT = 50_000;

/**
 * 非正常结局的回合提示。
 *
 * 没有它们，跑满工具轮次或被输出上限截断的回合在界面上与正常收尾完全一样，
 * 用户会把「被截住」误读成「做完了」。cancelled 不在表里：中断有自己的提示。
 */
const TURN_STOP_NOTICES = {
  max_turns: "Stopped after reaching the tool-call round limit — the task may be unfinished.",
  max_tokens: "The reply was cut off by the model's output token limit.",
  content_filter: "The provider stopped the reply with a content filter.",
  empty_response: "The model kept returning an empty reply — the turn ended without an answer.",
};
const FENCE_PATTERN = /(^|\n)( {0,3})(```|~~~)/g;

/** 未闭合围栏起点；全部闭合返回 -1。 */
function openFenceStart(text, upTo) {
  const region = text.slice(0, upTo);
  FENCE_PATTERN.lastIndex = 0;
  let open = -1;
  let match;
  while ((match = FENCE_PATTERN.exec(region))) {
    open = open < 0 ? match.index + match[1].length : -1;
  }
  return open;
}

// 表格行：`| a | b |`。表头与 `| --- |` 分隔行只在第一段里，切开之后的碎片
// 会被 Message.jsx 当成独立 markdown 文档解析，marked 认不出表格、只能按普通
// 段落吐出原始竖线——所以表格必须整块定稿。
const TABLE_ROW = /^ {0,3}\|.*\|\s*$/;
// 流式串流里最后一行往往还没收齐（`| 6 | \`url\`` 尚无收尾竖线），只看完整形态
// 会把它判成普通段落而放行这一刀，表格照旧被劈开。所以末行放宽到「以竖线开头」。
const TABLE_ROW_PARTIAL = /^ {0,3}\|/;
// 列表项与引用块同样是跨行结构，切在中间会让后半截丢掉列表语义。
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const BLOCKQUOTE = /^ {0,3}>/;

function isBlockStructureLine(line, partial = false) {
  if (partial ? TABLE_ROW_PARTIAL.test(line) : TABLE_ROW.test(line)) return true;
  return LIST_ITEM.test(line) || BLOCKQUOTE.test(line);
}

/**
 * 切点是否夹在同一个跨行块级结构中间。
 *
 * 判据以切点**前**一行为主：它是结构行时，这一刀就落在结构内部或紧贴其尾部。
 * 后一行只用来确认结构是否真的结束——只有明确是空行（结构已收尾）才放行。
 */
function splitsBlockStructure(text, cut) {
  const before = text.lastIndexOf("\n", cut - 1);
  const prevLine = text.slice(before + 1, cut);
  if (!isBlockStructureLine(prevLine)) return false;

  const rest = text.slice(cut + 1);
  const nextEnd = rest.indexOf("\n");
  // 末行尚未收齐（还没等到换行）时保守拒绝：此刻无从判断它是下一个结构行还是
  // 结构后的普通段落，而误切表格的代价远大于让 pending 多挂一会儿。放宽形态让
  // `| 6 | \`url\`` 这类残缺表格行也算结构内部。
  if (nextEnd < 0) return rest.length === 0 || isBlockStructureLine(rest, true);

  return isBlockStructureLine(rest.slice(0, nextEnd));
}

/** 找最后一个既不落在代码围栏内、也不劈开表格/列表/引用的切点。 */
function safeCut(text, separator) {
  let cut = text.lastIndexOf(separator);
  while (cut >= 0) {
    const fence = openFenceStart(text, cut);
    if (fence < 0) {
      // 空行（"\n\n"）本身就是块边界，只有按单行退化切分才可能劈开结构。
      if (separator !== "\n" || !splitsBlockStructure(text, cut)) return cut;
      cut = text.lastIndexOf(separator, cut - 1);
      continue;
    }
    const before = fence - separator.length;
    cut = before >= 0 ? text.lastIndexOf(separator, before) : -1;
  }
  return -1;
}

function streamChunk(state, chunk, role = "assistant", messageId = null) {
  const current = state.pending;
  const messageChanged =
    messageId != null && current?.messageId != null && messageId !== current.messageId;
  // 正文一旦开始/延续，先把待定稿的工具组封存进历史：否则短正文（无空行、
  // 不足 STREAM_BLOCK_MAX_CHARS）会一直挂在 pending，动态区里正文画在活动槽
  // 之上，等到 commitPending 才把组插到正文前面，屏幕上顺序当场翻转。
  const base = current && (current.role !== role || messageChanged)
    ? commitPending(state)
    : flushToolGroup(state);
  const pending = base.pending
    ? { ...base.pending, messageId: base.pending.messageId ?? messageId }
    : { role, text: "", head: true, messageId };
  const text = pending.text + chunk;

  let cut = safeCut(text, "\n\n");
  let separatorLength = 2;
  let nextGap = true;
  if (cut < 0 && text.length > STREAM_BLOCK_MAX_CHARS) {
    cut = safeCut(text, "\n");
    separatorLength = 1;
    nextGap = false;
  }
  if (cut < 0) return { ...base, pending: { ...pending, text } };

  const next = appendBlock(flushToolGroup(base), {
    role: pending.role,
    head: pending.head,
    gap: pending.gap,
    text: text.slice(0, cut),
  });
  return {
    ...next,
    pending: {
      role: pending.role,
      head: false,
      gap: nextGap,
      text: text.slice(cut + separatorLength),
      messageId: pending.messageId,
    },
  };
}

/**
 * 全局隐藏的伪工具标题黑名单：provider 借 kind=other 的工具调用汇报「正在规划」这类
 * 无参数、无输出的进度，渲染成工具只会在 transcript 里堆噪音。
 * 新增条目请保持锚定整行，避免误伤标题里正好含这些词的真实工具。
 */
const HIDDEN_TOOL_TITLES = [/^(?:任务)?规划中$/, /^(?:planning|planning task)$/i];

/** rawInput / locations 有的 provider 会给空 `{}` 或 `[]`，那不算真实参数，不能按真值判。 */
function hasPayloadDetail(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** 命中黑名单的 kind=other 伪工具不渲染成工具，折叠进 Thought 计时。 */
function isPlanningPlaceholder(payload) {
  if (payload?.toolKind !== "other") return false;
  if (payload?.name) return false;
  if (hasPayloadDetail(payload?.rawInput) || hasPayloadDetail(payload?.locations)) return false;
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  return HIDDEN_TOOL_TITLES.some((pattern) => pattern.test(title));
}

function beginThought(state) {
  if (state.thought) return state;
  return {
    ...flushToolGroup(state),
    thought: {
      startedAt: Date.now(),
      activeAt: null,
      activeMs: 0,
      pausedAt: null,
      pausedMs: 0,
      text: "",
      title: null,
      expanded: state.thinkingDisplay === "full",
    },
  };
}

/** content 与标题相同时不当作预览。 */
function isRedundantPreview(preview, label, title) {
  if (!preview || preview.more > 0) return false;
  const text = preview.lines.join("\n").trim();
  if (text.length === 0) return true;
  const candidates = [label.name, label.args, title]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return candidates.includes(text);
}

/** 思考片段定稿成结构化历史块；摘要恒定一行，full 模式由渲染层追加正文。 */
function flushThought(state) {
  const thought = state.thought;
  if (!thought) return state;
  const elapsed = thinkingElapsed(thought);
  const text = thought.text ?? "";
  const displayMode = normalizeThinkingDisplayMode(state.thinkingDisplay);
  return appendBlock(
    { ...state, thought: null },
    {
      role: "thought",
      head: true,
      text: thoughtSummaryText(thought, formatDuration(elapsed)),
      thought: {
        durationMs: elapsed,
        hasContent: text.trim().length > 0,
        title: thought.title ?? splitThinkingText(text).title,
        displayMode,
        text,
      },
    }
  );
}

/**
 * 把待合并工具组转成渲染字段。
 * live=true 表示该组仍占据当前活动槽：耗时继续走，直到组被冲刷进历史。
 */
export function toolFromGroup(group, { live = false, now = Date.now() } = {}) {
  const failed = group.items.some((item) => item.status === "failed" || item.status === "cancelled");
  const liveStatus = failed ? "failed" : "pending";
  const liveElapsed = group.startedAt != null ? Math.max(0, now - group.startedAt) : null;

  if (group.items.length === 1) {
    const { label, status, elapsed, preview, command, subagent, detail, diff, autoReview } = group.items[0];
    return {
      label,
      status: live ? liveStatus : status,
      elapsed: live ? liveElapsed : elapsed,
      hint: group.hint ?? null,
      preview: preview ?? null,
      command: command ?? null,
      subagent: subagent ?? null,
      detail: detail ?? null,
      diff: diff ?? null,
      autoReview: autoReview ?? null,
      reviewItems: group.items,
    };
  }
  let status = "pending";
  if (failed) {
    status = "failed";
  } else if (!live && group.items.every((item) => item.status === "completed")) {
    status = "completed";
  }
  // 并行子智能体不能被折叠成一句「N tool calls」：那样每个子智能体的工具行
  // 与最终摘要全部丢失，用户看不到并行的到底是什么。活动区（ActivitySlot）
  // 因此在折叠前就把它们从可折叠集合里摘掉，本函数只处理其余普通工具。
  return {
    group: {
      name: `${group.items.length} tool calls`,
      summary: summarizeToolCategories(group.items),
      count: group.items.length,
      items: group.items,
    },
    status,
    hint: group.hint ?? null,
    elapsed: live
      ? liveElapsed
      : group.startedAt != null && group.finishedAt != null
        ? group.finishedAt - group.startedAt
        : null,
    reviewItems: group.items,
  };
}

function summarizeToolCategories(items) {
  const counts = new Map();
  for (const item of items) {
    const name = String(item.label?.name ?? "Tool").toLowerCase();
    const category = name === "bash"
      ? "commands"
      : `${name}${name.endsWith("s") ? "" : name.endsWith("ch") ? "es" : "s"}`;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(" · ");
}

/** 把待合并工具组定稿成一个块。 */
function flushToolGroup(state) {
  const group = state.pendingToolGroup;
  if (!group) return state;

  const tool = toolFromGroup(group);
  const text = tool.group
    ? `${tool.group.name}${tool.group.summary ? ` · ${tool.group.summary}` : ""}`
    : tool.label.args
      ? `${tool.label.name}(${tool.label.args})`
      : tool.label.name;

  return appendBlock({ ...state, pendingToolGroup: null }, { role: "tool", head: true, text, tool });
}

function isRichTool(kind, name) {
  return kind === "execute" || kind === "edit" || name === "Bash" || name === "Edit";
}

function finalizeTool(state, tool) {
  const now = Date.now();
  const startedAt = tool.startedAt ?? now;
  // 定稿时 rawInput 已不再流式变化，diff 视为最终态；
  // 否则回合结束冲刷的残留工具（状态可能仍是 in_progress）会在历史区丢失 diff。
  const finalDiff = tool.diff ? { ...tool.diff, complete: true } : null;
  const item = {
    label: tool.label,
    kind: tool.kind ?? tool.raw?.kind ?? null,
    status: tool.status,
    elapsed: tool.startedAt != null ? now - tool.startedAt : null,
    preview: tool.preview ?? null,
    command: tool.command ?? null,
    subagent: tool.subagent ?? null,
    detail: tool.detail ?? null,
    diff: finalDiff,
    autoReview: tool.autoReview ?? null,
  };

  let next = commitPending(state);
  // 命令输出与文件 diff 都是富工具，始终独立成块，不参与工具组折叠。
  if (isRichTool(item.kind, item.label?.name)) {
    next = flushToolGroup(next);
    return flushToolGroup({
      ...next,
      pendingToolGroup: {
        name: item.label.name,
        items: [item],
        hint: tool.hint ?? null,
        startedAt,
        finishedAt: now,
      },
    });
  }

  const current = next.pendingToolGroup;
  if (current && !item.subagent && !current.items.some((entry) => entry.subagent)) {
    return {
      ...next,
      pendingToolGroup: {
        ...current,
        items: [...current.items, item],
        finishedAt: now,
      },
    };
  }
  next = flushToolGroup(next);
  return {
    ...next,
    pendingToolGroup: {
      name: tool.label.name,
      items: [item],
      hint: tool.hint ?? null,
      startedAt,
      finishedAt: now,
    },
  };
}

/**
 * complete diff（ACP content 或完整 newText）一旦出现，
 * 不再被流式半成品（complete=false 的 new_string 前缀）回退覆盖。
 */
function mergeDiff(candidate, previous) {
  if (candidate?.complete) return candidate;
  if (previous?.complete) return previous;
  return candidate ?? previous ?? null;
}

/**
 * 工具轮次计数：仅供 UI 拿来当「换一个 spinner 动词」的 key。
 *
 * 只在「当前没有活动工具」时递增，所以一批并行工具算一轮，动词不会在同一批里
 * 连跳几个词；模型每次重新调工具才换词，长回合里状态行因此看得出在推进。
 */
function bumpToolRound(state) {
  if (state.activeTools.length > 0) return state;
  return { ...state, toolRound: state.toolRound + 1 };
}

/**
 * 按 toolCallId 合并工具更新。终态后重发的 update 丢弃。
 * 子智能体以内部流的 RUN_FINISHED 为终态，不以 ACP status 为准。
 */
function mergeTool(state, payload) {
  const { toolCallId, status } = payload;
  if (toolCallId && state.finalizedToolIds.has(toolCallId)) return state;

  const trackedPlanning = toolCallId != null && state.planningToolIds.has(toolCallId);

  if (trackedPlanning || isPlanningPlaceholder(payload)) {
    const planningToolIds = new Set(state.planningToolIds);
    if (toolCallId) planningToolIds.add(toolCallId);
    if (TERMINAL_STATUSES.has(status)) {
      if (toolCallId) planningToolIds.delete(toolCallId);
      const next = flushThought(state);
      return {
        ...next,
        planningToolIds,
        finalizedToolIds: toolCallId
          ? new Set(next.finalizedToolIds).add(toolCallId)
          : next.finalizedToolIds,
      };
    }
    return { ...beginThought(state), planningToolIds };
  }

  const raw = {
    name: payload.name,
    kind: payload.toolKind,
    title: payload.title,
    rawInput: payload.rawInput,
    rawOutput: payload.rawOutput,
    locations: payload.locations,
  };

  if (!toolCallId) {
    const next = bumpToolRound(commitPending(flushThought(state)));
    const label = formatToolLabel(raw);
    const preview = summarizeToolResult({
      ...raw,
      name: label.name,
      content: payload.content,
      status,
    });
    return finalizeTool(next, {
      label,
      kind: raw.kind,
      status,
      preview: isRedundantPreview(preview, label, payload.title) ? null : preview,
      command: commandText(raw.rawInput),
      detail: buildToolDetail({ ...raw, content: payload.content }),
      diff: extractToolDiff({ ...raw, content: payload.content }),
    });
  }

  const existing = state.activeTools.find((tool) => tool.toolCallId === toolCallId);
  const isSubagent = payload.isSubagent === true || existing?.subagent != null;

  let next = state;
  if (!existing) {
    // 助手正文与工具保持独立；正文会同时封存此前已完成的工具组。
    next = commitPending(flushThought(next));
    next = bumpToolRound(next);
  }

  const subagent = isSubagent
    ? updateSubagentState(
        existing?.subagent ?? createSubagentState(),
        payload.rawInput,
        extractRawText(payload.content)
      )
    : null;

  const mergedRaw = existing ? { ...existing.raw } : {};
  for (const [key, value] of Object.entries(raw)) {
    if (value != null) mergedRaw[key] = value;
  }

  const nextLabel = formatToolLabel(mergedRaw);
  const nextStatus = status ?? existing?.status ?? "pending";
  const previewCandidate = isSubagent
    ? null
    : mergedRaw.kind === "execute"
      ? (extractToolOutputPreview(payload.rawOutput) ??
        extractToolPreview(payload.content) ??
        existing?.preview ??
        null)
      : summarizeToolResult({
          ...mergedRaw,
          name: nextLabel.name,
          content: payload.content,
          status: nextStatus,
        });
  const preview = isRedundantPreview(previewCandidate, nextLabel, payload.title ?? mergedRaw.title)
    ? null
    : previewCandidate;

  const merged = {
    toolCallId,
    raw: mergedRaw,
    label: nextLabel,
    status: nextStatus,
    startedAt: existing?.startedAt ?? Date.now(),
    hint: existing?.hint ?? null,
    preview,
    command: commandText(mergedRaw.rawInput),
    subagent,
    content: payload.content ?? existing?.content,
    detail: buildToolDetail({ ...mergedRaw, content: payload.content ?? existing?.content }),
    diff: mergeDiff(
      extractToolDiff({
        ...mergedRaw,
        content: payload.content ?? existing?.content,
      }),
      existing?.diff ?? null
    ),
    autoReview: payload.autoReview ?? existing?.autoReview ?? null,
  };

  if (merged.subagent && merged.status !== "failed" && merged.status !== "cancelled") {
    merged.status = merged.subagent.runFinished ? "completed" : "in_progress";
  }

  if (TERMINAL_STATUSES.has(merged.status)) {
    return {
      ...finalizeTool(next, merged),
      activeTools: next.activeTools.filter((tool) => tool.toolCallId !== toolCallId),
      finalizedToolIds: new Set(next.finalizedToolIds).add(toolCallId),
    };
  }

  // 富工具启动时先封存已有折叠组，避免活动区在组摘要和富内容之间来回替换。
  if (!existing && isRichTool(merged.raw?.kind, merged.label.name) && next.pendingToolGroup) {
    next = flushToolGroup(next);
  }

  return {
    ...next,
    activeTools: existing
      ? next.activeTools.map((tool) => (tool.toolCallId === toolCallId ? merged : tool))
      : [...next.activeTools, merged],
  };
}

/** 回合结束时按最后已知状态冲刷残留工具；取消回合不把运行态带进历史。 */
function flushActiveTools(state, cancelled = false) {
  let next = state;
  const finalized = new Set(state.finalizedToolIds);
  for (const tool of state.activeTools) {
    const finalTool = cancelled && (tool.status === "pending" || tool.status === "in_progress")
      ? { ...tool, status: "cancelled" }
      : tool;
    next = finalizeTool(next, finalTool);
    finalized.add(tool.toolCallId);
  }
  return { ...next, activeTools: [], finalizedToolIds: finalized };
}

/** 只保留 { status, content }，未知状态兜底为 pending。 */
function normalizePlanEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      status:
        entry?.status === "completed" || entry?.status === "in_progress" ? entry.status : "pending",
      content: typeof entry?.content === "string" ? entry.content : "",
    }))
    .filter((entry) => entry.content.length > 0);
}

/** 内容相同的计划快照不再重复打印。 */
function planSignatureOf(rows) {
  return rows.map((row) => `${row.status}\u0000${row.content}`).join("\n");
}

/** 落盘与计数用的纯文本。 */
function planBlockText(rows) {
  const lines = rows.map((row) => `${row.status === "completed" ? "☒" : "☐"} ${row.content}`);
  return ["Update Todos", ...lines].join("\n");
}

/** 把动态区的 bash 卡片定稿进 scrollback：只留预览，全量输出靠 ctrl+o 的窗口看。 */
function flushBashCard(state) {
  const card = state.bashCard;
  if (!card) return state;
  const { visible, hidden } = previewBashLines(card.lines, false, BASH_PREVIEW_LINES);
  const snapshot = { ...card, lines: visible, hidden };
  const text = visible.map((line) => line.text).join("\n");
  return {
    ...appendBlock(state, { role: "bashCard", head: true, text, card: snapshot }),
    bashCard: null,
  };
}

/** 顺序不可交换：工具组必须先于卡片、thought 与 pending 正文定稿。 */
function flushBeforeStandaloneBlock(state) {
  return flushBashCard(commitPending(flushThought(flushToolGroup(state))));
}

const TOKEN_FIELDS = ["total", "input", "output", "cacheRead", "cacheWrite", "thought"];
/** 六个字段的上报字段名：ACP 是 cachedRead/WriteTokens，部分链路写成 cacheRead/WriteTokens。 */
const TOKEN_FIELD_SOURCES = {
  total: ["totalTokens"],
  input: ["inputTokens"],
  output: ["outputTokens"],
  cacheRead: ["cachedReadTokens", "cacheReadTokens"],
  cacheWrite: ["cachedWriteTokens", "cacheWriteTokens"],
  thought: ["thoughtTokens"],
};

/** 上报载荷 → 六个字段的读数，未上报或非法值留 null（不能当成 0 参与累计）。 */
function reportedTokenCounts(usage) {
  const pick = (keys) => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return null;
  };
  const counts = {};
  for (const field of TOKEN_FIELDS) counts[field] = pick(TOKEN_FIELD_SOURCES[field]);
  return counts;
}

function sameTokenCounts(a, b) {
  if (a === b) return true;
  return TOKEN_FIELDS.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null));
}

/** 上报的 cost 读数 → { amount, currency }；未上报、非法值与非正值留 null。 */
function reportedCost(cost) {
  const amount = cost?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const currency = typeof cost?.currency === "string" && cost.currency ? cost.currency : "USD";
  return { amount, currency };
}

export const useStore = create((set, get) => ({
  blocks: [],
  pending: null,
  epoch: 0,
  length: 0,

  activeTools: [],
  finalizedToolIds: new Set(),
  planningToolIds: new Set(),
  toolRound: 0,
  pendingToolGroup: null,
  thought: null,
  thinkingDisplay: DEFAULT_THINKING_DISPLAY_MODE,
  planSignature: null,
  queuedInputs: [],
  providerCommands: [],
  pendingBashContext: [],
  bashCard: null,

  status: "connecting",
  connectionStage: "Starting ACP…",
  providerName: null,
  providerId: null,
  sessionId: null,
  sessionMeta: null,
  sessionTitle: null,
  providerCapabilities: null,
  modelConfig: null,
  effortConfig: null,
  configOptions: [],
  modes: null,
  busy: false,
  cancelling: false,
  switching: null,
  overlay: null,
  fatalError: null,

  usage: null,
  tokens: null,
  sessionTokens: null,
  sessionCost: null,
  planProgress: null,
  gitBranch: null,

  /**
   * 当前目标快照，由 miro client 的 goal 事件驱动；null 表示没有目标。
   *
   * 只存快照不存状态机：状态机的所有权在 client 那边（它才驱动续跑），UI 这里
   * 复制一份可变对象只会制造两个真相。ACP provider 不发这个事件，恒为 null。
   */
  goal: null,

  turnStartedAt: null,
  turnKind: null,
  turnBlocksAt: 0,

  /**
   * 全局动画帧计数：spinner 这类周期动画的唯一时钟（见 animation-clock.js）。
   *
   * 放在 store 里而不是某个组件的 state：Ink 的 useCursor 只在「上报过光标位置
   * 的那一次提交」里把真实光标放回输入格，别的组件自己重渲的帧会把它藏掉。
   * 让所有跟着动画走的东西订阅同一个字段，它们就会在同一次提交里重渲，
   * 每一帧都重新带上光标锚点（见 hooks/use-input-cursor.js）。
   */
  animationTick: 0,

  /**
   * 重试提示：由 client 的 retry 事件驱动，null 表示当前没有在重试。
   * 只作为 UI 状态存在（StatusVerb 顶替动词），不写进 transcript ——
   * 重试是过程噪音，成功后不该在历史里留下痕迹。
   */
  retryNotice: null,

  push: (role, text) =>
    set((state) =>
      appendBlock(flushBeforeStandaloneBlock(state), {
        role,
        text,
        head: true,
      })
    ),
  appendChunk: (chunk, messageId) =>
    set((state) =>
      streamChunk(
        flushBashCard(flushThought(flushToolGroup(state))),
        chunk,
        "assistant",
        messageId
      )
    ),
  appendUserChunk: (chunk, messageId) =>
    set((state) =>
      streamChunk(flushBashCard(flushToolGroup(state)), chunk, "user", messageId)
    ),
  upsertTool: (payload) => set((state) => mergeTool(flushBashCard(state), payload)),

  startBashCard: (command) =>
    set((state) => ({
      ...flushBashCard(state),
      bashCard: {
        command,
        lines: [],
        status: "running",
        outcome: null,
      },
    })),
  finishBashCard: ({ stdout, stderr, outcome }) =>
    set((state) =>
      state.bashCard
        ? {
            bashCard: {
              ...state.bashCard,
              lines: buildBashCardLines(stdout, stderr),
              status: "done",
              outcome,
            },
          }
        : state
    ),
  noteThought: (text = "", now = Date.now()) =>
    set((state) => {
      const chunk = text ?? "";
      if (!state.thought) {
        return {
          ...flushToolGroup(state),
          thought: {
            startedAt: now,
            // 空片段不算「思考在流动」：只有真内容到达才开始累计。
            activeAt: chunk ? now : null,
            activeMs: 0,
            pausedAt: null,
            pausedMs: 0,
            text: chunk,
            title: splitThinkingText(chunk).title,
            expanded: state.thinkingDisplay === "full",
          },
        };
      }
      const combined = (state.thought.text ?? "") + chunk;
      const truncated = combined.length > MAX_THOUGHT_TEXT
        ? combined.slice(combined.length - MAX_THOUGHT_TEXT)
        : combined;
      const activity = chunk ? advanceThinking(state.thought, now) : null;
      return {
        thought: {
          ...state.thought,
          ...(activity ?? {}),
          text: truncated,
          title: state.thought.title ?? splitThinkingText(combined).title,
        },
      };
    }),

  setThinkingDisplay: (value) =>
    set((state) => {
      const thinkingDisplay = normalizeThinkingDisplayMode(value);
      if (thinkingDisplay === state.thinkingDisplay) return state;
      return {
        thinkingDisplay,
        thought: state.thought
          ? { ...state.thought, expanded: thinkingDisplay === "full" }
          : state.thought,
      };
    }),

  setThoughtPaused: (paused, now = Date.now()) =>
    set((state) => {
      const thought = state.thought;
      if (!thought) return state;
      if (paused) {
        if (thought.pausedAt != null) return state;
        return { thought: { ...thought, pausedAt: now } };
      }
      if (thought.pausedAt == null) return state;
      return {
        thought: {
          ...thought,
          pausedAt: null,
          pausedMs: (thought.pausedMs ?? 0) + Math.max(0, now - thought.pausedAt),
        },
      };
    }),

  setPlan: (entries) =>
    set((state) => {
      const rows = normalizePlanEntries(entries);
      if (rows.length === 0) return state.planSignature == null ? state : { planSignature: null };

      const signature = planSignatureOf(rows);
      const planProgress = {
        total: rows.length,
        completed: rows.filter((row) => row.status === "completed").length,
      };
      if (signature === state.planSignature) {
        const current = state.planProgress;
        return current != null &&
          current.total === planProgress.total &&
          current.completed === planProgress.completed
          ? state
          : { planProgress };
      }

      const next = flushBeforeStandaloneBlock(state);
      return {
        ...appendBlock(next, {
          role: "plan",
          head: true,
          text: planBlockText(rows),
          plan: { entries: rows },
        }),
        planSignature: signature,
        planProgress,
      };
    }),

  /**
   * 目标快照更新。
   *
   * 状态机每次变更都会 emit，其中一部分（累计 token）不改变任何可见字段，
   * 逐一比较可见字段、无变化就返回原 state，避免状态栏白重渲一次。
   *
   * 墙钟必须参与比较：底栏的 `◎ /goal active (4s)` 印的就是它，而 App 的秒表
   * 正是靠「读一次快照 → 发现耗时变了」把数字推上去的，漏掉这一项会让计时
   * 永远停在第一次 emit 的读数上。
   */
  setGoal: (snapshot) =>
    set((state) => {
      if (snapshot == null) return state.goal == null ? state : { goal: null };
      const current = state.goal;
      const same =
        current != null &&
        current.goalId === snapshot.goalId &&
        current.status === snapshot.status &&
        current.objective === snapshot.objective &&
        current.turnsUsed === snapshot.turnsUsed &&
        current.wallClockMs === snapshot.wallClockMs &&
        current.terminalReason === snapshot.terminalReason &&
        current.budget?.turnBudget === snapshot.budget?.turnBudget;
      return same ? state : { goal: snapshot };
    }),

  queueInput: (text, display = null) =>
    set((state) => ({ queuedInputs: [...state.queuedInputs, { text, display }] })),
  replaceQueuedInputs: (items) =>
    set({
      queuedInputs: Array.isArray(items)
        ? items.map((item) => ({
            text: typeof item?.text === "string" ? item.text : "",
            display: typeof item?.display === "string" ? item.display : null,
          }))
        : [],
    }),
  updateQueuedInput: (index, text) =>
    set((state) => ({
      queuedInputs: state.queuedInputs.map((item, itemIndex) =>
        itemIndex === index ? { text, display: null } : item
      ),
    })),
  removeQueuedInput: (index) =>
    set((state) => ({
      queuedInputs: state.queuedInputs.filter((_, itemIndex) => itemIndex !== index),
    })),
  moveQueuedInput: (index, direction) =>
    set((state) => {
      const target = index + direction;
      if (index < 0 || index >= state.queuedInputs.length || target < 0 || target >= state.queuedInputs.length) {
        return state;
      }
      const queuedInputs = [...state.queuedInputs];
      [queuedInputs[index], queuedInputs[target]] = [queuedInputs[target], queuedInputs[index]];
      return { queuedInputs };
    }),
  clearQueuedInputs: () => set({ queuedInputs: [] }),
  takeQueuedInput: () => {
    const queue = get().queuedInputs;
    if (queue.length === 0) return null;
    set({ queuedInputs: queue.slice(1) });
    return queue[0];
  },

  setProviderCommands: (providerCommands) => set({ providerCommands: providerCommands ?? [] }),

  pushBashContext: (text) =>
    set((state) => ({ pendingBashContext: [...state.pendingBashContext, text] })),
  takeBashContext: () => {
    const items = get().pendingBashContext;
    if (items.length > 0) set({ pendingBashContext: [] });
    return items;
  },
  restoreBashContext: (items) =>
    set((state) => ({ pendingBashContext: [...items, ...state.pendingBashContext] })),

  clearTranscript: () =>
    set((state) => ({
      blocks: state.status === "ready" ? [bannerBlock()] : [],
      pending: null,
      activeTools: [],
      finalizedToolIds: new Set(),
      planningToolIds: new Set(),
      toolRound: 0,
      pendingToolGroup: null,
      thought: null,
      planSignature: null,
      planProgress: null,
      // 目标依附于会话上下文：清空 transcript 后留着目标，会让续跑循环对着一段
      // 空历史继续推进。client 侧的状态机由 /clear 的新建会话流程自行重置。
      goal: null,
      bashCard: null,
      epoch: state.epoch + 1,
      length: 0,
    })),

  connected: ({ providerName, sessionId, providerCapabilities, modelConfig, effortConfig, configOptions, modes }) =>
    set((state) => {
      const hasBanner = state.blocks.some((block) => block.role === "banner");
      const nextSessionId = sessionId ?? null;
      const sessionChanged = state.sessionId !== nextSessionId;
      return {
        ...(hasBanner ? state : appendBlock(state, bannerBlock(), false)),
        status: "ready",
        connectionStage: null,
        providerName,
        sessionId: nextSessionId,
        providerCapabilities: providerCapabilities ?? state.providerCapabilities,
        modelConfig,
        effortConfig,
        configOptions: Array.isArray(configOptions) ? configOptions : state.configOptions,
        modes: modes ?? null,
        ...(sessionChanged
          ? {
              usage: null,
              tokens: null,
              sessionTokens: null,
              sessionCost: null,
              sessionTitle: null,
              planProgress: null,
              goal: null,
            }
          : {}),
      };
    }),

  hydrate: (historyBlocks) =>
    set((state) => {
      let next = state;
      for (const block of historyBlocks) {
        if (!block || block.role === "banner") continue;
        next = appendBlock(next, block, false);
      }
      return next;
    }),

  setSessionMeta: (sessionMeta) => set({ sessionMeta }),
  setSessionTitle: (sessionTitle) =>
    set((state) =>
      state.sessionTitle === (sessionTitle ?? null) ? state : { sessionTitle: sessionTitle ?? null }
    ),
  /**
   * usage_update：上下文窗口（`usage`）与会话累计成本（`sessionCost`）。
   *
   * 成本与 token 一样有两条口径，生产者用 `costCumulative: true` 标明「本次读数
   * 就是会话累计值」（ACP 协议里 `Cost.amount` 是 "Total cumulative cost for
   * session"），miro 则是每次 LLM 请求的增量，直接相加。未上报成本的调用保留
   * 上一次读数，不会把累计值清零。
   */
  setUsage: ({ used, size, cost, costCumulative } = {}) =>
    set((state) => {
      const next = {
        used: typeof used === "number" ? used : state.usage?.used ?? null,
        size: typeof size === "number" ? size : state.usage?.size ?? null,
        cost: cost ?? state.usage?.cost ?? null,
      };
      const reading = reportedCost(cost);
      let sessionCost = state.sessionCost;
      if (reading) {
        sessionCost = costCumulative === true
          ? reading
          : { amount: (sessionCost?.amount ?? 0) + reading.amount, currency: reading.currency };
      }
      const current = state.usage;
      if (
        current &&
        current.used === next.used &&
        current.size === next.size &&
        current.cost === next.cost &&
        sessionCost === state.sessionCost
      ) {
        return state;
      }
      return { usage: next, sessionCost };
    }),
  /**
   * token_usage 同时维护两份读数，因为两条链路的累计口径不同：
   *
   * - `tokens`：提供方最近一次上报的读数，原样保留（未上报的字段保持原值）。
   *   ActivitySlot 的思考行提示与 README 都按「最近一次读数」描述它。
   * - `sessionTokens`：会话累计用量，供状态栏的累计项与 Ctrl+C 退出摘要。
   *
   * miro 每次完成的 LLM 请求上报的是本次增量，直接相加；ACP 的
   * `PromptResponse.usage` 按协议是会话累计快照（`totalTokens` 是 "Sum of all
   * token types across session"），只能相对上一条读数取增量，否则每一轮都会把
   * 之前的量再算一遍。生产者用 `sessionCumulative: true` 标明后一种口径。
   */
  setTokens: (usage) =>
    set((state) => {
      if (!usage || typeof usage !== "object") return state;
      const reported = reportedTokenCounts(usage);
      const previous = state.tokens;
      const cumulative = usage.sessionCumulative === true;
      const reading = {};
      const totals = {};
      for (const field of TOKEN_FIELDS) {
        const value = reported[field];
        const last = previous?.[field];
        const lastValue = typeof last === "number" ? last : null;
        reading[field] = value ?? lastValue;
        // 计数器回退（agent 换了会话计数）不能倒扣已有累计值。
        const step = cumulative ? Math.max(0, value - (lastValue ?? 0)) : value;
        const accumulated = state.sessionTokens?.[field];
        const base = typeof accumulated === "number" ? accumulated : null;
        // 只有「未上报」才保留原累计值：上报了 0 就是 0（哪怕此前没有任何
        // 累计），否则 formatSessionTokenUsage 里那条「0 也要显示」的分支
        // 在真实数据下永远走不到。
        totals[field] = value == null ? base : (base ?? 0) + step;
      }
      if (sameTokenCounts(previous, reading) && sameTokenCounts(state.sessionTokens, totals)) {
        return state;
      }
      return { tokens: reading, sessionTokens: totals };
    }),
  setGitBranch: (gitBranch) =>
    set((state) => (state.gitBranch === (gitBranch ?? null) ? state : { gitBranch: gitBranch ?? null })),
  setConfigs: ({ modelConfig, effortConfig, configOptions }) =>
    set({
      modelConfig,
      effortConfig,
      ...(configOptions !== undefined ? { configOptions: configOptions ?? [] } : {}),
    }),
  setModes: (modes) => set({ modes }),
  setConnectionStage: (connectionStage) => set({ connectionStage }),
  setProviderId: (providerId) => set({ providerId }),
  reconnecting: () =>
    set({
      status: "connecting",
      connectionStage: "Starting ACP…",
      modes: null,
      providerCommands: [],
      planSignature: null,
      planningToolIds: new Set(),
      planProgress: null,
      goal: null,
      usage: null,
      tokens: null,
      sessionTokens: null,
      sessionCost: null,
      sessionTitle: null,
      fatalError: null,
    }),

  connectionFailed: () =>
    set({
      status: "failed",
      switching: null,
      busy: false,
      cancelling: false,
      turnStartedAt: null,
      retryNotice: null,
    }),
  setSwitching: (switching) => set({ switching }),
  /** 推进一帧动画；唯一的调用方是 animation-clock.js 里的单例调度器。 */
  bumpAnimationTick: () => set((state) => ({ animationTick: state.animationTick + 1 })),
  setOverlay: (overlay) => set({ overlay }),
  setCancelling: (cancelling) => set({ cancelling }),
  setFatalError: (fatalError) => set({ fatalError }),
  /** payload 为 null 表示重试结束（成功或放弃），把状态行还给普通动词。 */
  setRetryNotice: (retryNotice) => set({ retryNotice: retryNotice ?? null }),

  startTurn: (kind = "prompt") =>
    set((state) => ({
      busy: true,
      cancelling: false,
      turnStartedAt: Date.now(),
      turnKind: kind,
      turnBlocksAt: state.blocks.length,
      toolRound: 0,
      retryNotice: null,
    })),
  endTurn: (result) =>
    set((state) => {
      const wasCancelled =
        state.cancelling ||
        result === true ||
        result === "cancelled" ||
        result?.cancelled === true ||
        result?.stopReason === "cancelled";
      let next = commitPending(
        flushToolGroup(flushActiveTools(flushThought(state), wasCancelled))
      );
      if (wasCancelled) {
        next = appendBlock(next, { role: "error", head: true, text: "Interrupted by user" });
      } else {
        // 非正常结局必须留痕：跑满工具轮次或被输出上限截断时，界面上不能与
        // 正常收尾长得一模一样，否则用户看不出 agent 是被截住而不是做完了。
        const notice = TURN_STOP_NOTICES[result?.stopReason];
        if (notice) next = appendBlock(next, { role: "error", head: true, text: notice });
        if (
          state.turnKind === "prompt" &&
          state.turnStartedAt != null &&
          next.blocks.length > state.turnBlocksAt
        ) {
          const elapsed = formatDuration(Date.now() - state.turnStartedAt);
          next = appendBlock(next, {
            role: "system",
            head: true,
            // 收尾行本身才是信息，不到一秒的「Done in 0s」是纯噪声。
            text: elapsed ? `Done in ${elapsed}` : "Done",
          });
        }
      }
      return {
        ...next,
        finalizedToolIds: new Set(),
        planningToolIds: new Set(),
        planSignature: null,
        busy: false,
        cancelling: false,
        turnStartedAt: null,
        turnKind: null,
        retryNotice: null,
      };
    }),
}));
