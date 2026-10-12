import assert from "node:assert/strict";
import test from "node:test";
import { isVisibleTool, toolForDisplay } from "./tool-display.ts";

const read = (path: string) => ({ label: { name: "Read", args: `${path}:1` }, kind: "read", status: "completed" });
const codemode = { label: { name: "Codemode", args: "" }, kind: "codemode", status: "completed" };

test("工具组隐藏 codemode 包装层并重算可见计数，不改原始审计", () => {
  const items = [read("pi.txt"), read("pi_cpp.txt"), codemode];
  const tool = {
    group: { name: "3 tool calls", summary: "2 reads · 1 codemodes", count: 3, items },
    status: "completed", elapsed: 1200, reviewItems: items,
  };
  const before = structuredClone(tool);
  const visible = toolForDisplay(tool);
  assert.equal(visible.group.name, "2 tool calls");
  assert.equal(visible.group.summary, "2 reads");
  assert.equal(visible.group.count, 2);
  assert.deepEqual(visible.group.items, items.slice(0, 2));
  assert.strictEqual(visible.reviewItems, items);
  assert.equal(visible.elapsed, 1200);
  assert.deepEqual(tool, before);
});

test("活动工具、单项定稿与旧会话都隐藏 codemode，实际内部工具仍可见", () => {
  for (const tool of [
    { raw: { name: "codemode" } }, { raw: { kind: "codemode" } },
    { name: "codemode" }, { kind: "codemode" }, { label: { name: "Codemode" } },
  ]) {
    assert.equal(isVisibleTool(tool), false);
    assert.equal(toolForDisplay(tool), null);
  }
  assert.equal(toolForDisplay({ group: { items: [codemode, codemode] } }), null);
  const inner = { ...read("a"), parentToolCallId: "code" };
  assert.equal(isVisibleTool(inner), true);
  assert.strictEqual(toolForDisplay(inner), inner);
});

test("隐藏包装层不隐藏整组失败状态，普通工具组保持原样", () => {
  const item = read("a");
  const failed = toolForDisplay({ status: "failed", group: { items: [item, { ...codemode, status: "failed" }] } });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.group.items, [item]);
  const ordinary = { group: { name: "2 tool calls", items: [item, read("b")] } };
  assert.strictEqual(toolForDisplay(ordinary), ordinary);
});
