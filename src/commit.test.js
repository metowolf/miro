import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  availableForgeClis,
  buildCommitPushPrRequest,
  buildCommitRequest,
  commitPrompt,
  commitPushPrPrompt,
  commitPushPrRubricFor,
  commitRubricFor,
  commitTaskPrompt,
  COMMIT_PUSH_PR_RUBRIC,
  COMMIT_RUBRIC,
  detectForge,
  DIFF_LIMIT,
  hasCommits,
  hasStagedChanges,
  LOG_LIMIT,
  parseCommitArgs,
  parseRemoteHost,
  publishTarget,
  readCommitContext,
  truncateDiff,
  userFacingHint,
} from "./commit.js";
import { commitPrompts } from "./prompts/index.js";
import { LANGUAGE_IDS } from "./prompts/language.js";
import { SLASH_COMMANDS, parseCommandInput, generateCommandSuggestions } from "./commands.js";

/** 建一个可控的小仓库，用于 git 相关断言。 */
function makeRepo({ remote } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "miro-commit-"));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  if (remote) run(["remote", "add", "origin", remote]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "first commit"]);
  return { dir, run };
}

test("/commit is registered and parses its arguments", () => {
  const registered = SLASH_COMMANDS.find((cmd) => cmd.name === "commit");
  assert.ok(registered, "/commit should be registered");
  assert.deepEqual(parseCommandInput("/commit"), { key: "commit", args: "" });
  assert.deepEqual(parseCommandInput("/commit fix the parser"), {
    key: "commit",
    args: "fix the parser",
  });
  assert.ok(generateCommandSuggestions("/comm").some((item) => item.name === "commit"));
});

test("/commit-push-pr is registered and parses case-insensitively", () => {
  assert.ok(SLASH_COMMANDS.some((cmd) => cmd.name === "commit-push-pr"));
  assert.deepEqual(parseCommandInput("/commit-push-pr"), {
    key: "commit-push-pr",
    args: "",
  });
  assert.deepEqual(parseCommandInput("/COMMIT-PUSH-PR"), {
    key: "commit-push-pr",
    args: "",
  });
  assert.ok(
    generateCommandSuggestions("/commit-p").some((item) => item.name === "commit-push-pr")
  );
});

test("default task asks to stage the files and draft the message", () => {
  const prompt = commitTaskPrompt({ kind: "default" }, "english");
  assert.match(prompt, /single git commit/);
  assert.match(prompt, /Stage the relevant files yourself/);
});

test("message target treats user text as intent, not a literal message", () => {
  const prompt = commitTaskPrompt({ kind: "message", message: "  fix the parser  " }, "english");
  assert.match(prompt, /fix the parser/);
  // 关键取舍：用户给的 message 要按仓库风格重排，而不是原样落库。
  assert.match(prompt, /not necessarily as the literal message/);
  assert.match(prompt, /under 72 characters/);
  assert.throws(() => commitTaskPrompt({ kind: "message", message: "   " }, "english"));
});

test("paths target commits only the named files and rejects empty paths", () => {
  const prompt = commitTaskPrompt({ kind: "paths", paths: " src/parse.js " }, "english");
  assert.match(prompt, /src\/parse\.js/);
  assert.match(prompt, /nothing else/);
  assert.throws(() => commitTaskPrompt({ kind: "paths", paths: "   " }, "english"));
});

test("staged target forbids running git add again", () => {
  const prompt = commitTaskPrompt({ kind: "staged" }, "english");
  assert.match(prompt, /already staged/);
  assert.match(prompt, /Do not stage anything else/);
});

test("amend target records the explicit user request to lift the rubric ban", () => {
  const prompt = commitTaskPrompt({ kind: "amend" }, "english");
  assert.match(prompt, /--amend/);
  assert.match(prompt, /explicitly requested/);
  assert.match(prompt, /already been pushed/);
});

test("unknown target kind throws instead of silently building an empty prompt", () => {
  assert.throws(() => commitTaskPrompt({ kind: "nope" }, "english"));
  assert.throws(() => commitTaskPrompt(undefined, "english"));
});

test("userFacingHint is used for transcript display", () => {
  assert.equal(userFacingHint({ kind: "default" }), "current changes");
  assert.equal(userFacingHint({ kind: "message", message: " fix parser " }), "fix parser");
  assert.equal(userFacingHint({ kind: "paths", paths: " src/a.js " }), "src/a.js");
  assert.equal(userFacingHint({ kind: "staged" }), "staged changes");
  assert.equal(userFacingHint({ kind: "amend" }), "amend of the last commit");
  assert.equal(userFacingHint(undefined), "current changes");
});

test("request joins the rubric with the target prompt and requires body output", () => {
  const request = buildCommitRequest("Create a single git commit.", "english");
  assert.ok(request.startsWith(COMMIT_RUBRIC));
  assert.match(request, /Create a single git commit\.$/);
  assert.match(request, /\*\*Verdict:\*\* committed/);
});

test("rubric keeps every upstream Git safety rule", () => {
  assert.match(COMMIT_RUBRIC, /NEVER update the git config/);
  assert.match(COMMIT_RUBRIC, /NEVER skip hooks/);
  assert.match(COMMIT_RUBRIC, /ALWAYS create a NEW commit/);
  assert.match(COMMIT_RUBRIC, /-i. flag/);
  assert.match(COMMIT_RUBRIC, /likely contain secrets/);
  assert.match(COMMIT_RUBRIC, /do not create an empty commit/);
});

test("rubric explicitly never pushes and never rewrites history", () => {
  // /commit 的边界就到提交为止：push 与历史改写都留给用户决定。
  assert.match(COMMIT_RUBRIC, /Do not push/);
  assert.match(COMMIT_RUBRIC, /Never force push, reset, rebase/);
});

test("/commit-push-pr uses its own rubric and requires the full release flow", () => {
  assert.notEqual(COMMIT_PUSH_PR_RUBRIC, COMMIT_RUBRIC);
  assert.doesNotMatch(COMMIT_PUSH_PR_RUBRIC, /This request ends at the commit/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /Push normally to `origin`/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /Never update git config/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /Never use any force option/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /## Summary/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /## Test plan/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /single turn/);
  // 远端不一定是 GitHub：rubric 必须给出各平台的等价命令，并且明确 gh 不是默认。
  assert.match(COMMIT_PUSH_PR_RUBRIC, /gh pr create/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /glab mr create/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /tea pr create/);
  assert.match(COMMIT_PUSH_PR_RUBRIC, /not with `gh` by default/);
  // 失败时不得声称 PR 已创建，只能报告 CLI 真的返回过的 URL。
  assert.match(COMMIT_PUSH_PR_RUBRIC, /a URL the CLI never printed is not/);
  // 与 /commit 一致：多行 message 必须走 heredoc，否则引号与换行会被 shell 吃掉。
  assert.match(COMMIT_PUSH_PR_RUBRIC, /cat <<'EOF'/);

  const request = buildCommitPushPrRequest("## Your task", "english");
  assert.ok(request.startsWith(COMMIT_PUSH_PR_RUBRIC));
  assert.match(request, /\*\*Verdict:\*\* pull request created/);
});

test("rubric keeps the upstream core requirements for the message wording", () => {
  assert.match(COMMIT_RUBRIC, /WHY the change was made/);
  assert.match(COMMIT_RUBRIC, /under 72 characters/);
  assert.match(COMMIT_RUBRIC, /Never write a generic message/);
  // miro 不接署名开关，因此这里明确禁止。
  assert.match(COMMIT_RUBRIC, /Co-Authored-By/);
});

test("rubric commits via heredoc to preserve newlines and quotes", () => {
  assert.match(COMMIT_RUBRIC, /cat <<'EOF'/);
});

test("rubric priority wording does not depend on text order", () => {
  // AGENTS.md 由 AcpClient 作为首轮上下文注入，位置在 rubric 之前，
  // 因此 rubric 不能用顺序性表述，并且要显式提到 AGENTS.md 作为规范来源。
  assert.match(COMMIT_RUBRIC, /lowest precedence/);
  assert.match(COMMIT_RUBRIC, /regardless of whether it appears before or after/);
  assert.match(COMMIT_RUBRIC, /AGENTS\.md/);
});

test("every language provides the full set of commit prompt keys", () => {
  for (const id of LANGUAGE_IDS) {
    const bundle = commitPrompts(id);
    assert.ok(bundle.COMMIT_RUBRIC?.length > 0, `${id} is missing COMMIT_RUBRIC`);
    assert.ok(bundle.COMMIT_PUSH_PR_RUBRIC?.length > 0, `${id} is missing COMMIT_PUSH_PR_RUBRIC`);
    assert.ok(bundle.COMMIT_PUSH_PR_PROMPT?.length > 0, `${id} is missing COMMIT_PUSH_PR_PROMPT`);
    assert.match(bundle.COMMIT_PUSH_PR_PROMPT, /git checkout -b/, `${id} is missing the git checkout -b branch command`);
    assert.match(bundle.COMMIT_PUSH_PR_RUBRIC, /cat <<'EOF'/, `${id} is missing the heredoc commit`);
    // 每种语言都要点名各平台的 CLI，任何一门语言里都不能只剩 gh。
    for (const cli of ["gh pr create", "glab mr create", "tea pr create"]) {
      assert.match(bundle.COMMIT_PUSH_PR_RUBRIC, new RegExp(cli), `${id} is missing ${cli}`);
      assert.match(bundle.COMMIT_PUSH_PR_PROMPT, new RegExp(cli), `${id} is missing ${cli}`);
    }
    assert.ok(bundle.DEFAULT_PROMPT?.length > 0, `${id} is missing DEFAULT_PROMPT`);
    assert.ok(bundle.STAGED_ONLY_PROMPT?.length > 0, `${id} is missing STAGED_ONLY_PROMPT`);
    assert.ok(bundle.AMEND_PROMPT?.length > 0, `${id} is missing AMEND_PROMPT`);
    assert.ok(bundle.DIFF_TRUNCATED_NOTE?.length > 0, `${id} is missing DIFF_TRUNCATED_NOTE`);
    assert.equal(typeof bundle.messagePrompt, "function", `${id} is missing messagePrompt`);
    assert.equal(typeof bundle.pathsPrompt, "function", `${id} is missing pathsPrompt`);
    assert.equal(typeof bundle.contextSection, "function", `${id} is missing contextSection`);
    assert.equal(
      typeof bundle.publishTargetSection,
      "function",
      `${id} is missing publishTargetSection`
    );
  }
});

test("chinese rubric differs from english but keeps the same output skeleton", () => {
  const chinese = commitRubricFor("chinese");
  assert.notEqual(chinese, COMMIT_RUBRIC);
  assert.match(chinese, /提交准则/);
  // Verdict 行保持英文，两种语言渲染结果一致。
  assert.match(chinese, /\*\*Verdict:\*\* committed/);
});

test("unknown language falls back to the default english rubric", () => {
  assert.equal(commitRubricFor("klingon"), COMMIT_RUBRIC);
  assert.equal(commitRubricFor(undefined), COMMIT_RUBRIC);
  assert.equal(commitPushPrRubricFor("klingon"), COMMIT_PUSH_PR_RUBRIC);
  assert.equal(commitPushPrRubricFor(undefined), COMMIT_PUSH_PR_RUBRIC);
});

test("argument routing: keywords first, then paths, everything else becomes a message", () => {
  assert.deepEqual(parseCommitArgs(""), { kind: "default" });
  assert.deepEqual(parseCommitArgs("   "), { kind: "default" });
  assert.deepEqual(parseCommitArgs(null), { kind: "default" });
  assert.deepEqual(parseCommitArgs("staged"), { kind: "staged" });
  assert.deepEqual(parseCommitArgs("--staged"), { kind: "staged" });
  assert.deepEqual(parseCommitArgs("STAGED"), { kind: "staged" });
  assert.deepEqual(parseCommitArgs("amend"), { kind: "amend" });
  assert.deepEqual(parseCommitArgs("--amend"), { kind: "amend" });
  assert.deepEqual(parseCommitArgs("src/parse.js"), { kind: "paths", paths: "src/parse.js" });
  assert.deepEqual(parseCommitArgs("src/a.js src/b.js"), {
    kind: "paths",
    paths: "src/a.js src/b.js",
  });
  // 自然语言兜底成 message，这是 /commit 最常见的带参用法。
  assert.deepEqual(parseCommitArgs("fix the parser"), {
    kind: "message",
    message: "fix the parser",
  });
  assert.deepEqual(parseCommitArgs("wip"), { kind: "message", message: "wip" });
});

test("diff truncation cuts on line boundaries and sets the flag", () => {
  const short = "line one\nline two\n";
  assert.deepEqual(truncateDiff(short), { text: short, truncated: false });

  // 每行 51 字节（50 个 a + 换行），按 120 切必然落在第三行中间。
  const line = "a".repeat(50);
  const long = `${line}\n`.repeat(40);
  const { text, truncated } = truncateDiff(long, 120);
  assert.equal(truncated, true);
  assert.ok(text.length <= 120);
  // 按行切的实质：结果里每一行都是完整的原始行，不能有被切半的残行。
  for (const row of text.split("\n")) {
    assert.equal(row, line, "the truncated diff must not contain a half-cut line");
  }

  // 没有换行可切时退化为按字符切，但仍要遵守上限。
  const noNewline = truncateDiff("a".repeat(200), 50);
  assert.equal(noNewline.truncated, true);
  assert.equal(noNewline.text.length, 50);

  assert.deepEqual(truncateDiff(null), { text: "", truncated: false });
  assert.ok(DIFF_LIMIT > 0);
});

test("git context reads the four fields and returns null outside a repository", async () => {
  const empty = await readCommitContext(mkdtempSync(path.join(tmpdir(), "miro-nogit-")));
  assert.equal(empty.status, null);
  assert.equal(empty.diff, null);
  assert.equal(empty.log, null);
  assert.equal(empty.remote, null);
});

test("context carries status, branch and recent commits when there are changes", async () => {
  const { dir } = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");

  const context = await readCommitContext(dir);
  assert.equal(context.branch, "main");
  assert.match(context.status, /a\.txt/);
  assert.match(context.diff, /\+two/);
  assert.match(context.log, /first commit/);
  assert.ok(LOG_LIMIT > 0);
});

test("staged target reads only the diff from the index", async () => {
  const { dir, run } = makeRepo();
  writeFileSync(path.join(dir, "staged.txt"), "staged\n");
  run(["add", "staged.txt"]);
  writeFileSync(path.join(dir, "loose.txt"), "loose\n");

  const staged = await readCommitContext(dir, { staged: true });
  assert.match(staged.diff, /staged/);
  assert.doesNotMatch(staged.diff, /\+loose/);
});

test("full prompt joins the git context with the task description", async () => {
  const { dir } = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");

  const prompt = await commitPrompt({ kind: "default" }, dir, "english");
  assert.match(prompt, /## Context/);
  assert.match(prompt, /Current branch/);
  assert.match(prompt, /Recent commits/);
  assert.match(prompt, /first commit/);
  // 任务描述在上下文之后，模型先读事实再读要求。
  assert.ok(prompt.indexOf("## Context") < prompt.indexOf("single git commit"));
  // /commit 到提交为止：发布目标块只属于 /commit-push-pr，不该出现在这里。
  assert.doesNotMatch(prompt, /## Publishing target/);
});

test("/commit-push-pr prompt pre-injects the git context required upstream", async () => {
  const { dir } = makeRepo();
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");

  const prompt = await commitPushPrPrompt(dir, "english");
  assert.match(prompt, /## Context/);
  assert.match(prompt, /Current branch/);
  assert.match(prompt, /Current git status/);
  assert.match(prompt, /Current git diff/);
  assert.match(prompt, /Create one new commit/);
  // `git checkout` 只有短形式 -b，写成 --branch 会让建分支这步直接失败。
  assert.match(prompt, /git checkout -b/);
  assert.doesNotMatch(prompt, /checkout --branch/);
  assert.match(prompt, /Push the current branch to `origin`/);
  assert.ok(prompt.indexOf("## Context") < prompt.indexOf("## Your task"));
  assert.ok(prompt.indexOf("## Publishing target") < prompt.indexOf("## Your task"));
});

// 远端托管平台决定建 PR 用哪条命令：非 GitHub 仓库上 `gh` 要么没装、要么
// 连不上那个服务器，因此必须从 origin 探测出来再注入提示词。
test("remote URLs resolve to a host", () => {
  assert.equal(parseRemoteHost("git@github.com:acme/repo.git"), "github.com");
  assert.equal(parseRemoteHost("https://gitlab.com/acme/repo.git"), "gitlab.com");
  assert.equal(parseRemoteHost("https://user@bitbucket.org/acme/repo.git"), "bitbucket.org");
  assert.equal(parseRemoteHost("ssh://git@git.example.com:2222/acme/repo.git"), "git.example.com");
  assert.equal(parseRemoteHost("https://GitLab.com/Acme/Repo"), "gitlab.com");
  assert.equal(parseRemoteHost(""), null);
  assert.equal(parseRemoteHost(null), null);
  assert.equal(parseRemoteHost("not a url"), null);
});

test("forge detection covers the hosted services, self-hosted domains, and unknown hosts", () => {
  assert.equal(detectForge("git@github.com:acme/repo.git"), "github");
  // GitHub Enterprise / 自建 GitLab 的域名里带同样的字样，不能只认官方域名。
  assert.equal(detectForge("git@github.acme.com:acme/repo.git"), "github");
  assert.equal(detectForge("https://gitlab.com/acme/repo.git"), "gitlab");
  assert.equal(detectForge("https://gitlab.acme.com/acme/repo.git"), "gitlab");
  assert.equal(detectForge("git@codeberg.org:acme/repo.git"), "gitea");
  assert.equal(detectForge("https://forgejo.acme.com/acme/repo.git"), "gitea");
  assert.equal(detectForge("https://bitbucket.org/acme/repo.git"), "bitbucket");
  assert.equal(detectForge("git@git.acme.com:acme/repo.git"), "unknown");
  assert.equal(detectForge(null), null);
});

test("pull request CLI detection only reports executables on PATH", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "miro-cli-"));
  writeFileSync(path.join(dir, "glab"), "#!/bin/sh\n", { mode: 0o755 });
  // 只是个普通文件：同名的非可执行文件不算「可用」。
  writeFileSync(path.join(dir, "gh"), "", { mode: 0o644 });
  // 同名目录也带 x 位，但不是一个能跑的命令。
  mkdirSync(path.join(dir, "tea"));

  assert.deepEqual(availableForgeClis({ pathEnv: dir }), ["glab"]);
  assert.deepEqual(availableForgeClis({ pathEnv: "" }), []);
  assert.deepEqual(availableForgeClis({ pathEnv: dir, exists: () => false }), []);
});

test("publishTarget pairs the remote with the CLI for its host", () => {
  const target = publishTarget({ remote: "git@gitlab.com:acme/repo.git" }, ["glab"]);
  assert.deepEqual(target, {
    remote: "git@gitlab.com:acme/repo.git",
    host: "gitlab.com",
    forge: "gitlab",
    cli: "glab",
    clis: ["glab"],
  });
  // Bitbucket 没有官方 CLI：cli 为 null，提示词据此改成手动回落。
  const bitbucket = publishTarget({ remote: "https://bitbucket.org/acme/repo.git" }, []);
  assert.equal(bitbucket.cli, null);
  assert.equal(bitbucket.forge, "bitbucket");
  assert.equal(publishTarget({ remote: null }, []).host, null);
  assert.equal(publishTarget(undefined, []).remote, null);
});

test("a gitlab remote makes /commit-push-pr pick glab instead of assuming gh", async () => {
  const { dir } = makeRepo({ remote: "git@gitlab.com:acme/repo.git" });
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");

  const prompt = await commitPushPrPrompt(dir, "english");
  assert.match(prompt, /- Origin remote: git@gitlab\.com:acme\/repo\.git/);
  assert.match(prompt, /- Host: gitlab\.com \(GitLab\)/);
  assert.match(prompt, /- Pull request CLI for this host: `glab`/);
  assert.match(prompt, /glab mr create/);
  assert.match(prompt, /Never reaching for `gh` by reflex/);
});

test("an unrecognised host and a missing origin remote both degrade explicitly", async () => {
  const unknown = makeRepo({ remote: "git@git.acme.com:acme/repo.git" });
  const unknownPrompt = await commitPushPrPrompt(unknown.dir, "english");
  assert.match(unknownPrompt, /unrecognised hosting provider/);
  assert.match(unknownPrompt, /this provider has no first-class CLI/);

  const bare = makeRepo();
  const barePrompt = await commitPushPrPrompt(bare.dir, "english");
  assert.match(barePrompt, /## Publishing target/);
  assert.match(barePrompt, /No `origin` remote is configured/);
  // 没有远端时不能留空让模型自己编一个。
  assert.doesNotMatch(barePrompt, /Origin remote:/);

  // 本地路径形式的远端：解析不出平台，但也不能被当成“没远端”。
  const local = makeRepo({ remote: "/srv/git/repo.git" });
  const localPrompt = await commitPushPrPrompt(local.dir, "english");
  assert.match(localPrompt, /- Origin remote: \/srv\/git\/repo\.git/);
  assert.match(localPrompt, /not a remote URL/);
});

test("chinese publish target is translated and keeps the same facts", async () => {
  const { dir } = makeRepo({ remote: "git@gitlab.com:acme/repo.git" });
  const prompt = await commitPushPrPrompt(dir, "chinese");
  assert.match(prompt, /## 发布目标/);
  assert.match(prompt, /托管平台：gitlab\.com（GitLab）/);
  assert.match(prompt, /该平台的拉取请求 CLI：`glab`/);
  assert.match(prompt, /glab mr create/);
});

test("the expected CLI and the CLIs actually on PATH are both stated", () => {
  const section = commitPrompts("english").publishTargetSection({
    remote: "git@gitlab.com:acme/repo.git",
    host: "gitlab.com",
    forge: "gitlab",
    cli: "glab",
    clis: ["gh"],
  });
  assert.match(section, /- Pull request CLI for this host: `glab`/);
  assert.match(section, /- Found on PATH: `gh`/);
  // 预期 CLI 与 PATH 对不上时要说清楚，否则模型会照旧去跑 gh。
  assert.match(section, /`glab` is not installed here/);
  assert.match(section, /report the URL for opening the pull request by hand/);

  const present = commitPrompts("english").publishTargetSection({
    remote: "https://github.com/acme/repo.git",
    host: "github.com",
    forge: "github",
    cli: "gh",
    clis: ["gh"],
  });
  assert.doesNotMatch(present, /is not installed here/);
});

test("every language renders the same publish target facts", () => {
  for (const id of LANGUAGE_IDS) {
    const section = commitPrompts(id).publishTargetSection({
      remote: "git@gitlab.com:a/b.git",
      host: "gitlab.com",
      forge: "gitlab",
      cli: "glab",
      clis: [],
    });
    assert.match(section, /git@gitlab\.com:a\/b\.git/, `${id} drops the remote`);
    assert.match(section, /gitlab\.com/, `${id} drops the host`);
    assert.match(section, /`glab`/, `${id} drops the expected CLI`);
    // 没有任何 CLI 可用时也要给出手动回落的说明，而不是留空。
    assert.ok(section.length > 60, `${id} renders an empty publish target`);

    // 没有 origin 远端：任何语言都必须明确停下而不是编一个远端。
    const missing = commitPrompts(id).publishTargetSection({ remote: null });
    assert.match(missing, /origin/, `${id} does not mention the missing origin remote`);
    assert.doesNotMatch(missing, /Origin remote:/, `${id} invents an origin remote`);
  }
});

test("staged change detection and the amend precheck", async () => {
  const { dir, run } = makeRepo();
  assert.equal(await hasStagedChanges(dir), false);
  assert.equal(await hasCommits(dir), true);

  writeFileSync(path.join(dir, "b.txt"), "two\n");
  run(["add", "b.txt"]);
  assert.equal(await hasStagedChanges(dir), true);

  const fresh = mkdtempSync(path.join(tmpdir(), "miro-fresh-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fresh, stdio: "pipe" });
  assert.equal(await hasCommits(fresh), false);
});
