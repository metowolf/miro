import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSessionTokenUsage,
  formatTokens,
  parseStatusLineItems,
  resolveStatusLineItem,
} from "./items.js";

test("resolveStatusLineItem accepts legacy aliases", () => {
  assert.equal(resolveStatusLineItem("model-name"), "model");
  assert.equal(resolveStatusLineItem("project"), "project-name");
  assert.equal(resolveStatusLineItem("project-root"), "project-name");
  assert.equal(resolveStatusLineItem("context-usage"), "context-used");
  assert.equal(resolveStatusLineItem("status"), "run-state");
  assert.equal(resolveStatusLineItem("thread-id"), "session-id");
  assert.equal(resolveStatusLineItem("thread-title"), "session-title");
  assert.equal(resolveStatusLineItem("version"), "miro-version");
});

test("resolveStatusLineItem returns null for unknown and unsupported entries", () => {
  assert.equal(resolveStatusLineItem("five-hour-limit"), null);
  assert.equal(resolveStatusLineItem("weekly-limit"), null);
  assert.equal(resolveStatusLineItem("thread-credits"), null);
  assert.equal(resolveStatusLineItem("approval-mode"), null);
  assert.equal(resolveStatusLineItem(""), null);
  assert.equal(resolveStatusLineItem(42), null);
});

test("parseStatusLineItems separates valid from invalid entries, keeping order and deduping", () => {
  const { items, invalid } = parseStatusLineItems([
    "model-with-reasoning",
    "current-dir",
    "five-hour-limit",
    "weekly-limit",
    "task-progress",
    "model-name",
    "model",
  ]);
  assert.deepEqual(items, ["model-with-reasoning", "current-dir", "task-progress", "model"]);
  assert.deepEqual(invalid, ["five-hour-limit", "weekly-limit"]);
});

test("parseStatusLineItems returns an empty result for non-array input", () => {
  assert.deepEqual(parseStatusLineItems(undefined), { items: [], invalid: [] });
  assert.deepEqual(parseStatusLineItems("model"), { items: [], invalid: [] });
});

test("formatSessionTokenUsage prints the compact Stat line with cache read/write, hit rate and cost", () => {
  assert.equal(
    formatSessionTokenUsage(
      {
        total: 94_800,
        input: 12_400,
        output: 2_100,
        cacheRead: 84_300,
        cacheWrite: 6_200,
        thought: 45,
      },
      { amount: 0.002, currency: "USD" },
    ),
    "Stat ↑12.4k ↓2.1k  R84.3k W6.2k CH81.9%  $0.002"
  );
  // 未上报的一侧省略；已上报的 0 仍然印出。
  assert.equal(formatSessionTokenUsage({ total: 500, input: 500, output: 0 }), "Stat ↑500 ↓0");
  assert.equal(formatSessionTokenUsage({ output: 12 }), "Stat ↓12");
  // 缓存出现读数后固定写成 R读/W写，缺失的一侧补 0；命中率的分母是未命中输入 +
  // 命中 + 写入（900 / 1900）。
  assert.equal(
    formatSessionTokenUsage({ input: 1_000, output: 500, cacheRead: 900 }),
    "Stat ↑1k ↓500  R900 W0 CH47.4%"
  );
  assert.equal(
    formatSessionTokenUsage({ input: 1_000, output: 500, cacheRead: 900, cacheWrite: 0 }),
    "Stat ↑1k ↓500  R900 W0 CH47.4%"
  );
  // 两个方向的缓存都是 0（或未上报）时不占位置，命中率也不印（0/0 没有意义）。
  assert.equal(
    formatSessionTokenUsage({ input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 }),
    "Stat ↑1k ↓500"
  );
  // 只有缓存读数时同样保留这一行。
  assert.equal(formatSessionTokenUsage({ total: 1_000, cacheRead: 900 }), "Stat R900 W0 CH100.0%");
  // 一项可印的读数都没有时返回 null，调用方整行跳过，不留占位文案。
  assert.equal(formatSessionTokenUsage(null), null);
  assert.equal(formatSessionTokenUsage({ total: 1_000, thought: 20 }), null);
});

test("formatSessionTokenUsage renders the session cost, keeping more decimals for small amounts", () => {
  // 只有成本读数时也印整行：ACP 的 usage_update 可能先于 token 读数到达。
  assert.equal(formatSessionTokenUsage(null, { amount: 0.002, currency: "USD" }), "Stat $0.002");
  assert.equal(formatSessionTokenUsage(undefined, { amount: 1.5, currency: "USD" }), "Stat $1.50");
  // 比临界值更小的真实读数多留一位，不能四舍五入成看起来像零的 $0.000。
  assert.equal(formatSessionTokenUsage(null, { amount: 0.0004, currency: "USD" }), "Stat $0.0004");
  // 非 USD 货币带上 ISO 代码。
  assert.equal(formatSessionTokenUsage(null, { amount: 0.5, currency: "EUR" }), "Stat 0.500 EUR");
  // 未上报、0 与非法值都不占位置（0 成本当成没有读数，否则每个会话都要印 $0.000）。
  assert.equal(formatSessionTokenUsage(null, null), null);
  assert.equal(formatSessionTokenUsage(null, { amount: 0, currency: "USD" }), null);
  assert.equal(formatSessionTokenUsage(null, { amount: Number.NaN }), null);
});

test("formatTokens formats compactly and returns null for non-positive values", () => {
  assert.equal(formatTokens(0), null);
  assert.equal(formatTokens(-1), null);
  assert.equal(formatTokens(null), null);
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(1_234_567), "1.2M");
});
