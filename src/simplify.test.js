import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSimplifyRequest,
  looksLikePaths,
  simplifyPrompt,
  simplifyRubricFor,
  SIMPLIFY_RUBRIC,
  userFacingHint,
} from "./simplify.js";
import { simplifyPrompts } from "./prompts/index.js";
import { LANGUAGE_IDS } from "./prompts/language.js";
import { SLASH_COMMANDS, parseCommandInput, generateCommandSuggestions } from "./commands.js";

const CWD = process.cwd();

test("/simplify is registered and parses its arguments", () => {
  const registered = SLASH_COMMANDS.find((cmd) => cmd.name === "simplify");
  assert.ok(registered, "/simplify should be registered");
  assert.deepEqual(parseCommandInput("/simplify"), { key: "simplify", args: "" });
  assert.deepEqual(parseCommandInput("/simplify src/parse.js"), {
    key: "simplify",
    args: "src/parse.js",
  });
  assert.ok(generateCommandSuggestions("/simp").some((item) => item.name === "simplify"));
});

test("uncommitted prompt covers the three file states and stresses preserving functionality", async () => {
  const prompt = await simplifyPrompt({ kind: "uncommitted" }, CWD, "english");
  assert.match(prompt, /staged, unstaged, and untracked/);
  assert.match(prompt, /preserving all functionality/);
});

test("commit target writes the title into the prompt when one is given", async () => {
  const withTitle = await simplifyPrompt(
    { kind: "commit", sha: "abc1234", title: "Fix parser" },
    CWD,
    "english"
  );
  assert.match(withTitle, /commit abc1234 \("Fix parser"\)/);

  const bare = await simplifyPrompt({ kind: "commit", sha: "abc1234" }, CWD, "english");
  assert.match(bare, /commit abc1234\./);
  assert.doesNotMatch(bare, /\(""\)/);
});

test("paths target writes the paths into the prompt and rejects empty paths", async () => {
  const prompt = await simplifyPrompt({ kind: "paths", paths: " src/parse.js " }, CWD, "english");
  assert.match(prompt, /src\/parse\.js/);
  assert.match(prompt, /preserving all functionality/);
  await assert.rejects(() => simplifyPrompt({ kind: "paths", paths: "   " }, CWD));
});

test("custom instructions pass through verbatim and blank instructions are rejected", async () => {
  assert.equal(
    await simplifyPrompt({ kind: "custom", instructions: "  tidy the reducer  " }, CWD),
    "tidy the reducer"
  );
  await assert.rejects(() => simplifyPrompt({ kind: "custom", instructions: "   " }, CWD));
});

test("unknown target kind throws instead of silently building an empty prompt", async () => {
  await assert.rejects(() => simplifyPrompt({ kind: "nope" }, CWD));
});

test("userFacingHint is used for transcript display and commit shows only the short sha", () => {
  assert.equal(userFacingHint({ kind: "uncommitted" }), "current changes");
  assert.equal(userFacingHint({ kind: "base-branch", branch: "main" }), "changes against 'main'");
  assert.equal(
    userFacingHint({ kind: "commit", sha: "0123456789abcdef", title: "Fix parser" }),
    "commit 0123456: Fix parser"
  );
  assert.equal(userFacingHint({ kind: "paths", paths: " src/a.js " }), "src/a.js");
  assert.equal(userFacingHint({ kind: "custom", instructions: " tidy auth " }), "tidy auth");
});

test("request joins the rubric with the target prompt and requires body output", () => {
  const request = buildSimplifyRequest("Simplify the current code changes.", "english");
  assert.ok(request.startsWith(SIMPLIFY_RUBRIC));
  assert.match(request, /Simplify the current code changes\.$/);
  assert.match(request, /\*\*Verdict:\*\* simplified/);
  assert.match(request, /## Changes/);
});

test("rubric keeps the five core code-simplifier constraints", () => {
  assert.match(SIMPLIFY_RUBRIC, /Preserve functionality/);
  assert.match(SIMPLIFY_RUBRIC, /Apply project standards/);
  assert.match(SIMPLIFY_RUBRIC, /Enhance clarity/);
  assert.match(SIMPLIFY_RUBRIC, /Maintain balance/);
  assert.match(SIMPLIFY_RUBRIC, /Focus scope/);
});

test("rubric keeps the upstream readability trade-offs", () => {
  assert.match(SIMPLIFY_RUBRIC, /Avoid nested ternary operators/);
  assert.match(SIMPLIFY_RUBRIC, /clarity over brevity/);
  assert.match(SIMPLIFY_RUBRIC, /Never change what the code does/);
});

test("rubric bans scope creep: no bug fixes, no test changes, no JSON output", () => {
  assert.match(SIMPLIFY_RUBRIC, /Do not fix bugs/);
  assert.match(SIMPLIFY_RUBRIC, /Do not add or update tests/);
  assert.match(SIMPLIFY_RUBRIC, /Do not emit JSON/);
});

test("rubric priority wording does not depend on text order", () => {
  // AGENTS.md 由 AcpClient 作为首轮上下文注入，位置在 rubric 之前，
  // 因此 rubric 不能用顺序性表述，并且要显式提到 AGENTS.md 作为规范来源。
  assert.doesNotMatch(SIMPLIFY_RUBRIC, /encounter later/);
  assert.match(SIMPLIFY_RUBRIC, /lowest precedence/);
  assert.match(SIMPLIFY_RUBRIC, /regardless of whether it appears before or after/);
  assert.match(SIMPLIFY_RUBRIC, /AGENTS\.md/);
});

test("every language provides the full set of simplify prompt keys", () => {
  for (const id of LANGUAGE_IDS) {
    const bundle = simplifyPrompts(id);
    assert.ok(bundle.SIMPLIFY_RUBRIC?.length > 0, `${id} is missing SIMPLIFY_RUBRIC`);
    assert.ok(bundle.UNCOMMITTED_PROMPT?.length > 0, `${id} is missing UNCOMMITTED_PROMPT`);
    assert.equal(typeof bundle.baseBranchPrompt, "function", `${id} is missing baseBranchPrompt`);
    assert.equal(typeof bundle.commitPrompt, "function", `${id} is missing commitPrompt`);
    assert.equal(typeof bundle.pathsPrompt, "function", `${id} is missing pathsPrompt`);
  }
});

test("chinese rubric differs from english but keeps the same output skeleton", () => {
  const chinese = simplifyRubricFor("chinese");
  assert.notEqual(chinese, SIMPLIFY_RUBRIC);
  assert.match(chinese, /简化准则/);
  // Verdict 行与小节标题保持英文，两种语言渲染结果一致。
  assert.match(chinese, /\*\*Verdict:\*\* simplified/);
  assert.match(chinese, /## Changes/);
});

test("unknown language falls back to the default english rubric", () => {
  assert.equal(simplifyRubricFor("klingon"), SIMPLIFY_RUBRIC);
  assert.equal(simplifyRubricFor(undefined), SIMPLIFY_RUBRIC);
});

test("argument routing: path-like input goes to paths, natural language goes to custom", () => {
  assert.equal(looksLikePaths("src/parse.js"), true);
  assert.equal(looksLikePaths("src/a.js src/b.js"), true);
  assert.equal(looksLikePaths("./src/"), true);
  assert.equal(looksLikePaths("the parser in src"), false);
  assert.equal(looksLikePaths("tidy up the reducer"), false);
  assert.equal(looksLikePaths("simplify"), false, "a single word without separators is not a path");
  assert.equal(looksLikePaths(""), false);
  assert.equal(looksLikePaths(null), false);
});

/** 建一个可控的小仓库，用于 git 相关断言。 */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "miro-simplify-"));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "first commit"]);
  return { dir, run };
}

test("prompt gives a concrete diff command when a merge base exists", async () => {
  const { dir, run } = makeRepo();
  run(["checkout", "-q", "-b", "feature"]);
  writeFileSync(path.join(dir, "b.txt"), "two\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "second commit"]);

  const prompt = await simplifyPrompt({ kind: "base-branch", branch: "main" }, dir, "english");
  assert.match(prompt, /git diff [0-9a-f]{40}/);
});

test("falls back to letting the model resolve the merge base when unavailable", async () => {
  const { dir } = makeRepo();
  const prompt = await simplifyPrompt({ kind: "base-branch", branch: "no-such-branch" }, dir, "english");
  assert.match(prompt, /git merge-base HEAD/);
});
