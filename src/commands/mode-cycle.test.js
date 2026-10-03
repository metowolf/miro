import assert from "node:assert/strict";
import test from "node:test";

import { getNextModeId } from "./mode-cycle.js";

/** 构造一个标准 modes 对象。 */
function modes(current, list) {
  return {
    currentModeId: current,
    availableModes: list.map((id) => ({ id, name: id })),
  };
}

test("getNextModeId cycles forward and wraps around", () => {
  const m = modes("code", ["ask", "code", "plan"]);
  assert.equal(getNextModeId(m), "plan");

  const m2 = modes("plan", ["ask", "code", "plan"]);
  assert.equal(getNextModeId(m2), "ask");
});

test("getNextModeId returns null when availableModes has 0 or 1 items", () => {
  assert.equal(getNextModeId({ currentModeId: "x", availableModes: [] }), null);
  assert.equal(getNextModeId({ currentModeId: "only", availableModes: [{ id: "only" }] }), null);
});

test("getNextModeId returns null for null/undefined modes", () => {
  assert.equal(getNextModeId(null), null);
  assert.equal(getNextModeId(undefined), null);
});

test("getNextModeId falls back to first item when currentModeId is missing", () => {
  const m = modes("nonexistent", ["ask", "code", "plan"]);
  assert.equal(getNextModeId(m), "ask");
});

test("getNextModeId handles missing availableModes array", () => {
  assert.equal(getNextModeId({ currentModeId: "ask" }), null);
  assert.equal(getNextModeId({ currentModeId: "ask", availableModes: null }), null);
});
