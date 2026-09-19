import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandInput, generateCommandSuggestions, SLASH_COMMANDS } from "./commands.js";
import { INIT_PROMPT, buildInitPrompt } from "./prompts.js";

test("/init is registered as a slash command and is prefix-completable", () => {
  const registered = SLASH_COMMANDS.find((cmd) => cmd.name === "init");
  assert.ok(registered, "init should exist in the command registry");

  const suggestions = generateCommandSuggestions("/in");
  assert.equal(suggestions[0].name, "init");
  assert.equal(suggestions[0].displayText, "/init");
});

test("/init without arguments parses to empty args", () => {
  assert.deepEqual(parseCommandInput("/init"), { key: "init", args: "" });
});

test("/init xxxxx parses arguments keeping their original casing", () => {
  assert.deepEqual(parseCommandInput("/init Focus on Test Commands"), {
    key: "init",
    args: "Focus on Test Commands",
  });
});

test("no arguments returns the original prompt", () => {
  // 显式指定语言：默认值会读 ~/.miro/settings.json，不能让本机配置影响断言。
  assert.equal(buildInitPrompt(undefined, "english"), INIT_PROMPT);
  assert.equal(buildInitPrompt("   ", "english"), INIT_PROMPT);
});

test("arguments append the extra instructions after the base prompt", () => {
  const prompt = buildInitPrompt("Focus on the ACP layer", "english");
  assert.ok(prompt.startsWith(INIT_PROMPT), "the full base prompt should be kept");
  assert.ok(prompt.includes("Focus on the ACP layer"), "the user's extra instruction should be included");
  assert.ok(
    prompt.indexOf("Focus on the ACP layer") > INIT_PROMPT.length - 1,
    "the extra instruction should come after the base prompt"
  );
});
