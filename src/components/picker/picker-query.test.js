import assert from "node:assert/strict";
import test from "node:test";

import { applyFileSuggestion, extractAtToken, fileSuggestionKey } from "../../file-suggestions.js";
import { createPickerRequest, pickerQueryState } from "./picker-query.js";

const items = [
  { path: "src/acp", isDirectory: true },
  { path: "src/components", isDirectory: true },
];

test("新目录查询等待期间不能连续 Tab 选中旧目录的第一项", () => {
  const value = "@src/";
  const token = extractAtToken(value, value.length);
  const result = { key: fileSuggestionKey(token), items };
  assert.deepEqual(pickerQueryState(result, result.key), { items, pending: false });

  const next = applyFileSuggestion([...value], token, items[1]);
  const nextValue = next.nextChars.join("");
  const nextToken = extractAtToken(nextValue, nextValue.length);
  assert.equal(nextValue, "@src/components/");
  assert.deepEqual(pickerQueryState(result, fileSuggestionKey(nextToken)), {
    items: [], pending: true,
  });
});

test("相同路径的不同位置或引用形式不能复用旧结果", () => {
  const value = "@src/";
  const result = { key: fileSuggestionKey(extractAtToken(value, value.length)), items };
  for (const next of ["看一下 @src/", '@"src/"']) {
    const cursor = next.endsWith('"') ? next.length - 1 : next.length;
    const token = extractAtToken(next, cursor);
    assert.equal(pickerQueryState(result, fileSuggestionKey(token)).pending, true);
  }
});

test("关闭补全不算等待，空结果与尚未返回的结果有区别", () => {
  assert.deepEqual(pickerQueryState({ key: "old", items }, null), { items: [], pending: false });
  assert.deepEqual(pickerQueryState(null, "new"), { items: [], pending: true });
  assert.deepEqual(pickerQueryState({ key: "new", items: [] }, "new"), { items: [], pending: false });
  assert.equal(fileSuggestionKey(null), null);
});

test("乱序返回和关闭后返回的请求都不能发布过期候选", () => {
  let result = null;
  const publish = (next) => { result = next; };
  const old = createPickerRequest("old", publish);
  old.cancel();
  const current = createPickerRequest("new", publish);
  current.resolve(items);
  old.resolve([]);
  assert.deepEqual(result, { key: "new", items });
  current.cancel();
  result = null;
  current.resolve(items);
  assert.equal(result, null);
});

test("清空再输入同一查询时，第一轮请求仍然失效", () => {
  let result = null;
  const publish = (next) => { result = next; };
  const first = createPickerRequest("same", publish);
  first.cancel();
  const second = createPickerRequest("same", publish);
  first.resolve(items);
  assert.equal(result, null);
  second.resolve([]);
  assert.deepEqual(result, { key: "same", items: [] });
});
