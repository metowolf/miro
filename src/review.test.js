import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildReviewRequest,
  currentBranch,
  hasUncommittedChanges,
  isGitRepo,
  localBranches,
  mergeBaseWithHead,
  recentCommits,
  reviewPrompt,
  REVIEW_RUBRIC,
  userFacingHint,
} from "./review.js";
import { SLASH_COMMANDS, parseCommandInput, generateCommandSuggestions } from "./commands.js";

const CWD = process.cwd();

test("/review is registered and parses its arguments", () => {
  const registered = SLASH_COMMANDS.find((cmd) => cmd.name === "review");
  assert.ok(registered, "/review should be registered");
  assert.deepEqual(parseCommandInput("/review"), { key: "review", args: "" });
  assert.deepEqual(parseCommandInput("/review focus on error handling"), {
    key: "review",
    args: "focus on error handling",
  });
  assert.ok(generateCommandSuggestions("/rev").some((item) => item.name === "review"));
});

test("uncommitted prompt covers the three file states", async () => {
  const prompt = await reviewPrompt({ kind: "uncommitted" }, CWD, "english");
  assert.match(prompt, /staged, unstaged, and untracked/);
});

test("commit target writes the title into the prompt when one is given", async () => {
  const withTitle = await reviewPrompt(
    { kind: "commit", sha: "abc1234", title: "Fix parser" },
    CWD,
    "english"
  );
  assert.match(withTitle, /commit abc1234 \("Fix parser"\)/);

  const bare = await reviewPrompt({ kind: "commit", sha: "abc1234" }, CWD, "english");
  assert.match(bare, /commit abc1234\./);
  assert.doesNotMatch(bare, /\(""\)/);
});

test("custom instructions pass through verbatim and blank instructions are rejected", async () => {
  assert.equal(await reviewPrompt({ kind: "custom", instructions: "  check locks  " }, CWD), "check locks");
  await assert.rejects(() => reviewPrompt({ kind: "custom", instructions: "   " }, CWD));
});

test("unknown target kind throws instead of silently building an empty prompt", async () => {
  await assert.rejects(() => reviewPrompt({ kind: "nope" }, CWD));
});

test("userFacingHint is used for transcript display and commit shows only the short sha", () => {
  assert.equal(userFacingHint({ kind: "uncommitted" }), "current changes");
  assert.equal(userFacingHint({ kind: "base-branch", branch: "main" }), "changes against 'main'");
  assert.equal(
    userFacingHint({ kind: "commit", sha: "0123456789abcdef", title: "Fix parser" }),
    "commit 0123456: Fix parser"
  );
  assert.equal(userFacingHint({ kind: "custom", instructions: " look at auth " }), "look at auth");
});

test("request joins the rubric with the target prompt and requires body output", () => {
  const request = buildReviewRequest("Review the current code changes.", "english");
  assert.ok(request.startsWith(REVIEW_RUBRIC));
  assert.match(request, /Review the current code changes\.$/);
  assert.match(request, /\*\*Verdict:\*\* patch is correct/);
  assert.match(request, /## Findings/);
});

test("rubric explicitly bans JSON output and leaves no stale schema fields", () => {
  assert.match(REVIEW_RUBRIC, /Do not emit JSON/);
  for (const field of [
    "overall_correctness",
    "overall_explanation",
    "confidence_score",
    "code_location",
    "absolute_file_path",
    "line_range",
  ]) {
    assert.doesNotMatch(REVIEW_RUBRIC, new RegExp(field), `${field} should be gone`);
  }
});

test("rubric priority wording does not depend on text order", () => {
  // AGENTS.md 由 AcpClient 作为首轮上下文注入，位置在 rubric 之前，
  // 因此 rubric 不能再用 \"instructions you encounter later\" 这类顺序性表述。
  assert.doesNotMatch(REVIEW_RUBRIC, /encounter later/);
  assert.match(REVIEW_RUBRIC, /lowest precedence/);
  assert.match(REVIEW_RUBRIC, /regardless of whether it appears before or after/);
  assert.match(REVIEW_RUBRIC, /they outrank these guidelines/);
});

/** 建一个可控的小仓库，用于 git 相关断言。 */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "miro-review-"));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "first commit"]);
  return { dir, run };
}

test("git detection: inside vs outside a repository", async () => {
  const { dir } = makeRepo();
  assert.equal(await isGitRepo(dir), true);
  assert.equal(await isGitRepo(tmpdir()), false);
});

test("current branch and other local branches, excluding itself", async () => {
  const { dir, run } = makeRepo();
  assert.equal(await currentBranch(dir), "main");
  run(["branch", "feature"]);
  const branches = await localBranches(dir);
  assert.deepEqual(branches, ["feature"], "current branch must be excluded");
});

test("recentCommits returns sha and subject", async () => {
  const { dir } = makeRepo();
  const commits = await recentCommits(dir);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, "first commit");
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
});

test("prompt gives a concrete diff command when a merge base exists", async () => {
  const { dir, run } = makeRepo();
  run(["checkout", "-q", "-b", "feature"]);
  writeFileSync(path.join(dir, "b.txt"), "two\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "second commit"]);

  const sha = await mergeBaseWithHead(dir, "main");
  assert.match(sha, /^[0-9a-f]{40}$/);

  const prompt = await reviewPrompt({ kind: "base-branch", branch: "main" }, dir, "english");
  assert.match(prompt, new RegExp(`git diff ${sha}`));
});

test("falls back to letting the model resolve the merge base when unavailable", async () => {
  const { dir } = makeRepo();
  const prompt = await reviewPrompt({ kind: "base-branch", branch: "no-such-branch" }, dir, "english");
  assert.match(prompt, /git merge-base HEAD/);
});

test("dirty and clean working tree states are distinguishable", async () => {
  const { dir } = makeRepo();
  assert.equal(await hasUncommittedChanges(dir), false);
  writeFileSync(path.join(dir, "untracked.txt"), "new\n");
  assert.equal(await hasUncommittedChanges(dir), true, "untracked files count as changes");
});
