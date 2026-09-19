import assert from "node:assert/strict";
import test from "node:test";

import { generateCommandSuggestions, parseCommandInput, SLASH_COMMANDS } from "./commands.js";

test("/statusline is registered, completable, and keeps the reset argument", () => {
  const registered = SLASH_COMMANDS.find((cmd) => cmd.name === "statusline");
  assert.ok(registered, "statusline should exist in the command registry");

  const suggestions = generateCommandSuggestions("/stat");
  assert.equal(suggestions[0].name, "statusline");
  assert.equal(suggestions[0].displayText, "/statusline");
  assert.deepEqual(parseCommandInput("/statusline reset"), {
    key: "statusline",
    args: "reset",
  });
});
