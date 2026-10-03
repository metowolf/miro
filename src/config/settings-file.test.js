import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as settingsFile from "./settings-file.js";
import {
  normalizeStatusLineConfig,
  readLanguageSetting,
  readStatusLineSettings,
  readThinkingSettings,
  SYSTEM_SETTINGS_FILE,
} from "./settings-file.js";

test("system settings only use ~/.miro/settings.json", () => {
  assert.equal(SYSTEM_SETTINGS_FILE, path.join(os.homedir(), ".miro", "settings.json"));
  assert.equal("LEGACY_SETTINGS_FILE" in settingsFile, false);
});

test("normalizeStatusLineConfig lowercases entries and drops duplicates", () => {
  assert.deepEqual(
    normalizeStatusLineConfig(["Model-With-Reasoning", " current-dir ", "current-dir"]),
    ["model-with-reasoning", "current-dir"]
  );
});

test("normalizeStatusLineConfig preserves empty array semantics", () => {
  assert.deepEqual(normalizeStatusLineConfig([]), []);
});

test("normalizeStatusLineConfig returns null for non-arrays (treated as unset)", () => {
  assert.equal(normalizeStatusLineConfig(undefined), null);
  assert.equal(normalizeStatusLineConfig(null), null);
  assert.equal(normalizeStatusLineConfig("model"), null);
  assert.equal(normalizeStatusLineConfig({ a: 1 }), null);
});

test("normalizeStatusLineConfig drops non-strings and blank entries", () => {
  assert.deepEqual(normalizeStatusLineConfig(["model", 1, null, "  ", "mode"]), ["model", "mode"]);
});

test("readStatusLineSettings defaults items to null and enables colors", () => {
  const settings = readStatusLineSettings({});
  assert.equal(settings.items, null);
  assert.equal(settings.useColors, true);
});

test("readStatusLineSettings disables colors only on an explicit false", () => {
  assert.equal(readStatusLineSettings({ statusLineUseColors: false }).useColors, false);
  assert.equal(readStatusLineSettings({ statusLineUseColors: 0 }).useColors, true);
});

test("readStatusLineSettings parses an ordered array", () => {
  const settings = readStatusLineSettings({
    statusLine: ["run-state", "model", "run-state"],
  });
  assert.deepEqual(settings.items, ["run-state", "model"]);
});

test("readLanguageSetting defaults to english and normalizes stored values", () => {
  assert.equal(readLanguageSetting({}), "english");
  assert.equal(readLanguageSetting({ language: "Chinese" }), "chinese");
  assert.equal(readLanguageSetting({ language: "zh" }), "chinese");
  // 手改坏的取值不应让 /init 失败，按默认语言处理。
  assert.equal(readLanguageSetting({ language: "klingon" }), "english");
  assert.equal(readLanguageSetting({ language: 42 }), "english");
});

test("readThinkingSettings defaults to compact and does not record raw thinking", () => {
  assert.deepEqual(readThinkingSettings({}), { display: "compact", recordRaw: false });
  assert.deepEqual(readThinkingSettings({ thinkingDisplay: "full", recordRawThinking: true }), {
    display: "full",
    recordRaw: true,
  });
  assert.equal(readThinkingSettings({ thinkingDisplay: "broken" }).display, "compact");
});

test("writeStatusLineSettings writes both fields at once and keeps other settings", () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "miro-statusline-settings-"));
  const miroDir = path.join(tempHome, ".miro");
  const settingsPath = path.join(miroDir, "settings.json");
  mkdirSync(miroDir, { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ provider: "codex", statusLine: ["model"], statusLineUseColors: true }),
    "utf8"
  );

  try {
    const moduleUrl = new URL("./settings-file.js", import.meta.url).href;
    const script = [
      `import { writeStatusLineSettings } from ${JSON.stringify(moduleUrl)};`,
      'writeStatusLineSettings({ items: ["git-branch", "current-dir"], useColors: false });',
    ].join("\n");
    const result = spawnSync(process.execPath, ["--eval", script], {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      provider: "codex",
      statusLine: ["git-branch", "current-dir"],
      statusLineUseColors: false,
    });
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
