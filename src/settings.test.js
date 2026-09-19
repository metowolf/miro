import assert from "node:assert/strict";
import test from "node:test";

import {
  readEffortPreference,
  readModelPreference,
  normalizeDisabledTools,
  withPreference,
} from "./settings.js";

test("disableTools is normalized as a distinct miro tool setting", () => {
  assert.deepEqual(normalizeDisabledTools(["read_file", " read_file ", 1, "", "run_command"]), [
    "read_file",
    // 曾用名归一为现在的工具名，旧设置不会在升级后失效。
    "terminal",
  ]);
  assert.deepEqual(normalizeDisabledTools("read_file"), []);
});

test("miro model / effort preferences read from the top level of settings", () => {
  const settings = { model: "gpt-4o", effort: "high" };
  assert.equal(readModelPreference(settings, "miro"), "gpt-4o");
  assert.equal(readEffortPreference(settings, "miro"), "high");
  assert.equal(readModelPreference(settings), "gpt-4o", "omitting providerId is treated as miro");
});

test("an ACP provider reads preferences only from its own providers.<id>", () => {
  const settings = {
    model: "gpt-4o",
    effort: "high",
    providers: {
      cursor: { model: "sonnet", effort: "low" },
      claude: { command: "claude-agent-acp" },
    },
  };
  assert.equal(readModelPreference(settings, "cursor"), "sonnet");
  assert.equal(readEffortPreference(settings, "cursor"), "low");
});

test("top-level preferences are not lent to an ACP provider", () => {
  const settings = { model: "gpt-4o", effort: "high", providers: {} };
  assert.equal(readModelPreference(settings, "cursor"), null);
  assert.equal(readEffortPreference(settings, "cursor"), null);
});

test("a missing, non-string, or blank preference counts as unrecorded", () => {
  const settings = {
    model: 42,
    effort: "   ",
    providers: { cursor: { model: null, effort: [] } },
  };
  assert.equal(readModelPreference(settings, "miro"), null);
  assert.equal(readEffortPreference(settings, "miro"), null);
  assert.equal(readModelPreference(settings, "cursor"), null);
  assert.equal(readEffortPreference(settings, "cursor"), null);
});

test("a corrupted providers field is treated as unrecorded instead of throwing", () => {
  for (const providers of [[], "cursor", 7, null]) {
    assert.equal(readModelPreference({ providers }, "cursor"), null);
  }
});

test("withPreference keeps the definition fields of the same entry for an ACP provider", () => {
  const settings = {
    provider: "cursor",
    providers: {
      cursor: { command: "cursor-agent", args: ["acp"], name: "Cursor", sessionMeta: { agentId: "a" } },
    },
  };
  const next = withPreference(settings, "cursor", "model", "sonnet");
  assert.deepEqual(next.providers.cursor, {
    command: "cursor-agent",
    args: ["acp"],
    name: "Cursor",
    sessionMeta: { agentId: "a" },
    model: "sonnet",
  });
  assert.equal(next.provider, "cursor", "other fields are preserved");
  assert.equal(settings.providers.cursor.model, undefined, "the input is not mutated in place");
});

test("withPreference creates a preference-only entry for a built-in provider", () => {
  const next = withPreference({}, "codex", "effort", "high");
  assert.deepEqual(next.providers, { codex: { effort: "high" } });
});

test("withPreference rebuilds the providers field when it is corrupted", () => {
  const next = withPreference({ providers: ["broken"] }, "codex", "model", "gpt-5");
  assert.deepEqual(next.providers, { codex: { model: "gpt-5" } });
});

test("withPreference writes to the top level for miro and leaves providers untouched", () => {
  const settings = { providers: { codex: { effort: "high" } } };
  const next = withPreference(settings, "miro", "model", "gpt-4o");
  assert.equal(next.model, "gpt-4o");
  assert.deepEqual(next.providers, { codex: { effort: "high" } });
  assert.deepEqual(withPreference({}, null, "effort", "low"), { effort: "low" });
});
