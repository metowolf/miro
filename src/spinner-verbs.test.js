import test from "node:test";
import assert from "node:assert/strict";

import {
  SPINNER_VERBS,
  getSpinnerVerbs,
  normalizeSpinnerVerbsConfig,
  sampleSpinnerVerb,
} from "./spinner-verbs.js";

test("a missing or invalid config normalizes to null", () => {
  assert.equal(normalizeSpinnerVerbsConfig(undefined), null);
  assert.equal(normalizeSpinnerVerbsConfig(null), null);
  assert.equal(normalizeSpinnerVerbsConfig("append"), null);
  assert.equal(normalizeSpinnerVerbsConfig([]), null);
  assert.equal(normalizeSpinnerVerbsConfig({}), null);
  assert.equal(normalizeSpinnerVerbsConfig({ mode: "replace" }), null);
});

test("an empty or all-whitespace verbs list counts as invalid config", () => {
  assert.equal(normalizeSpinnerVerbsConfig({ mode: "replace", verbs: [] }), null);
  assert.equal(normalizeSpinnerVerbsConfig({ mode: "replace", verbs: ["  ", ""] }), null);
  assert.equal(normalizeSpinnerVerbsConfig({ verbs: [1, null, false] }), null);
});

test("normalization trims whitespace, drops non-strings, and defaults mode to append", () => {
  assert.deepEqual(
    normalizeSpinnerVerbsConfig({ verbs: ["  Hacking  ", 42, "Vibing"] }),
    { mode: "append", verbs: ["Hacking", "Vibing"] }
  );
});

test("an invalid mode falls back to append", () => {
  assert.deepEqual(
    normalizeSpinnerVerbsConfig({ mode: "nonsense", verbs: ["Hacking"] }),
    { mode: "append", verbs: ["Hacking"] }
  );
});

test("falls back to the default list when there is no config", () => {
  assert.deepEqual(getSpinnerVerbs({}), SPINNER_VERBS);
});

test("append mode adds custom verbs after the default list", () => {
  const verbs = getSpinnerVerbs({ spinnerVerbs: { mode: "append", verbs: ["Hacking"] } });
  assert.equal(verbs.length, SPINNER_VERBS.length + 1);
  assert.equal(verbs.at(-1), "Hacking");
  assert.ok(verbs.includes("Thinking"));
});

test("replace mode uses only the custom verbs", () => {
  const verbs = getSpinnerVerbs({ spinnerVerbs: { mode: "replace", verbs: ["Hacking"] } });
  assert.deepEqual(verbs, ["Hacking"]);
});

test("replace mode with an empty verb list falls back to the default list", () => {
  assert.deepEqual(
    getSpinnerVerbs({ spinnerVerbs: { mode: "replace", verbs: [] } }),
    SPINNER_VERBS
  );
});

test("falls back to Working when the list is empty or invalid", () => {
  assert.equal(sampleSpinnerVerb([]), "Working");
  assert.equal(sampleSpinnerVerb(null), "Working");
});

test("a single-verb list always returns that verb", () => {
  assert.equal(sampleSpinnerVerb(["Hacking"]), "Hacking");
});
