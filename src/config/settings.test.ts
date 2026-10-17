import assert from "node:assert/strict";
import test from "node:test";

import {
  readAcpPreference,
  readEffortPreference,
  readModelPreference,
  withAcpPreference,
  withMiroPreference,
} from "./settings.ts";

test("miro model / effort preferences read from the top level of settings", () => {
  const settings = { model: "gpt-4o", effort: "high" };
  assert.equal(readModelPreference(settings, "miro"), "gpt-4o");
  assert.equal(readEffortPreference(settings, "miro"), "high");
  assert.equal(readModelPreference(settings), "gpt-4o", "omitting providerId is treated as miro");
});

test("an ACP provider reads preferences only from its own acp.json entry", () => {
  const acpProviders = {
    cursor: { model: "sonnet", effort: "low" },
    claude: { command: "claude-agent-acp" },
  };
  assert.equal(readModelPreference({}, "cursor", acpProviders), "sonnet");
  assert.equal(readEffortPreference({}, "cursor", acpProviders), "low");
});

test("top-level preferences are not lent to an ACP provider", () => {
  const settings = { model: "gpt-4o", effort: "high" };
  assert.equal(readModelPreference(settings, "cursor", {}), null);
  assert.equal(readEffortPreference(settings, "cursor", {}), null);
});

test("a settings.json providers field is ignored for an ACP provider", () => {
  const settings = { providers: { cursor: { model: "sonnet" } } };
  assert.equal(readModelPreference(settings, "cursor", {}), null);
});

test("a missing, non-string, or blank preference counts as unrecorded", () => {
  const settings = { model: 42, effort: "   " };
  const acpProviders = { cursor: { model: null, effort: [] } };
  assert.equal(readModelPreference(settings, "miro"), null);
  assert.equal(readEffortPreference(settings, "miro"), null);
  assert.equal(readModelPreference({}, "cursor", acpProviders), null);
  assert.equal(readEffortPreference({}, "cursor", acpProviders), null);
});

test("a corrupted acp.json table is treated as unrecorded instead of throwing", () => {
  for (const acpProviders of [[], "cursor", 7, null, undefined, { cursor: "sonnet" }]) {
    assert.equal(readAcpPreference(acpProviders, "cursor", "model"), null);
    assert.equal(readAcpPreference(acpProviders, "cursor", "effort"), null);
  }
});

test("withAcpPreference keeps the definition fields of the same entry", () => {
  const acpProviders = {
    cursor: { command: "cursor-agent", args: ["acp"], name: "Cursor", sessionMeta: { agentId: "a" } },
  };
  const next = withAcpPreference(acpProviders, "cursor", "model", "sonnet");
  assert.deepEqual(next.cursor, {
    command: "cursor-agent",
    args: ["acp"],
    name: "Cursor",
    sessionMeta: { agentId: "a" },
    model: "sonnet",
  });
  assert.equal((acpProviders.cursor as { model?: string }).model, undefined, "the input is not mutated in place");
});

test("withAcpPreference creates a preference-only entry for a built-in provider", () => {
  const next = withAcpPreference({}, "codex", "effort", "high");
  assert.deepEqual(next, { codex: { effort: "high" } });
});

test("withAcpPreference rebuilds the table when it is corrupted", () => {
  const next = withAcpPreference(["broken"], "codex", "model", "gpt-5");
  assert.deepEqual(next, { codex: { model: "gpt-5" } });
});

test("withMiroPreference writes to the top level of settings", () => {
  const settings = { statusLine: ["model"] };
  const next = withMiroPreference(settings, "model", "gpt-4o");
  assert.equal(next.model, "gpt-4o");
  assert.deepEqual(next.statusLine, ["model"]);
  assert.equal((settings as { model?: string }).model, undefined, "the input is not mutated in place");
  assert.deepEqual(withMiroPreference({}, "effort", "low"), { effort: "low" });
});
