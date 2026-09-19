import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { projectDirectoryName } from "./acp/session-recorder.js";

/**
 * 会话持久化：~/.miro/sessions/<cwd 拍平后的目录>/<acp|miro>/<sessionId>.jsonl
 * 首行 meta，其后追加 block 事件。ACP 原始流量另存于 acp/raw/，避免同一个
 * ACP sessionId 的两种 JSONL 在同一路径互相污染。
 *
 * 项目目录名仍复用 ACP recorder 的 projectDirectoryName，同一个 cwd 因而只需
 * 对应一个可读目录；第二层才区分 provider 路径。因此可见会话的身份是
 * (provider, sessionId) 而不是 sessionId —— 同一个 id 被另一个 provider 复用时
 * 两边是两份独立历史，读写都必须带上 provider。
 */

export const SESSIONS_DIR = path.join(os.homedir(), ".miro", "sessions");
const PROVIDER_DIRS = ["miro", "acp"];

function projectDir(cwd) {
  return path.join(SESSIONS_DIR, projectDirectoryName(cwd));
}

function providerDir(providerId) {
  return providerId === "miro" ? "miro" : "acp";
}

function safeSessionName(sessionId) {
  return `${String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`;
}

/**
 * 会话文件路径。刻意只算路径、不建目录：空对话连 sessions 目录都不该留下，
 * 建目录推迟到真正要写入时（见 SessionRecorder.ensureMeta）。
 */
function sessionPath(cwd, sessionId, providerId) {
  return path.join(projectDir(cwd), providerDir(providerId), safeSessionName(sessionId));
}

/**
 * 只有真正的对话内容才值得开一个会话文件。
 *
 * 标题、system / stderr / bashCard 块与 ui_state 都可能在一条消息都没发出去时到达
 * （provider 启动横幅、切模型、草稿 checkpoint），按它们建文件等于把「打开就退出」
 * 也记成一个会话，并因最新 mtime 抢走 /sessions 首位与无 id 的 --continue。
 */
function isConversationBlock(block) {
  if (block?.role !== "user" && block?.role !== "assistant") return false;
  return String(block.text ?? "").trim().length > 0;
}

/**
 * 首个对话块到达前允许攒在内存里的记录条数。
 *
 * model / ui_state 会按类型合并（各留最新一条），能撑起这个上限的只有 provider
 * 反复推的非对话块（例如持续刷 stderr）；攒的记录本来就是要丢的，截掉旧的即可。
 */
const MAX_DEFERRED_RECORDS = 256;

/** 从首条用户消息裁出标题。 */
function deriveTitle(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(empty)";
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizePastes(value) {
  const entries = value instanceof Map ? [...value] : value;
  if (!Array.isArray(entries)) return null;
  const normalized = [];
  const ids = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [id, text] = entry;
    if (!Number.isSafeInteger(id) || id <= 0 || typeof text !== "string" || ids.has(id)) return null;
    ids.add(id);
    normalized.push([id, text]);
  }
  return normalized;
}

function normalizeComposerSnapshot(snapshot) {
  if (!isObject(snapshot) || typeof snapshot.value !== "string") return null;
  const length = [...snapshot.value].length;
  if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0 || snapshot.cursor > length) return null;
  if (!Number.isSafeInteger(snapshot.nextPasteId) || snapshot.nextPasteId <= 0) return null;
  const pastes = normalizePastes(snapshot.pastes);
  if (!pastes) return null;
  const highestPasteId = Math.max(0, ...pastes.map(([id]) => id));
  if (snapshot.nextPasteId <= highestPasteId) return null;
  return {
    value: snapshot.value,
    cursor: snapshot.cursor,
    pastes,
    nextPasteId: snapshot.nextPasteId,
  };
}

function normalizeQueuedInputs(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.text !== "string") return null;
    if (item.display != null && typeof item.display !== "string") return null;
    normalized.push({ text: item.text, display: item.display ?? null });
  }
  return normalized;
}

function normalizeUiState(state) {
  if (!isObject(state)) return null;
  const composer = normalizeComposerSnapshot(state.composer);
  const queuedInputs = normalizeQueuedInputs(state.queuedInputs);
  if (!composer || !queuedInputs) return null;
  return { composer, queuedInputs };
}

/** goal_state 是 miro 的运行时快照；宽松读取旧版本，严格排除畸形对象。 */
function normalizeGoalState(state) {
  if (!isObject(state) || typeof state.goalId !== "string" || typeof state.objective !== "string") return null;
  if (state.objective.trim().length === 0 || typeof state.status !== "string") return null;
  const statuses = new Set(["pending", "active", "pausing", "paused", "blocked", "complete", "cancelled"]);
  if (!statuses.has(state.status)) return null;
  const nonNegative = (value) => Number.isFinite(value) && value >= 0;
  if (!nonNegative(state.turnsUsed) || !nonNegative(state.tokensUsed) || !nonNegative(state.wallClockMs)) return null;
  if (state.completionCriterion != null && typeof state.completionCriterion !== "string") return null;
  if (state.terminalReason != null && typeof state.terminalReason !== "string") return null;
  if (!isObject(state.budgetLimits)) return null;
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion ?? null,
    status: state.status,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs: state.wallClockMs,
    budgetLimits: { ...state.budgetLimits },
    terminalReason: state.terminalReason ?? null,
  };
}

/** 当前 block 记录的落盘版本；无 `v` 的记录是旧格式（全量字段）。 */
const SESSION_BLOCK_VERSION = 2;

/** 可见会话只持久化 thinking 摘要；原始内容仅在显式开启 raw ACP 记录时另存。 */
function persistedBlock(block) {
  if (block?.role === "thought" && block.thought) {
    return {
      ...block,
      thought: {
        title: block.thought.title ?? null,
        displayMode: block.thought.displayMode ?? null,
        durationMs: block.thought.durationMs ?? null,
        hasContent: Boolean(block.thought.hasContent || block.thought.text?.trim()),
      },
    };
  }
  if (block?.role !== "tool" || !isObject(block.tool)) return block;
  const tool = persistedTool(block.tool);
  return tool === block.tool ? block : { ...block, tool };
}

/** 两个 preview 是否逐行逐字相同（`more` 也算，它决定尾部还有多少行没显示）。 */
function samePreview(a, b) {
  return Boolean(
    isObject(a) && isObject(b) &&
    a.more === b.more &&
    Array.isArray(a.lines) && Array.isArray(b.lines) &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index])
  );
}

/** 从 detail.output 的头 `lines` 行重建 preview。 */
function rebuildPreview(output, lines) {
  const all = String(output ?? "").split("\n");
  return { lines: all.slice(0, lines), more: Math.max(0, all.length - lines) };
}

/**
 * 单工具项的字段清单，与 `store.js` `finalizeTool()` 的 item 一一对应。
 *
 * 单工具 block 的顶层字段就是这份 item 的拷贝（`toolFromGroup()`），唯一不在顶层
 * 的是 kind，因此读写两侧共用同一个构造：写侧靠它判断能否无损瘦身，读侧靠它把
 * 删掉的 reviewItems 拼回去。
 */
function singleToolItem(tool) {
  return {
    label: tool.label ?? null,
    kind: tool.kind ?? null,
    status: tool.status ?? null,
    elapsed: tool.elapsed ?? null,
    preview: tool.preview ?? null,
    command: tool.command ?? null,
    subagent: tool.subagent ?? null,
    detail: tool.detail ?? null,
    diff: tool.diff ?? null,
    autoReview: tool.autoReview ?? null,
  };
}

/**
 * 与键序无关的内容比较（undefined 与 null 仍然算不同，区分不出来就会误删还原不了的字段）。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * preview 能不能由 detail.output 推导：execute 类工具的预览与完整输出取自同一个
 * 文本，能推导就不必存第二份。逐行（含 more）比对，长行截断的 `…`、被
 * clippedDetail() 截断的尾部、\r\n 未归一化都会让两者不同，那时原样保留 preview。
 * @returns {number | null} 可推导时返回保留的行数
 */
function previewFromOutput(tool) {
  const preview = tool.preview;
  const output = tool.detail?.output;
  if (!isObject(preview) || !Array.isArray(preview.lines) || preview.lines.length === 0) return null;
  if (typeof output !== "string" || output.length === 0) return null;
  const lines = preview.lines.length;
  return samePreview(rebuildPreview(output, lines), preview) ? lines : null;
}

/**
 * tool block 的落盘形态。
 *
 * 内存里 reviewItems 是顶层字段的第二份（单工具时顶层就是 items[0] 的拷贝），
 * preview 又常常是 detail.output 的头几行，两份都在读侧可精确还原，于是落盘只留
 * 一份。只有能被逐字段还原时才瘦身：还原不出来的 block（例如将来 item 多了顶层
 * 没有的字段）整份照旧落下，读写往返因此始终一致。
 */
function persistedTool(tool) {
  const items = tool.reviewItems;
  if (!Array.isArray(items) || items.length === 0) return tool;

  if (tool.group != null) {
    // 多工具组：整份 items 已经在 group.items 里，reviewItems 只是同一份内容。
    if (!sameJson(items, tool.group.items)) return tool;
    const { reviewItems, ...rest } = tool;
    return rest;
  }

  if (items.length !== 1 || !isObject(items[0])) return tool;
  const item = items[0];
  const { reviewItems, ...rest } = tool;
  // kind 只存在于 item 上，补进顶层，读侧才能把 items[0] 原样拼回去。
  const candidate = { ...rest, kind: item.kind ?? null };
  if (!sameJson(singleToolItem(candidate), item)) return tool;

  const lines = previewFromOutput(candidate);
  if (lines == null) return candidate;
  const { preview, ...withoutPreview } = candidate;
  return { ...withoutPreview, previewFromOutput: lines };
}

/**
 * 把 v2 的精简 block 回填成内存形态；旧格式（无 `v`）的记录本来就带全量字段。
 *
 * 只碰 tool block：缺失的 reviewItems 从 group.items 或顶层字段重建，
 * previewFromOutput 再从 detail.output 切回 preview。
 */
function inflatePersistedBlock(entry) {
  const block = entry.block;
  if (!(entry.v >= SESSION_BLOCK_VERSION) || block?.role !== "tool" || !isObject(block.tool)) {
    return block;
  }
  const tool = { ...block.tool };
  // preview 先还原：单工具项的 preview 取自顶层，顺序反过来会回填成 null。
  if (Number.isInteger(tool.previewFromOutput) && tool.previewFromOutput >= 0) {
    tool.preview = rebuildPreview(tool.detail?.output, tool.previewFromOutput);
    delete tool.previewFromOutput;
  }
  if (!Array.isArray(tool.reviewItems)) {
    if (Array.isArray(tool.group?.items)) {
      tool.reviewItems = tool.group.items;
    } else {
      tool.reviewItems = [singleToolItem(tool)];
      // 顶层的 kind 只是为还原单工具项而落盘的，读回后归还给 item。
      delete tool.kind;
    }
  }
  return { ...block, tool };
}

/**
 * 会话写入句柄：记录 meta 并追加 block。
 *
 * 落盘是惰性的：首个对话块（或本来就存在的会话文件）之前，所有记录只攒在内存里，
 * 目录与文件都不创建 —— 空对话不该产生任何 sessions 存储。
 */
export class SessionRecorder {
  constructor({ sessionId, providerId, cwd = process.cwd(), model = null }) {
    this.sessionId = sessionId;
    this.providerId = providerId;
    this.cwd = cwd;
    this.file = sessionPath(cwd, sessionId, providerId);
    this.meta = {
      type: "meta",
      sessionId,
      providerId,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: null,
      model,
    };
    this.metaWritten = false;
    // 会话文件已经存在（恢复的会话）：它以前有过内容，后续记录照旧立刻落盘。
    this.established = existsSync(this.file);
    this.deferred = [];
    // 最近一条已经落盘的 ui_state 内容（不含时间戳），用于相邻去重。
    this.lastUiState = null;
  }

  ensureMeta() {
    if (this.metaWritten) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) appendFileSync(this.file, `${JSON.stringify(this.meta)}\n`, "utf8");
    this.metaWritten = true;
  }

  recordBlock(block) {
    if (!block || (block.role === "banner")) return;
    const entry = {
      type: "block",
      v: SESSION_BLOCK_VERSION,
      at: Date.now(),
      block: persistedBlock(block),
    };
    if (!isConversationBlock(block) && !this.opened()) {
      this.defer(entry.type, JSON.stringify(entry));
      return;
    }
    if (!this.open()) return;
    this.append(JSON.stringify(entry));
    if (block.role === "user" && this.meta.title == null) {
      this.meta.title = deriveTitle(block.text);
      this.append(JSON.stringify({ type: "title", at: Date.now(), title: this.meta.title }));
    }
  }

  recordModel(model) {
    if (model == null) return;
    // meta 里的模型名要先落定，攒着的那批记录补写时会连它一起带上。
    this.meta.model = model;
    this.writeEntry("model", JSON.stringify({ type: "model", at: Date.now(), model }));
  }

  /**
   * 草稿 checkpoint 的调用点很多（退出时的 effect cleanup 与 shutdown、/new、切
   * provider），内容相同的相邻快照只留一条。去重只认真正落盘的那一条，所以比较
   * 基准在 append() 里才推进：写失败时不能把没落盘的内容当成「上一条」。
   */
  recordUiState(state) {
    const normalized = normalizeUiState(state);
    if (!normalized) return;
    const payload = JSON.stringify(normalized);
    if (payload === this.lastUiState) return;
    this.writeEntry(
      "ui_state",
      JSON.stringify({ type: "ui_state", version: 1, at: Date.now(), state: normalized }),
      payload
    );
  }

  /** miro goal 每次状态变化时记一份；读取方只采用最后一个合法快照。 */
  recordGoalState(state) {
    if (state == null) {
      this.writeEntry("goal_state", JSON.stringify({ type: "goal_state", version: 1, at: Date.now(), state: null }));
      return;
    }
    const normalized = normalizeGoalState(state);
    if (!normalized) return;
    this.writeEntry(
      "goal_state",
      JSON.stringify({ type: "goal_state", version: 1, at: Date.now(), state: normalized })
    );
  }

  /** 会话文件是否已经开写：本进程内已建出，或恢复的会话原本就存在。 */
  opened() {
    return this.metaWritten || this.established;
  }

  /** 攒下一条在首个对话块之前到达的记录；会话文件已存在时照旧立刻落盘。 */
  writeEntry(type, line, dedupeKey = null) {
    if (!this.opened()) {
      // 攒着不比对：同类型（含 ui_state）在 defer() 里已经只留最新一条。
      this.defer(type, line, dedupeKey);
      return;
    }
    if (!this.open()) return;
    this.append(line, dedupeKey);
  }

  /**
   * model / ui_state 都是「最后一条生效」的覆盖式记录，只留最新一条就够。
   * 否则长时间空转（每次按键都 checkpoint 一次草稿）会把大段粘贴内容堆在内存里。
   */
  defer(type, line, dedupeKey = null) {
    const index = type === "block" ? -1 : this.deferred.findIndex((record) => record.type === type);
    if (index !== -1) this.deferred.splice(index, 1);
    this.deferred.push({ type, line, dedupeKey });
    if (this.deferred.length > MAX_DEFERRED_RECORDS) this.deferred.shift();
  }

  /** 建目录、写 meta，并把攒下的记录按原顺序补写。 */
  open() {
    try {
      this.ensureMeta();
      const pending = this.deferred.splice(0);
      for (const record of pending) this.append(record.line, record.dedupeKey);
      return true;
    } catch {
      return false;
    }
  }

  append(line, dedupeKey = null) {
    try {
      appendFileSync(this.file, `${line}\n`, "utf8");
      if (dedupeKey != null) this.lastUiState = dedupeKey;
    } catch {
      // ignore
    }
  }
}

/**
 * 单个可见会话文件的解析上限。
 *
 * 新布局已把 ACP 原始流量隔离到 acp/raw，但升级前的项目根目录仍可能有 GB 级
 * 流量日志。下面会整文件读入内存，撞上大文件时 readFileSync 抛 ENOMEM 只是
 * 运气好的那一半——连续读取可能被 OOM killer 直接终止。因此兼容扫描旧目录时
 * 仍须先按大小挡掉；正常 transcript 远小于此上限。
 */
const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;

/** 解析会话文件；损坏行跳过。 */
function parseSessionFile(file) {
  let meta = null;
  const blocks = [];
  let title = null;
  let model = null;
  let uiState = null;
  let goalState = null;
  let content;
  try {
    if (statSync(file).size > MAX_SESSION_FILE_BYTES) return null;
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type === "meta") meta = obj;
    else if (obj.type === "block" && obj.block) blocks.push(inflatePersistedBlock(obj));
    else if (obj.type === "title") title = obj.title;
    else if (obj.type === "model") model = obj.model;
    else if (obj.type === "ui_state" && obj.version === 1) {
      const normalized = normalizeUiState(obj.state);
      if (normalized) uiState = normalized;
    }
    else if (obj.type === "goal_state" && obj.version === 1) {
      if (obj.state === null) goalState = null;
      else {
        const normalized = normalizeGoalState(obj.state);
        if (normalized) goalState = normalized;
      }
    }
  }
  if (!meta) return null;
  if (title != null) meta.title = title;
  if (model != null) meta.model = model;
  return { meta, blocks, uiState, goalState };
}

function transcriptFiles(cwd) {
  const root = projectDir(cwd);
  if (!existsSync(root)) return [];
  const files = [];
  for (const dirName of PROVIDER_DIRS) {
    const dir = path.join(root, dirName);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".jsonl")) files.push({ file: path.join(dir, name), providerDir: dirName });
    }
  }
  return files;
}

/** 单个会话文件的摘要；解析失败（损坏或超限）返回 null。 */
function readSessionSummary(file) {
  const parsed = parseSessionFile(file);
  if (!parsed) return null;
  let mtime = parsed.meta.updatedAt ?? parsed.meta.createdAt ?? 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    // ignore
  }
  return {
    sessionId: parsed.meta.sessionId,
    providerId: parsed.meta.providerId ?? null,
    title: parsed.meta.title ?? "(untitled)",
    createdAt: parsed.meta.createdAt ?? mtime,
    updatedAt: mtime,
    model: parsed.meta.model ?? null,
    // 「消息」与惰性落盘用同一个判定：只有正文非空的 user / assistant 块才算一轮对话。
    messages: parsed.blocks.filter(isConversationBlock).length,
  };
}

/**
 * 列出某项目下的历史会话，按最近更新排序。
 *
 * 会话身份是 (provider, sessionId)：同一个 sessionId 被另一个 provider 复用时，
 * 两边是两份独立历史，按 id 去重会让其中一份从列表里消失、恢复时又读到别人的
 * transcript。
 *
 * 零消息（没有任何正文 user / assistant 块）的 transcript 一律不列出：它们是惰性
 * 落盘之前留下的空会话或草稿会话，列出来只会顶掉真正可以恢复的那一条。
 */
export function listSessions(cwd = process.cwd(), providerId = null) {
  const byProvider = new Map();
  for (const { file, providerDir: dirName } of transcriptFiles(cwd)) {
    const summary = readSessionSummary(file);
    if (!summary) continue;
    // 零消息的 transcript（惰性落盘之前的老文件、手改坏的文件）不是会话：
    // 列出来只会以 (untitled) / 0 msgs 抢走 /resume 首位与无 id 的 --continue。
    if (summary.messages === 0) continue;
    // miro 目录只由 miro client 写入，恢复时必然回到 miro；acp 目录可能是
    // 任意 ACP provider，只有 meta 里的 providerId 才知道该交给谁 session/load。
    const providerId = dirName === "miro" ? "miro" : summary.providerId;
    const item = { ...summary, providerId };
    const key = `${providerId}:${item.sessionId}`;
    const previous = byProvider.get(key);
    if (!previous || item.updatedAt > previous.updatedAt) byProvider.set(key, item);
  }
  const sessions = [...byProvider.values()];
  return sessions
    .filter((item) => providerId == null || item.providerId === providerId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 加载指定会话的 transcript 及最近一次合法 UI 状态。
 *
 * 已知自己是哪个 provider 的调用方要把它传进来：同一个 sessionId 可能在两个
 * provider 目录下各有一份，固定顺序（miro → acp）会把 ACP 会话的历史读成
 * miro 那份。
 */
export function loadSessionBlocks(sessionId, cwd = process.cwd(), providerId = null) {
  const name = safeSessionName(sessionId);
  const root = projectDir(cwd);
  const own = providerId == null ? null : providerDir(providerId);
  const order = own == null ? PROVIDER_DIRS : [own, ...PROVIDER_DIRS.filter((dirName) => dirName !== own)];
  const candidates = order.map((dirName) => path.join(root, dirName, name));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseSessionFile(file);
    if (parsed) return { meta: parsed.meta, blocks: parsed.blocks, uiState: parsed.uiState, goalState: parsed.goalState };
  }
  return null;
}

/** 最近一次会话的 sessionId。 */
export function latestSessionId(cwd = process.cwd(), providerId = null) {
  const sessions = listSessions(cwd, providerId);
  return sessions.length > 0 ? sessions[0].sessionId : null;
}
