import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_HIGH_WATER_RATIO,
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummaryRequest,
  createSummaryMessage,
  dropCompactionNotices,
  formatCompactionNotice,
  isCompactionNotice,
  findCutPoint,
  isContextOverflowError,
  isSummaryMessage,
  isValidCutPoint,
  mergeChunkSummaries,
  messageText,
  planCompaction,
  planSummaryChunks,
  splitForCompaction,
  summaryTextOf,
  validateCompactionAdmission,
  validateSummaryResult,
  validCutPoints,
} from "./compaction.js";

// 注入「字符数即 token 数」，断言才能精确到某一条消息算没算进去。
const chars = (text) => text.length;

const validSummary = [
  "## Goal", "Ship it", "## Constraints & Preferences", "- Safe",
  "## Progress", "### Done", "- [x] Read", "### In Progress", "- [ ] Edit",
  "### Blocked", "- None", "## Key Decisions", "- Keep compatibility",
  "## Next Steps", "1. Test", "## Critical Context", "- src/app.js",
].join("\n");

test("validateSummaryResult rejects incomplete responses before history replacement", () => {
  assert.deepEqual(validateSummaryResult({ text: validSummary, finishReason: "length" }), {
    ok: false,
    reason: "summary_incomplete",
  });
  assert.deepEqual(validateSummaryResult({ text: validSummary, finishReason: "stop", cancelled: true }), {
    ok: false,
    reason: "summary_cancelled",
  });
  assert.deepEqual(validateSummaryResult({
    text: validSummary,
    finishReason: "stop",
    calls: [{ name: "read_file" }],
  }), { ok: false, reason: "summary_tool_call" });
  assert.deepEqual(validateSummaryResult({ text: "", finishReason: "stop" }), {
    ok: false,
    reason: "empty_summary",
  });
});

test("validateSummaryResult distinguishes exact templates from usable fallback prose", () => {
  assert.equal(validateSummaryResult({ text: validSummary, finishReason: "end_turn" }).schemaStatus, "exact");
  assert.equal(validateSummaryResult({ text: validSummary, finishReason: "completed" }).schemaStatus, "exact");
  assert.deepEqual(validateSummaryResult({ text: "Useful compact summary", finishReason: "stop" }), {
    ok: true,
    text: "Useful compact summary",
    schemaStatus: "soft_fallback",
  });
});

test("validateCompactionAdmission requires a smaller history below the high water mark", () => {
  assert.deepEqual(validateCompactionAdmission({ before: 900, after: 700, highWater: 800 }), { ok: true });
  assert.equal(validateCompactionAdmission({ before: 900, after: 850, highWater: 800 }).ok, false);
  assert.equal(validateCompactionAdmission({ before: 900, after: 900, highWater: 1000 }).ok, false);
});

test("planCompaction uses the ratio for the high water mark and always passes manual triggers", () => {
  const window = 1000;
  const high = window * COMPACTION_HIGH_WATER_RATIO;

  assert.equal(planCompaction({ used: high - 1, contextWindow: window }).compact, false);
  assert.equal(planCompaction({ used: high, contextWindow: window }).compact, true);
  assert.equal(planCompaction({ used: high, contextWindow: window }).reason, "threshold");

  // 手动 /compact 不看水位。
  const manual = planCompaction({ used: 0, contextWindow: window, trigger: "manual" });
  assert.equal(manual.compact, true);
  assert.equal(manual.reason, "manual");
});

test("planCompaction does not compact when disabled or the window is unknown", () => {
  assert.equal(planCompaction({ used: 999, contextWindow: 1000, enabled: false }).reason, "disabled");
  assert.equal(planCompaction({ used: 999, contextWindow: 0 }).reason, "unknown_window");
  // 窗口未知时连手动也不该压：算不出预算，摘要请求无从构造。
  assert.equal(planCompaction({ contextWindow: 0, trigger: "manual" }).compact, false);
});

test("planCompaction derives each budget from the window ratio", () => {
  const plan = planCompaction({ used: 0, contextWindow: 1000 });
  assert.equal(plan.highWater, 800);
  assert.equal(plan.targetTokens, 100);
  assert.equal(plan.keepRecentTokens, 200);
  assert.equal(plan.reserveTokens, 150);
});

test("messageText counts tool_calls arguments and reasoning too", () => {
  const message = {
    role: "assistant",
    content: "hi",
    reasoning_content: "think",
    tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.js"}' } }],
  };
  const text = messageText(message);
  assert.ok(text.includes("hi"));
  assert.ok(text.includes("think"));
  assert.ok(text.includes("read_file"));
  assert.ok(text.includes("a.js"));

  // 数组形态的 content（Anthropic 风格）也要能取到文本。
  assert.equal(messageText({ role: "user", content: [{ type: "text", text: "abc" }] }), "abc");
  assert.equal(messageText({ role: "user" }), "");
});

test("isValidCutPoint refuses to split a tool_call from its response", () => {
  const messages = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "grep", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "result" },
    { role: "assistant", content: "done" },
    { role: "user", content: "u2" },
  ];

  // 0 永远不是切点：切在这里等于什么都没压。
  assert.equal(isValidCutPoint(messages, 0), false);
  // 带 tool_calls 的 assistant 不可切，否则前面的 tool 应答成了无主消息。
  assert.equal(isValidCutPoint(messages, 1), false);
  // tool 消息不可切，否则它的 tool_call 声明被留在了前一段。
  assert.equal(isValidCutPoint(messages, 2), false);
  // 纯文本 assistant 可切。
  assert.equal(isValidCutPoint(messages, 3), true);
  assert.equal(isValidCutPoint(messages, 4), true);

  assert.deepEqual(validCutPoints(messages), [3, 4]);
});

test("isValidCutPoint rejects cutting at a system reminder", () => {
  const messages = [
    { role: "user", content: "u1" },
    { role: "system", content: "plan reminder" },
    { role: "assistant", content: "ok" },
  ];
  // system 是环境状态，由 agent-loop 自行增删，压缩不该搬动它。
  assert.equal(isValidCutPoint(messages, 1), false);
  assert.equal(isValidCutPoint(messages, 2), true);
});

test("findCutPoint keeps a tail that fits the budget and snaps to a valid cut point", () => {
  const messages = [
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "c".repeat(100) },
    { role: "assistant", content: "d".repeat(100) },
  ];

  // 预算 100：从尾部累加，第 3 条就够了。
  assert.equal(findCutPoint(messages, 100, chars), 3);
  // 预算 250：要累到第 1 条才够 300。
  assert.equal(findCutPoint(messages, 250, chars), 1);
});

test("findCutPoint snaps forward over a long tool chain instead of growing the retained tail", () => {
  const messages = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "g", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "x".repeat(400) },
    { role: "assistant", content: "done" },
  ];
  // 尾部累加会停在下标 2（tool 消息），但那里不能切。向后吸附到 3，
  // 宁可少保留也不能把保留区撑爆 —— 向前吸附会切到 1，孤儿 tool_call。
  assert.equal(findCutPoint(messages, 100, chars), 3);
});

test("findCutPoint returns 0 when there is no valid cut point", () => {
  const messages = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "g", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "r" },
  ];
  // 整段都在一个未闭合的工具回合里，切不了。
  assert.equal(findCutPoint(messages, 10, chars), 0);
});

test("splitForCompaction separates the section to summarize and keeps system notices as-is", () => {
  const messages = [
    { role: "user", content: "a".repeat(100) },
    { role: "system", content: "plan reminder" },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "c".repeat(100) },
  ];

  const split = splitForCompaction(messages, 100, chars);
  assert.equal(split.cutIndex, 3);
  // system 提醒不进摘要，单独带出来由调用方重新注入。
  assert.deepEqual(split.systemNotices.map((m) => m.content), ["plan reminder"]);
  assert.deepEqual(split.toSummarize.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(split.retained.map((m) => m.role), ["user"]);
});

test("splitForCompaction extracts the previous summary and never compacts it again", () => {
  const messages = [
    createSummaryMessage("earlier summary"),
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "c".repeat(100) },
  ];

  const split = splitForCompaction(messages, 100, chars);
  assert.equal(split.previousSummary, "earlier summary");
  // 摘要消息既不在待摘要段（会被二次压缩），也不在 systemNotices（会重复注入）。
  assert.ok(!split.toSummarize.some(isSummaryMessage));
  assert.ok(!split.systemNotices.some(isSummaryMessage));
});

test("splitForCompaction leaves history unchanged when there is nothing to compact", () => {
  const messages = [{ role: "user", content: "only one" }];
  const split = splitForCompaction(messages, 100, chars);
  assert.equal(split.cutIndex, 0);
  assert.equal(split.toSummarize.length, 0);
  assert.deepEqual(split.retained, messages);
});

test("summary message round-trips back to its raw body", () => {
  const message = createSummaryMessage("## Goal\ndo the thing");
  assert.equal(isSummaryMessage(message), true);
  assert.equal(summaryTextOf(message), "## Goal\ndo the thing");
  // 普通 system 消息不会被误认。
  assert.equal(summaryTextOf({ role: "system", content: "plan reminder" }), null);
});

test("buildSummaryRequest uses the creation prompt first and the update prompt with a previous summary", () => {
  const toSummarize = [{ role: "user", content: "hello" }];

  const first = buildSummaryRequest({ toSummarize });
  assert.equal(first[0].role, "system");
  assert.ok(first[1].content.includes("<conversation>"));
  assert.ok(first[1].content.includes("hello"));
  assert.ok(first[1].content.includes(SUMMARIZATION_PROMPT));
  assert.ok(!first[1].content.includes("<previous-summary>"));

  const update = buildSummaryRequest({ toSummarize, previousSummary: "old" });
  assert.ok(update[1].content.includes("<previous-summary>"));
  assert.ok(update[1].content.includes("old"));
  assert.ok(update[1].content.includes(UPDATE_SUMMARIZATION_PROMPT));
});

test("planSummaryChunks splits only when over budget", () => {
  const messages = [
    { role: "user", content: "a".repeat(50) },
    { role: "assistant", content: "b".repeat(50) },
    { role: "user", content: "c".repeat(50) },
  ];

  // 装得下就是一块，行为与不分块一致。
  assert.equal(planSummaryChunks(messages, 1000, chars).length, 1);
  // 预算 100：每块最多两条。
  const chunks = planSummaryChunks(messages, 100, chars);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [2, 1]);
  // 单条就超预算时独占一块，而不是被丢掉。
  const huge = [{ role: "user", content: "x".repeat(500) }, { role: "user", content: "y" }];
  assert.deepEqual(planSummaryChunks(huge, 100, chars).map((c) => c.length), [1, 1]);
  assert.deepEqual(planSummaryChunks([], 100, chars), []);
});

test("mergeChunkSummaries adds no heading for one chunk and numbers multiple chunks", () => {
  assert.equal(mergeChunkSummaries(["only"]), "only");
  assert.equal(mergeChunkSummaries([]), "");
  // 空块被忽略：某一块摘要失败不该在结果里留下一个空标题。
  assert.equal(mergeChunkSummaries(["  ", "real"]), "real");

  const merged = mergeChunkSummaries(["one", "two"]);
  assert.ok(merged.includes("### Part 1 of 2"));
  assert.ok(merged.includes("### Part 2 of 2"));
});

test("isContextOverflowError recognizes each vendor's context overflow wording", () => {
  assert.equal(isContextOverflowError({ code: "context_length_exceeded" }), true);
  assert.equal(isContextOverflowError(new Error("maximum context length is 8192 tokens")), true);
  assert.equal(isContextOverflowError(new Error("Your input exceeds the context window of this model.")), true);
  assert.equal(isContextOverflowError(new Error("prompt is too long: 300000 tokens")), true);
  assert.equal(isContextOverflowError(new Error("Please reduce the length of the messages")), true);

  // 别的失败不能被误判成超窗，否则会把限流变成一次无谓的压缩。
  assert.equal(isContextOverflowError(new Error("rate limit reached")), false);
  assert.equal(isContextOverflowError(new Error("invalid api key")), false);
  assert.equal(isContextOverflowError(null), false);
});

test("formatCompactionNotice carries the water mark and can be detected and dropped", () => {
  const notice = formatCompactionNotice({ before: 120_432, after: 14_210 });
  assert.match(notice, /Context compacted: 120k → 14k tokens/);
  const message = { role: "system", content: notice };
  assert.equal(isCompactionNotice(message), true);
  assert.equal(isCompactionNotice({ role: "system", content: "plan reminder" }), false);

  const messages = [
    { role: "user", content: "hi" },
    message,
    { role: "assistant", content: "ok" },
    { role: "system", content: notice },
  ];
  dropCompactionNotices(messages);
  assert.deepEqual(messages.map((item) => item.role), ["user", "assistant"]);
});

test("splitForCompaction does not carry a stale compaction notice into the retained tail", () => {
  const notice = formatCompactionNotice({ before: 900, after: 200 });
  const messages = [
    { role: "user", content: "a".repeat(100) },
    { role: "system", content: notice },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "c".repeat(100) },
  ];
  const split = splitForCompaction(messages, 100, chars);
  assert.deepEqual(split.systemNotices, []);
  assert.ok(!split.toSummarize.some((message) => isCompactionNotice(message)));
});
