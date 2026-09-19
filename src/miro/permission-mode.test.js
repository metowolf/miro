import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_CHOICES,
  PERMISSION_MODES,
  isAuto,
  isManual,
  normalizePermissionMode,
  permissionScope,
} from "./permission-mode.js";
import { getNextModeId } from "../mode-cycle.js";

test("miro permissions offer Auto and Manual, while legacy values fall back to Auto", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "auto");
  assert.deepEqual(PERMISSION_MODES, ["auto", "manual"]);
  for (const value of [undefined, null, "ask", "plan", "yolo", "unknown"]) {
    assert.equal(normalizePermissionMode(value), "auto");
  }
  assert.equal(normalizePermissionMode(" MANUAL "), "manual");
  assert.equal(isAuto("auto"), true);
  assert.equal(isManual("manual"), true);
  const availableModes = PERMISSION_MODE_CHOICES.map((choice) => ({ id: choice.value, name: choice.name }));
  assert.equal(getNextModeId({ currentModeId: "auto", availableModes }), "manual");
  assert.equal(getNextModeId({ currentModeId: "manual", availableModes }), "auto");
});

test("Manual session scopes bind commands and edits to their exact targets", () => {
  const cwd = "/workspace";
  const safeRm = permissionScope({ name: "terminal", kind: "execute", cwd, rawInput: { command: "rm scratch.txt" } });
  const dangerousRm = permissionScope({ name: "terminal", kind: "execute", cwd, rawInput: { command: "rm -rf /" } });
  assert.notEqual(safeRm, dangerousRm);
  assert.notEqual(
    permissionScope({ name: "write_file", kind: "edit", cwd, rawInput: { path: "a.txt" } }),
    permissionScope({ name: "write_file", kind: "edit", cwd, rawInput: { path: "/tmp/a.txt" } }),
  );
});
