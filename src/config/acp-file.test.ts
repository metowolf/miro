import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACP_FILE, readAcpProviders, writeAcpProviders } from "./acp-file.ts";

test("ACP provider definitions live in ~/.miro/acp.json, not settings.json", () => {
  assert.equal(ACP_FILE, path.join(os.homedir(), ".miro", "acp.json"));
});

test("acp.json is a flat provider table without a providers wrapper", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-acp-file-"));
  const file = path.join(dir, "nested", "acp.json");
  try {
    const definitions = {
      knot: { command: "knot-cli", args: ["acp"], model: "claude-opus-5.5" },
      cursor: {},
    };
    writeAcpProviders(definitions, file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), definitions);
    assert.deepEqual(readAcpProviders(file), definitions);
    assert.equal(readFileSync(file, "utf8").includes('"providers"'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or corrupted acp.json reads as an empty table", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-acp-file-"));
  const file = path.join(dir, "acp.json");
  try {
    assert.deepEqual(readAcpProviders(file), {});
    writeFileSync(file, "{ not json", "utf8");
    assert.deepEqual(readAcpProviders(file), {});
    writeFileSync(file, "[]", "utf8");
    assert.deepEqual(readAcpProviders(file), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
