/**
 * 单回合工具结果的聚合预算。
 *
 * 动因：每个工具自己都有截断上限（read 512KB、grep/glob/terminal
 * 各 30k 字符），但那些上限是**逐条**的。模型一次并行读八个文件就能往同一条
 * assistant 消息后面灌进几 MB —— 一次请求把窗口打爆，而且这段历史留在上下文里，
 * 之后每一轮请求都要重新付一遍。
 *
 * 为什么不干脆把单条上限压得更低：那会把正常用量的小结果也一起切掉，而真正
 * 出问题的只是「同一回合里堆起来」的那部分。聚合预算只在总量真的超了才动手，
 * 单条上限保持原样。
 *
 * 被切掉的部分不丢：原文落盘到 ~/.miro/tool-results/，进历史的正文换成
 * 「预览 + 文件路径」的桩，模型需要细节时可以用 read_file 把整份读回来。
 * 落盘位置位于 ~/.miro 下，便于用户手动清理。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** 一回合所有工具结果进历史的字符总预算；约 30k token，够一次正常调研。 */
export const DEFAULT_TOOL_RESULT_BUDGET = 120_000;

/**
 * 每条被换桩的结果额外预留的字符数。
 *
 * 桩的正文是「预览 + 一句说明」，说明里还带着落盘路径，本身也占上下文。把这份
 * 开销先扣掉，「总量不超过预算」才是可证的性质而不是约等于。
 */
const STUB_OVERHEAD_RESERVE = 768;

/** 落盘根目录。与 ~/.miro/plans 同级，便于用户手动清理。 */
export function toolResultsDir(home = homedir()) {
  return path.join(home, ".miro", "tool-results");
}

/**
 * 单次调用的落盘路径。
 *
 * 目录名使用「可读标签 + cwd 摘要」：同一个工作区反复触发
 * 预算时产物聚在一处，用户认得出属于哪个项目；带上会话后缀则让不同会话的产物
 * 不至于互相覆盖。文件名里的 toolCallId 先清洗再截断——它由模型给出，可能带
 * 斜杠或超长；末尾的内容摘要避免 runAgentLoop 跨用户回合重置计数后覆盖旧结果。
 */
export function toolResultFilePath({
  cwd,
  sessionId = null,
  round = 0,
  index = 0,
  toolCallId = "",
  content = "",
  home = homedir(),
}) {
  const root = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const label = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, "_") || "workspace";
  const cleaned =
    sessionId == null ? "" : String(sessionId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const suffix = cleaned.length > 0 ? `-${cleaned}` : "";
  const safeId = String(toolCallId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "call";
  // round/index 会在每次 runAgentLoop（也就是每条用户输入）从零开始，缺失的
  // tool id 也会重复。把原文摘要纳入文件名后，不同结果永不覆盖；相同结果即使
  // 复用路径也保持内容一致，旧历史桩仍能正确读回。
  const contentDigest = createHash("sha256").update(String(content)).digest("hex");
  return path.join(
    toolResultsDir(home),
    `${label}-${digest}${suffix}`,
    `${round}-${index}-${safeId}-${contentDigest}.txt`,
  );
}

/**
 * 规划哪些结果需要换桩。纯函数，不碰磁盘。
 *
 * 分额按「条目数均分」而不是「先到先得」：工具结果长度方差极大（一个 read 可能
 * 100 字节，也可能是 512KB），先到先得会让第一条大结果吃掉全部预算，后面的即使
 * 加起来没多少也全被切成桩。均分下总量可证不超过预算，且每条受到的待遇与它在
 * 调用里的位置无关。
 *
 * 均分的代价是「小结果没花完的份额不会转给大结果」。这是刻意的：余量再分配要
 * 先知道全部长度，切点就会依赖同批里别的调用，同一段历史重放时更难复现。
 *
 * @returns {Array<{ entry: object, id: string, index: number, kept: string, droppedChars: number, full: string }>}
 */
export function planToolResultBudget(entries, { budget = DEFAULT_TOOL_RESULT_BUDGET } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return [];

  const contents = list.map((entry) => String(entry?.content ?? ""));
  const total = contents.reduce((sum, text) => sum + text.length, 0);
  if (total <= budget) return [];

  const share = Math.max(1, Math.floor(budget / list.length) - STUB_OVERHEAD_RESERVE);
  const stubbed = [];
  for (let position = 0; position < list.length; position += 1) {
    const full = contents[position];
    if (full.length <= share) continue;
    const entry = list[position];
    stubbed.push({
      entry,
      id: entry?.id ?? "",
      index: entry?.index ?? position,
      kept: full.slice(0, share),
      droppedChars: full.length - share,
      full,
    });
  }
  return stubbed;
}

/**
 * 换桩后的历史正文：保留开头一段预览，再说明剩下的去哪了。
 *
 * 结尾必须给出可执行的下一步。只写「输出被截断」会让模型以为信息不可得，于是
 * 把同一个调用原样再发一遍；写明落盘路径，它就能用 read_file 把整份读回来。
 */
export function buildToolResultStub({ preview, droppedChars, path: savedPath = null, error = null }) {
  const notice =
    savedPath != null
      ? `[miro] Output trimmed to keep this turn within the tool-result budget: ${droppedChars} more characters are saved at ${savedPath}. Use read_file on that path if you need the rest.`
      : `[miro] Output trimmed to keep this turn within the tool-result budget: ${droppedChars} more characters were dropped${error ? ` (could not save a copy: ${error})` : ""}. Re-run the call with a narrower scope if you need the rest.`;
  return `${preview}\n\n${notice}`;
}

/**
 * 把完整输出落盘。
 *
 * 失败不抛错而是返回 error：落盘失败不该让整轮对话崩掉——预算的目的是省上下文，
 * 为此把回合搞挂是净亏。调用方拿到 error 后降级成「丢弃」桩，信息丢了但对话还在。
 */
export async function persistToolResult({
  cwd,
  sessionId = null,
  round = 0,
  index = 0,
  toolCallId = "",
  content,
  home = homedir(),
}) {
  const file = toolResultFilePath({ cwd, sessionId, round, index, toolCallId, content, home });
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return { path: file };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/**
 * 施加单回合预算：超额的条目落盘，并原地把内容换成桩。
 *
 * @param {Array<{ id: string, index: number, content: string }>} entries 会被原地改写
 * @param {object} [options]
 * @param {number} [options.budget] 字符总预算；传 Infinity 可关掉
 * @param {Function} [options.store] 落盘实现，签名 ({ id, index, content }) => { path } | { error }
 * @returns {Promise<Array>} 被换桩的条目（供调用方观察/测试）
 */
export async function applyToolResultBudget(entries, { budget, store = persistToolResult } = {}) {
  const planned = planToolResultBudget(entries, { budget });
  for (const item of planned) {
    const saved = (await store({ id: item.id, index: item.index, content: item.full })) ?? {};
    item.entry.content = buildToolResultStub({
      preview: item.kept,
      droppedChars: item.droppedChars,
      path: typeof saved.path === "string" ? saved.path : null,
      error: saved.error ?? null,
    });
  }
  return planned;
}
