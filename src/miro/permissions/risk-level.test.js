import assert from "node:assert/strict";
import test from "node:test";

import { MAX_RISK_REASON_CHARS, normalizeRiskReason } from "./risk-level.js";

test("normalizeRiskReason 对非字符串与空白返回 null", () => {
  for (const value of [undefined, null, 1, {}, "", "   \n"]) {
    assert.equal(normalizeRiskReason(value), null);
  }
});

test("normalizeRiskReason 去除首尾空白并截断过长理由", () => {
  assert.equal(normalizeRiskReason("  cleans build output  "), "cleans build output");
  assert.equal(normalizeRiskReason("x".repeat(MAX_RISK_REASON_CHARS + 50)).length, MAX_RISK_REASON_CHARS);
});
