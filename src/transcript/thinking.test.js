import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceThinking,
  estimateThoughtOutputTokens,
  matchThinkingDisplayMode,
  normalizeThinkingDisplayMode,
  sampleThoughtTokens,
  splitThinkingText,
  thinkingElapsed,
  thinkingPreview,
  thoughtStatBucket,
  thoughtSummaryText,
} from "./thinking.js";

test("thinking display mode is tolerant for settings and strict for commands", () => {
  assert.equal(normalizeThinkingDisplayMode("FULL"), "full");
  assert.equal(normalizeThinkingDisplayMode("broken"), "compact");
  assert.equal(matchThinkingDisplayMode("Hidden")?.value, "hidden");
  assert.equal(matchThinkingDisplayMode("broken"), null);
});

test("splitThinkingText extracts a complete leading bold title", () => {
  assert.deepEqual(splitThinkingText("**Inspecting reducer**\n\nFirst\nSecond"), {
    title: "Inspecting reducer",
    body: "First\nSecond",
  });
  assert.equal(splitThinkingText("**still streaming").title, null);
});

test("thinkingPreview budgets physical rows and counts CJK width", () => {
  assert.deepEqual(
    thinkingPreview("一二三四五六七八", 4, 3),
    ["… 2 earlier rows", "五六", "七八"]
  );
  assert.deepEqual(
    thinkingPreview("**Title**\n\none\ntwo", 20, 3),
    ["one", "two"]
  );
});

test("thinkingElapsed excludes completed and active pauses", () => {
  assert.equal(thinkingElapsed({ startedAt: 1000, pausedMs: 1500 }, 5000), 2500);
  assert.equal(thinkingElapsed({ startedAt: 1000, pausedMs: 500, pausedAt: 3000 }, 5000), 1500);
});

test("advanceThinking only credits gaps that still look like thinking", () => {
  assert.deepEqual(advanceThinking({ startedAt: 1000, activeAt: 1000, activeMs: 0 }, 1400), {
    activeAt: 1400,
    activeMs: 400,
  });
  // 隔了 30s 才来的下一片：那是请求等待（重发 / 写工具参数），只补一个上限间隔。
  assert.deepEqual(advanceThinking({ startedAt: 1000, activeAt: 2000, activeMs: 1000 }, 32_000), {
    activeAt: 32_000,
    activeMs: 2000,
  });
  // 首片之前没有上一片可依，从 startedAt 起算，同样受上限约束。
  assert.deepEqual(advanceThinking({ startedAt: 1000, activeMs: 0 }, 60_000), {
    activeAt: 60_000,
    activeMs: 1000,
  });
});

test("thinkingElapsed stops counting once thinking stops flowing", () => {
  // 想完 2s 后又等了 28s 才定稿：耗时是「流动 3s + 一个上限间隔」，不是 30s。
  const thought = { startedAt: 1000, activeAt: 4000, activeMs: 3000 };
  assert.equal(thinkingElapsed(thought, 5000), 4000);
  assert.equal(thinkingElapsed(thought, 30_000), 4000);
  // 伪工具「规划中」撑起的 thought 没有片段流过，它的存活期本身就是「在想」。
  assert.equal(thinkingElapsed({ startedAt: 1000, activeMs: 0 }, 30_000), 29_000);
});

test("thoughtSummaryText drops the whole duration stamp when there is none", () => {
  const titled = { title: "Inspecting", text: "**Inspecting**\n\nbody" };
  assert.equal(thoughtSummaryText(titled, "3s"), "Thought: Inspecting · 3s");
  // formatDuration 不足 1 秒时返回 null：此时连分隔符一起省掉，不能留下 " · null"。
  assert.equal(thoughtSummaryText(titled, null), "Thought: Inspecting");
  assert.equal(thoughtSummaryText({ text: "body" }, null), "Thought");
});

test("thoughtStatBucket groups animation ticks into sampling buckets", () => {
  // 5 tick 一个桶：前五个 tick 读到的都是同一个读数，第六个才换来新的。
  assert.deepEqual(
    [0, 1, 4, 5, 9, 10].map((tick) => thoughtStatBucket(tick, 5)),
    [0, 0, 0, 1, 1, 2]
  );
  // 时钟没跑起来（或传入脏值）时退化为「每个 tick 一桶」，不会算出 NaN 桶。
  assert.equal(thoughtStatBucket(3), 3);
  assert.equal(thoughtStatBucket(undefined, undefined), 0);
  assert.equal(thoughtStatBucket(-2, 0), 0);
});

test("sampleThoughtTokens reuses the reading inside one bucket", () => {
  const first = sampleThoughtTokens(null, "a".repeat(40), 0);
  assert.equal(first.tokens, 10);

  // 同一个桶里正文又长了：沿用上一次读数，渲染结果因此逐字不变。
  const sameBucket = sampleThoughtTokens(first, "a".repeat(400), 0);
  assert.equal(sameBucket, first);

  // 跨桶才重算。
  const nextBucket = sampleThoughtTokens(sameBucket, "a".repeat(400), 1);
  assert.equal(nextBucket.tokens, 100);
  assert.equal(nextBucket.bucket, 1);

  // 换了一段思考：正文不是上一条的续写，立即重算，不能先印上一段的数字。
  const restart = sampleThoughtTokens(nextBucket, "b".repeat(400), 1);
  assert.equal(restart.tokens, 100);
  assert.equal(restart.text, "b".repeat(400));
  // 被 50KB 上限截断后正文不再是续写，同样立即重算。
  const truncated = sampleThoughtTokens(restart, `x${restart.text}`, 1);
  assert.equal(truncated.text, `x${restart.text}`);
});

test("estimateThoughtOutputTokens counts CJK per cell, not per code unit", () => {
  assert.equal(estimateThoughtOutputTokens(""), 0);
  assert.equal(estimateThoughtOutputTokens("a".repeat(40)), 10);
  assert.equal(estimateThoughtOutputTokens("中".repeat(40)), 40);
});
