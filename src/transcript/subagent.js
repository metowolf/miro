/**
 * spawn_agent 内部事件流解析：provider 把 JSONL 快照放在 tool_call_update.content。
 * 快照按追加全量重发，只解析新增后缀；不完整的末行留到下次。
 */

/** 只重建这些参数键，正文类增量丢弃。 */
const ARG_KEYS = new Set([
  "file_path",
  "path",
  "filePath",
  "abs_path",
  "filename",
  "url",
  "uri",
  "command",
  "query",
  "pattern",
  "search_term",
]);

const ARG_VALUE_MAX_CHARS = 500;
const TEXT_MAX_CHARS = 10_000;
const REQUEST_VALUE_MAX_CHARS = 20_000;
const TOOL_RESULT_MAX_CHARS = 4_000;

/** 首选 rawInput.tool_call_name；首条 update 可能只有 title。 */
export function isSpawnAgentTool(info) {
  if (info == null || typeof info !== "object") return false;
  if (info.rawInput?.tool_call_name === "spawn_agent") return true;
  if (typeof info.title === "string" && info.title.trim() === "子智能体") return true;
  return false;
}

export function createSubagentState() {
  return {
    name: null,
    taskSummary: null,
    request: {},
    parsedOffset: 0,
    tools: [],
    text: "",
    tokens: 0,
    runFinished: false,
  };
}

/** 拼出 content 块里的原始文本。 */
export function extractRawText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (
      block?.type === "content" &&
      block.content?.type === "text" &&
      typeof block.content.text === "string"
    ) {
      text += block.content.text;
    }
  }
  return text;
}

function firstLineOf(text) {
  if (typeof text !== "string") return "";
  for (const line of text.split("\n")) {
    const flat = line.trim();
    if (flat.length > 0) return flat;
  }
  return "";
}

/** 合并 rawInput 里的任务元信息。 */
function mergeRawInput(state, rawInput) {
  if (rawInput == null || typeof rawInput !== "object") return state;
  const next = { ...state };
  const request = { ...(state.request ?? {}) };
  const description = rawInput.description ?? rawInput.sub_content;
  if (typeof description === "string" && description.length > 0) {
    request.description = description.slice(0, REQUEST_VALUE_MAX_CHARS);
  }
  for (const key of ["description", "message", "model", "effort"]) {
    if (typeof rawInput[key] !== "string" || rawInput[key].length === 0) continue;
    request[key] = rawInput[key].slice(0, REQUEST_VALUE_MAX_CHARS);
  }
  next.request = request;
  if (typeof rawInput.sub_content === "string" && rawInput.sub_content.trim().length > 0) {
    next.name = rawInput.sub_content.trim();
  }
  if (typeof rawInput.message === "string" && rawInput.message.trim().length > 0) {
    next.taskSummary = firstLineOf(rawInput.message);
  }
  return next;
}

/** 优先用 rawEvent.tool_call_id。 */
function toolIdOf(event) {
  return event.rawEvent?.tool_call_id ?? event.toolCallId ?? null;
}

function findTool(tools, id) {
  if (id == null) return -1;
  return tools.findIndex((tool) => tool.id === id);
}

/** 处理单条事件；tools 写时复制。 */
function applyEvent(state, event) {
  switch (event.type) {
    case "TOOL_CALL_START": {
      const id = toolIdOf(event);
      if (id == null || findTool(state.tools, id) >= 0) return state;
      const name =
        event.toolCallName ??
        event.rawEvent?.name ??
        event.rawEvent?.display_name ??
        "tool";
      return {
        ...state,
        tools: [...state.tools, { id, name, args: "", result: null, resultLine: null, status: "in_progress", removed: false }],
      };
    }
    case "TOOL_CALL_ARGS": {
      const patches = event.rawEvent?.patchs;
      if (!Array.isArray(patches) || patches.length === 0) return state;
      const index = findTool(state.tools, toolIdOf(event));
      if (index < 0) return state;
      const tool = state.tools[index];
      let args = tool.args;
      for (const patch of patches) {
        if (typeof patch?.path !== "string" || typeof patch.value !== "string") continue;
        const key = patch.path.replace(/^\//, "");
        if (!ARG_KEYS.has(key)) continue;
        if (args.length >= ARG_VALUE_MAX_CHARS) break;
        args += patch.value;
      }
      if (args === tool.args) return state;
      const tools = [...state.tools];
      tools[index] = { ...tool, args: args.slice(0, ARG_VALUE_MAX_CHARS) };
      return { ...state, tools };
    }
    case "TOOL_CALL_RESULT": {
      const index = findTool(state.tools, toolIdOf(event));
      if (index < 0) return state;
      const result = typeof event.content === "string"
        ? event.content.slice(0, TOOL_RESULT_MAX_CHARS)
        : "";
      const line = firstLineOf(result);
      if (line.length === 0) return state;
      const tools = [...state.tools];
      tools[index] = { ...tools[index], result, resultLine: line, status: "completed" };
      return { ...state, tools };
    }
    case "CUSTOM": {
      if (event.name !== "remove-tool" && event.rawEvent?.type !== "remove-tool") return state;
      const index = findTool(state.tools, event.rawEvent?.tool_call_id ?? null);
      if (index < 0) return state;
      const tools = [...state.tools];
      tools[index] = { ...tools[index], removed: true };
      return { ...state, tools };
    }
    case "TEXT_MESSAGE_CONTENT": {
      const delta = event.delta ?? event.rawEvent?.content ?? "";
      if (typeof delta !== "string" || delta.length === 0) return state;
      if (state.text.length >= TEXT_MAX_CHARS) return state;
      return { ...state, text: (state.text + delta).slice(0, TEXT_MAX_CHARS) };
    }
    case "STEP_FINISHED": {
      const total = event.rawEvent?.token_usage?.total_tokens;
      if (typeof total !== "number" || !Number.isFinite(total)) return state;
      return { ...state, tokens: state.tokens + total };
    }
    case "RUN_FINISHED":
      return { ...state, runFinished: true };
    default:
      return state;
  }
}

/** 增量更新子智能体状态（不修改 prev）。 */
export function updateSubagentState(prev, rawInput, snapshotText) {
  let state = mergeRawInput(prev ?? createSubagentState(), rawInput);

  const text = typeof snapshotText === "string" ? snapshotText : "";
  if (text.length === 0) return state;

  if (text.length < state.parsedOffset) {
    state = {
      ...state,
      parsedOffset: 0,
      tools: [],
      text: "",
      tokens: 0,
      runFinished: false,
    };
  }

  const chunk = text.slice(state.parsedOffset);
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) return state;

  for (const line of chunk.slice(0, lastNewline).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event == null || typeof event.type !== "string") continue;
    state = applyEvent(state, event);
  }

  return { ...state, parsedOffset: state.parsedOffset + lastNewline + 1 };
}

/** 1234 → 1.2k。 */
export function formatTokens(count) {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

export const SUBAGENT_MAX_TOOL_ROWS = 3;

/** 转成渲染用的展示模型。 */
export function subagentDisplay(state, maxRows = SUBAGENT_MAX_TOOL_ROWS) {
  if (state == null || typeof state !== "object") {
    return { rows: [], moreTools: 0, toolCount: 0, textLine: "", tokens: 0, runFinished: false };
  }
  const tools = Array.isArray(state.tools) ? state.tools.filter((tool) => !tool.removed) : [];
  const rows = tools
    .slice(0, maxRows)
    .map((tool) => (tool.args ? `${tool.name}(${tool.args})` : tool.name));
  return {
    rows,
    moreTools: Math.max(0, tools.length - maxRows),
    toolCount: tools.length,
    textLine: firstLineOf(state.text ?? ""),
    tokens: typeof state.tokens === "number" ? state.tokens : 0,
    runFinished: state.runFinished === true,
  };
}
