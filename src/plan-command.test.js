import assert from "node:assert/strict";
import test from "node:test";

import { generateCommandSuggestions, parseCommandInput, SLASH_COMMANDS } from "./commands.js";

test("/plan is registered and accepts on, off and status as opaque command arguments", () => {
  assert.ok(SLASH_COMMANDS.some((command) => command.name === "plan"));
  assert.deepEqual(parseCommandInput("/plan on"), { key: "plan", args: "on" });
  assert.deepEqual(parseCommandInput("/plan status"), { key: "plan", args: "status" });
  assert.equal(generateCommandSuggestions("/pla")[0].name, "plan");
});
