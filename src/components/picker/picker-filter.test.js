import assert from "node:assert/strict";
import test from "node:test";

import { filterItems, highlightSegments, matchIndices, searchableText } from "./picker-filter.js";

test("searchableText collects label, right, group, description and value", () => {
  const text = searchableText({
    label: "Sonnet",
    right: "balanced · 200k",
    groupName: "anthropic",
    description: "balanced",
    value: "claude-sonnet",
  });
  assert.match(text, /Sonnet/);
  assert.match(text, /balanced · 200k/);
  assert.match(text, /anthropic/);
  assert.match(text, /claude-sonnet/);
});

test("filterItems matches a title that only lives in the right column", () => {
  // Ctrl+O 列表把 title 放在右栏，只匹配 label 会让搜索框彻底失效。
  const items = [
    { value: 0, label: "1  Tool   ", right: "Edit(src/app.js)" },
    { value: 1, label: "2  Shell  ", right: "git status --short" },
  ];
  assert.deepEqual(filterItems(items, "edit").map((item) => item.value), [0]);
  assert.deepEqual(filterItems(items, "status").map((item) => item.value), [1]);
});

test("searchableText skips empty values without leaving stray space markers", () => {
  assert.equal(searchableText({ label: "Only", value: null }), "Only");
  assert.equal(searchableText({}), "");
  assert.equal(searchableText(null), "");
});

test("matchIndices returns subsequence hit offsets", () => {
  assert.deepEqual(matchIndices("Sonnet", "snt"), [0, 2, 5]);
  assert.deepEqual(matchIndices("Sonnet", ""), []);
});

test("matchIndices is case-insensitive and returns null when nothing matches", () => {
  assert.deepEqual(matchIndices("Sonnet", "SN"), [0, 2]);
  assert.equal(matchIndices("Sonnet", "xyz"), null);
  assert.equal(matchIndices("Sonnet", "tn"), null, "a wrong order must not match");
});

test("filterItems returns the same reference for an empty query", () => {
  const items = [{ value: "a" }, { value: "b" }];
  assert.equal(filterItems(items, ""), items);
  assert.equal(filterItems(items, "   "), items);
});

test("filterItems filters by subsequence and covers the group name", () => {
  const items = [
    { value: "opus", label: "Opus", groupName: "anthropic" },
    { value: "gpt", label: "GPT", groupName: "openai" },
  ];
  assert.deepEqual(
    filterItems(items, "anth").map((item) => item.value),
    ["opus"],
  );
  assert.deepEqual(filterItems(items, "zzz"), []);
});

test("filterItems sorts by match quality: consecutive hits rank before scattered hits", () => {
  const items = [
    { value: "hy3-dev0624", label: "hy3-dev0624" },
    { value: "hy4", label: "hy4" },
  ];
  // 输入 hy4：hy4 连续前缀命中得分远高于 hy3-dev0624 跳跃命中
  assert.deepEqual(
    filterItems(items, "hy4").map((item) => item.value),
    ["hy4", "hy3-dev0624"],
  );
});

test("filterItems tolerates non-array input", () => {
  assert.deepEqual(filterItems(null, "a"), []);
  assert.deepEqual(filterItems(undefined, ""), []);
});

test("highlightSegments splits hit characters into their own segments", () => {
  const segments = highlightSegments("Sonnet", "s");
  assert.deepEqual(segments, [
    { text: "S", hit: true },
    { text: "onnet", hit: false },
  ]);
});

test("highlightSegments merges adjacent characters sharing one hit state", () => {
  const segments = highlightSegments("Sonnet", "so");
  assert.deepEqual(segments, [
    { text: "So", hit: true },
    { text: "nnet", hit: false },
  ]);
});

test("highlightSegments returns one non-hit segment when there is no query or no match", () => {
  assert.deepEqual(highlightSegments("Sonnet", ""), [{ text: "Sonnet", hit: false }]);
  assert.deepEqual(highlightSegments("Sonnet", "xyz"), [{ text: "Sonnet", hit: false }]);
  assert.deepEqual(highlightSegments("", "a"), []);
});

test("highlightSegments rejoins into the original text without losing characters", () => {
  const source = "Claude Sonnet 4.5";
  const joined = highlightSegments(source, "cs45")
    .map((segment) => segment.text)
    .join("");
  assert.equal(joined, source);
});

test("highlightSegments does not split surrogate pairs", () => {
  const source = "hi 🙂 there";
  const segments = highlightSegments(source, "hi🙂");
  // 每一段都必须是完整码点，孤立代理在终端会显示成替换字符。
  for (const segment of segments) {
    assert.equal([...segment.text].join(""), segment.text);
    assert.doesNotMatch(segment.text, /[\uD800-\uDFFF]/u);
  }
  assert.equal(segments.map((segment) => segment.text).join(""), source);
});

test("highlightSegments keeps hit offsets unshifted after a surrogate pair", () => {
  const source = "🙂ab";
  assert.deepEqual(highlightSegments(source, "🙂b"), [
    { text: "🙂", hit: true },
    { text: "a", hit: false },
    { text: "b", hit: true },
  ]);
});
