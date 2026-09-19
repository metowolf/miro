import assert from "node:assert/strict";
import test from "node:test";

import { generateCommandSuggestions, parseCommandInput, SLASH_COMMANDS } from "./commands.js";

test("/thinking is registered with direct display modes", () => {
  const registered = SLASH_COMMANDS.find((cmd) => cmd.name === "thinking");
  assert.ok(registered);
  assert.deepEqual(parseCommandInput("/thinking"), { key: "thinking", args: "" });
  assert.deepEqual(parseCommandInput("/thinking full"), { key: "thinking", args: "full" });
  assert.ok(generateCommandSuggestions("/think").some((item) => item.name === "thinking"));
});
