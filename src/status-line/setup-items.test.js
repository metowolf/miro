import assert from "node:assert/strict";
import test from "node:test";

import { STATUS_LINE_ITEMS } from "./items.js";
import { buildPreviewSegments, buildSetupItems } from "./setup-items.js";

test("buildSetupItems pins the color toggle to the first item", () => {
  const [colors] = buildSetupItems([], false);
  assert.deepEqual(colors, {
    id: "use-colors",
    label: "Use colors",
    description: "Apply colors to status line items",
    enabled: false,
    orderable: false,
    sectionBreakAfter: true,
  });
});

test("buildSetupItems puts configured items first in their original order and checks them", () => {
  const items = buildSetupItems(["git-branch", "model"], true).slice(1);
  assert.deepEqual(
    items.slice(0, 2).map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: "git-branch", enabled: true },
      { id: "model", enabled: true },
    ]
  );
  assert.equal(items[2].enabled, false);
  assert.equal(items.length, STATUS_LINE_ITEMS.size);
});

test("buildSetupItems skips invalid ids and normalizes aliases and duplicate entries", () => {
  const items = buildSetupItems(["model-name", "nope", "model", "git-branch", "git-branch"]);
  assert.deepEqual(items.slice(1, 3).map((item) => item.id), ["model", "git-branch"]);
  assert.equal(items.filter((item) => item.id === "model").length, 1);
  assert.equal(items.some((item) => item.id === "nope"), false);
});

test("buildPreviewSegments prefers real values and falls back to the placeholder when missing", () => {
  const items = buildSetupItems(["model", "git-branch"]);
  const segments = buildPreviewSegments(items, { modelName: "gpt-5-codex" });
  assert.deepEqual(
    segments.map(({ id, text }) => ({ id, text })),
    [
      { id: "model", text: "gpt-5-codex" },
      { id: "git-branch", text: "feat/branch-name" },
    ]
  );
});

test("buildPreviewSegments returns directly renderable color and dim fields", () => {
  const items = buildSetupItems(["model", "hostname"]);
  assert.deepEqual(buildPreviewSegments(items, {}, { useColors: true }), [
    { id: "model", text: "gpt-5", color: "yellow", dim: false },
    { id: "hostname", text: "localhost", color: null, dim: true },
  ]);
  assert.deepEqual(buildPreviewSegments(items, {}, { useColors: false }), [
    { id: "model", text: "gpt-5", color: null, dim: true },
    { id: "hostname", text: "localhost", color: null, dim: true },
  ]);
});

test("buildPreviewSegments ignores the color control item, unchecked items, and unknown items", () => {
  const items = [
    { id: "use-colors", enabled: true },
    { id: "model", enabled: false },
    { id: "nope", enabled: true },
  ];
  assert.deepEqual(buildPreviewSegments(items, {}), []);
});

test("buildPreviewSegments returns an empty array for an empty selection", () => {
  assert.deepEqual(buildPreviewSegments([], {}), []);
  assert.deepEqual(buildPreviewSegments(undefined, {}), []);
});
