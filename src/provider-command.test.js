import assert from "node:assert/strict";
import test from "node:test";

import { matchProviderCommand, parseCommandInput, generateCommandSuggestions } from "./commands.js";

const PROVIDER_COMMANDS = [
  { name: "compact", description: "Manually compact the session context" },
  { name: "changelog", description: "Show changelog" },
  { name: "follow-up", description: "Get/set follow-up message delivery mode" },
];

test("provider-pushed commands are recognized", () => {
  assert.equal(matchProviderCommand("/changelog", PROVIDER_COMMANDS), "changelog");
  assert.equal(matchProviderCommand("/follow-up", PROVIDER_COMMANDS), "follow-up");
});

test("matches on the first token when arguments are present", () => {
  assert.equal(matchProviderCommand("/compact focus on the ACP layer", PROVIDER_COMMANDS), "compact");
});

test("misses, non-command input, and empty command names or lists return null", () => {
  assert.equal(matchProviderCommand("/unknown", PROVIDER_COMMANDS), null);
  assert.equal(matchProviderCommand("changelog", PROVIDER_COMMANDS), null);
  assert.equal(matchProviderCommand("请生成 changelog", PROVIDER_COMMANDS), null);
  assert.equal(matchProviderCommand("/ changelog", PROVIDER_COMMANDS), null);
  assert.equal(matchProviderCommand("/changelog", []), null);
});

test("matching is case-sensitive per provider semantics", () => {
  assert.equal(matchProviderCommand("/Changelog", PROVIDER_COMMANDS), null);
});

test("local commands win: parseCommandInput matches a same-named command first, so the provider branch never runs", () => {
  assert.deepEqual(parseCommandInput("/model"), { key: "model", args: "" });
  assert.equal(matchProviderCommand("/model", [{ name: "model" }]), "model");
});

test("/config is registered and its arguments parse", () => {
  assert.deepEqual(parseCommandInput("/config"), { key: "config", args: "" });
  assert.deepEqual(parseCommandInput("/config enable_thinking true"), {
    key: "config",
    args: "enable_thinking true",
  });
  const suggestions = generateCommandSuggestions("/conf");
  assert.equal(suggestions[0]?.name, "config");
});
