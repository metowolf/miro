import assert from "node:assert/strict";
import test from "node:test";

import { autoReviewNote } from "./auto-review-note.js";

test("a blocked review spells out the reviewer's reason", () => {
  assert.equal(
    autoReviewNote({ status: "blocked", reason: "deletes files outside the workspace" }),
    "Auto safety review: blocked · deletes files outside the workspace"
  );
});

test("a blocked review without a usable reason still says so", () => {
  assert.equal(autoReviewNote({ status: "blocked" }), "Auto safety review: blocked · no reason given");
  assert.equal(autoReviewNote({ status: "blocked", reason: "   " }), "Auto safety review: blocked · no reason given");
});

test("checking and approved states read as states, not verdicts", () => {
  assert.equal(autoReviewNote({ status: "checking" }), "Auto safety review: checking…");
  assert.equal(autoReviewNote({ status: "allowed", reason: "required by the request" }), "Auto safety review: approved");
});

test("an unknown status and a missing payload do not invent a verdict", () => {
  assert.equal(autoReviewNote({ status: "needs_approval" }), "Auto safety review: no decision");
  assert.equal(autoReviewNote(null), null);
  assert.equal(autoReviewNote(undefined), null);
});
