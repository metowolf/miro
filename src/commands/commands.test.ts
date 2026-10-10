import assert from "node:assert/strict";
import test from "node:test";

import { generateCommandSuggestions, parseCommandInput } from "./commands.ts";

// 命令名、补全前缀和原样参数是用户契约；不从注册表生成预期值，避免自证。
const cases = [
  { name: "init", prefix: "/in", args: ["", "Focus on Test Commands"] },
  { name: "review", prefix: "/rev", args: ["", "focus on error handling"] },
  { name: "simplify", prefix: "/simp", args: ["", "src/parse.js"] },
  { name: "commit", prefix: "/comm", args: ["", "fix the parser"] },
  { name: "commit-push-pr", prefix: "/commit-p", args: [""] },
  { name: "config", prefix: "/conf", args: ["", "enable_thinking true"] },
  { name: "plan", prefix: "/pla", args: ["on", "status"] },
  { name: "thinking", prefix: "/think", args: ["", "full"] },
  { name: "statusline", prefix: "/stat", args: ["reset"] },
];

test("内置命令可解析且保留参数原文", () => {
  for (const { name, args } of cases) {
    for (const value of args) {
      const input = `/${name}${value ? ` ${value}` : ""}`;
      assert.deepEqual(parseCommandInput(input), { key: name, args: value }, input);
    }
  }
  assert.deepEqual(parseCommandInput("/COMMIT-PUSH-PR"), { key: "commit-push-pr", args: "" });
});

test("内置命令可通过已有前缀补全", () => {
  for (const { name, prefix } of cases) {
    const suggestions = generateCommandSuggestions(prefix);
    const suggestion = suggestions.find((item) => item.name === name);
    assert.equal(suggestion?.displayText, `/${name}`, prefix);
    if (["init", "config", "plan", "statusline"].includes(name)) {
      assert.equal(suggestions[0]?.name, name, prefix);
    }
  }
});
