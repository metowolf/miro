import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  MAX_FRONTMATTER_BYTES,
  expandSkillCommand,
  formatSkillsForPrompt,
  loadSkills,
  parseSkillCommand,
  parseSkillFrontmatter,
  skillRoots,
  skillsFromSettings,
} from "./skills.js";

function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/** 一个假的 home + 仓库目录，避免读到真实 ~/.miro。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "miro-skills-"));
  const home = join(dir, "home");
  const cwd = join(dir, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { dir, home, cwd };
}

const skillDoc = (name, description, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`;

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

test("parses simple frontmatter and strips the body", () => {
  const parsed = parseSkillFrontmatter("---\nname: pdf\ndescription: Work with PDFs.\n---\n\nDo the thing.\n");
  assert.equal(parsed.present, true);
  assert.equal(parsed.data.name, "pdf");
  assert.equal(parsed.data.description, "Work with PDFs.");
  assert.equal(parsed.body, "Do the thing.");
});

test("file without frontmatter is marked present=false", () => {
  const parsed = parseSkillFrontmatter("# Just a doc\n\ntext\n");
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, "# Just a doc\n\ntext");
});

test("broken frontmatter (no closing delimiter) is treated as having no metadata", () => {
  const parsed = parseSkillFrontmatter("---\nname: pdf\ndescription: x\n");
  assert.equal(parsed.present, false);
});

test("folded scalar > becomes spaces, literal scalar | keeps newlines", () => {
  const folded = parseSkillFrontmatter("---\ndescription: >\n  one\n  two\n\n  three\n---\nbody\n");
  assert.equal(folded.data.description, "one two\nthree\n");

  const literal = parseSkillFrontmatter("---\ndescription: |\n  one\n  two\n---\nbody\n");
  assert.equal(literal.data.description, "one\ntwo\n");
});

test("scalars support quotes, comments and booleans", () => {
  const parsed = parseSkillFrontmatter([
    "---",
    'description: "a: b # not a comment"',
    "name: pdf # trailing comment",
    "disable-model-invocation: true",
    "---",
    "body",
  ].join("\n"));
  assert.equal(parsed.data.description, "a: b # not a comment");
  assert.equal(parsed.data.name, "pdf");
  assert.equal(parsed.data["disable-model-invocation"], true);
});

test("nested keys do not leak into the top level", () => {
  const parsed = parseSkillFrontmatter("---\nmetadata:\n  foo: bar\ndescription: ok\n---\nbody\n");
  assert.equal(parsed.data.description, "ok");
  assert.equal(parsed.data.foo, undefined);
});

test("oversized frontmatter is flagged as tooLarge", () => {
  const parsed = parseSkillFrontmatter(`---\ndescription: ${"x".repeat(MAX_FRONTMATTER_BYTES + 1)}\n---\nbody\n`);
  assert.equal(parsed.tooLarge, true);
});

test("CRLF and BOM do not affect parsing", () => {
  const parsed = parseSkillFrontmatter("\uFEFF---\r\nname: pdf\r\ndescription: Work with PDFs.\r\n---\r\n\r\nBody.\r\n");
  assert.equal(parsed.present, true);
  assert.equal(parsed.data.name, "pdf");
  assert.equal(parsed.body, "Body.");
});

test("标准 YAML 支持 Unicode 转义、单引号转义和 flow mapping", () => {
  const parsed = parseSkillFrontmatter(String.raw`---
name: 'it''s-a-skill'
description: "\u4F60\u597D\nworld"
metadata: {owner: team, tags: [one, two]}
---
body`);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.name, "it's-a-skill");
  assert.equal(parsed.data.description, "你好\nworld");
  assert.deepEqual(parsed.data.metadata, { owner: "team", tags: ["one", "two"] });
});

test("块标量保留额外缩进、chomping 和缩进的分隔符", () => {
  const folded = parseSkillFrontmatter("---\ndescription: >-\n  one\n    indented\n  two\n---\nbody");
  assert.equal(folded.data.description, "one\n  indented\ntwo");
  const literal = parseSkillFrontmatter("---\ndescription: |+\n  one\n  ---\n  ...\n\n...\nbody");
  assert.equal(literal.data.description, "one\n---\n...\n\n");
  assert.equal(literal.body, "body");
});

test("空 frontmatter 仍是缺少字段的元数据而非解析失败", () => {
  for (const raw of ["", "# comment", "{}"]) {
    const parsed = parseSkillFrontmatter(`---\n${raw}\n---\nbody`);
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.data, {});
    assert.equal(parsed.present, true);
  }
});

test("普通标量别名可用，但嵌套别名展开有上限", () => {
  const parsed = parseSkillFrontmatter("---\nsummary: &summary Shared description\ndescription: *summary\n---\nbody");
  assert.equal(parsed.data.description, "Shared description");
  const refs = (name) => Array(10).fill(`*${name}`).join(", ");
  const bomb = parseSkillFrontmatter(`---\na: &a [text]\nb: &b [${refs("a")}]\nc: &c [${refs("b")}]\ndescription: ok\n---\nbody`);
  assert.match(bomb.error, /alias count/i);
  assert.deepEqual(bomb.data, {});
});

test("非法语法、重复键、非 mapping 根节点和不支持的标签返回解析错误", () => {
  for (const raw of [
    'description: "unterminated',
    "description: [unterminated",
    "description: first\ndescription: second",
    "name: pdf\nthis is not a mapping entry",
    "[one, two]",
    "scalar",
    "null",
    "description: !custom value",
    "description: !!js/function function() {}",
    "description: !!timestamp 2026-01-01",
    "description: *missing",
    "? [one, two]\n: value",
  ]) {
    const parsed = parseSkillFrontmatter(`---\n${raw}\n---\nbody`);
    assert.ok(parsed.error, raw);
    assert.equal(parsed.present, true);
    assert.deepEqual(parsed.data, {});
    assert.equal(parsed.body, "body");
  }
});

test("YAML 的特殊键不能改写对象原型", () => {
  const parsed = parseSkillFrontmatter("---\n__proto__: {description: injected}\nconstructor: value\n---\nbody");
  assert.equal(parsed.error, undefined);
  assert.equal(Object.getPrototypeOf(parsed.data), Object.prototype);
  assert.equal(parsed.data.description, undefined);
  assert.equal(Object.hasOwn(parsed.data, "__proto__"), true);
});

test("frontmatter 上限按 UTF-8 字节计算", () => {
  const parsed = parseSkillFrontmatter(`---\ndescription: ${"你".repeat(MAX_FRONTMATTER_BYTES / 2)}\n---\nbody`);
  assert.equal(parsed.tooLarge, true);
});

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

test("default scan root order: user roots first, project roots next, explicit paths last", () => {
  const roots = skillRoots({ cwd: "/repo", home: "/home/u", extraPaths: ["~/extra", "rel", "", 42] });
  assert.deepEqual(roots.map((root) => root.dir), [
    "/home/u/.miro/skills",
    "/home/u/.agents/skills",
    "/repo/.miro/skills",
    "/repo/.agents/skills",
    "/home/u/extra",
    "/repo/rel",
  ]);
  assert.deepEqual(roots.map((root) => root.source), [
    "user", "user-shared", "project", "project-shared", "path", "path",
  ]);
});

test("a directory with SKILL.md is one skill, other md files inside it are not skills", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "pdf/SKILL.md": skillDoc("pdf", "Work with PDFs."),
    "pdf/references/notes.md": "---\nname: notes\ndescription: not a skill\n---\nbody\n",
  });
  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["pdf"]);
  assert.equal(skills[0].filePath, join(home, ".miro", "skills", "pdf", "SKILL.md"));
  assert.equal(skills[0].baseDir, join(home, ".miro", "skills", "pdf"));
  assert.equal(skills[0].source, "user");
  assert.deepEqual(diagnostics, []);
});

test("SKILL.md nested in grouped directories is found recursively", () => {
  const { home, cwd } = sandbox();
  writeTree(join(cwd, ".miro", "skills"), { "team/deploy/SKILL.md": skillDoc("deploy", "Ship it.") });
  const { skills } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["deploy"]);
  assert.equal(skills[0].source, "project");
});

test("bare .md needs its own description to count as a skill", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "quick.md": "---\nname: quick\ndescription: A one-file skill.\n---\nbody\n",
    "README.md": "# Skills\n\nno frontmatter here\n",
  });
  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["quick"]);
  assert.deepEqual(diagnostics, []);
});

test("SKILL.md missing description is skipped and leaves a diagnostic", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "broken/SKILL.md": "---\nname: broken\n---\nbody\n",
    "bare/SKILL.md": "# no frontmatter\n",
  });
  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills, []);
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["missing-frontmatter", "missing-description"]);
});

test("hidden directories and node_modules are not scanned, symlinks are followed", () => {
  const { dir, home, cwd } = sandbox();
  const real = join(dir, "shared-skills");
  writeTree(real, { "linked/SKILL.md": skillDoc("linked", "Shared via symlink.") });
  writeTree(join(home, ".miro", "skills"), {
    ".hidden/SKILL.md": skillDoc("hidden", "Should be skipped."),
    "node_modules/pkg/SKILL.md": skillDoc("dep", "Should be skipped."),
  });
  symlinkSync(real, join(home, ".miro", "skills", "shared"), "dir");

  const { skills } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["linked"]);
});

test("self-referencing symlink does not make the scan recurse forever", () => {
  const { home, cwd } = sandbox();
  const root = join(home, ".miro", "skills");
  writeTree(root, { "loop/SKILL.md": skillDoc("loop", "Self referencing.") });
  symlinkSync(root, join(root, "again"), "dir");

  const { skills } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["loop"]);
});

test("same-name skill is overridden by the later source and logs a collision diagnostic", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "User version.") });
  writeTree(join(cwd, ".miro", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "Project version.") });

  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["pdf"]);
  assert.equal(skills[0].description, "Project version.");
  assert.equal(skills[0].source, "project");
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["name-collision"]);
});

test("project roots override all user roots", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "User miro version.") });
  writeTree(join(home, ".agents", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "User shared version.") });
  writeTree(join(cwd, ".miro", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "Project miro version.") });

  const { skills } = loadSkills({ cwd, home });
  assert.equal(skills[0].description, "Project miro version.");
  assert.equal(skills[0].source, "project");
});

test("invalid name or over-long description only warns and does not drop the skill", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "loud/SKILL.md": skillDoc("Loud Name", "x".repeat(1025)),
  });
  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["Loud Name"]);
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["invalid-name", "description-too-long"]);
});

test("exceeding maxSkills keeps only the first scanned skills and records a diagnostic", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "a/SKILL.md": skillDoc("a", "First."),
    "b/SKILL.md": skillDoc("b", "Second."),
  });
  const { skills, diagnostics } = loadSkills({ cwd, home, maxSkills: 1 });
  assert.deepEqual(skills.map((skill) => skill.name), ["a"]);
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["too-many-skills"]);
});

test("missing directories return an empty result instead of throwing", () => {
  const { home, cwd } = sandbox();
  assert.deepEqual(loadSkills({ cwd, home }), { skills: [], diagnostics: [] });
});

test("settings.skills appends paths and false disables skills entirely", () => {
  assert.deepEqual(skillsFromSettings({ skills: ["/tmp/skills"] }), { disabled: false, paths: ["/tmp/skills"] });
  assert.deepEqual(skillsFromSettings({ skills: "nope" }), { disabled: false, paths: [] });
  assert.deepEqual(skillsFromSettings({ skills: false }), { disabled: true, paths: [] });
  assert.deepEqual(skillsFromSettings(null), { disabled: false, paths: [] });
});

test("skill in an explicit path can override the default roots", () => {
  const { dir, home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "User version.") });
  const extra = join(dir, "extra-skills");
  writeTree(extra, { "pdf/SKILL.md": skillDoc("pdf", "Explicit version.") });

  const { skills } = loadSkills({ cwd, home, extraPaths: [extra] });
  assert.deepEqual(skills.map((skill) => skill.name), ["pdf"]);
  assert.equal(skills[0].description, "Explicit version.");
  assert.equal(skills[0].source, "path");
});

test("扫描跳过无效 YAML 并记录诊断，不影响其他有效 skill", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "broken/SKILL.md": "---\ndescription: one\ndescription: two\n---\nbody",
    "invalid.md": "---\ndescription: !custom value\n---\nbody",
    "valid/SKILL.md": "---\nname: valid\ndescription: >\n  one\n  two\n---\nbody",
  });
  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => [skill.name, skill.description]), [["valid", "one two"]]);
  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, "invalid-frontmatter");
    assert.ok(diagnostic.path);
    assert.match(diagnostic.message, /invalid YAML frontmatter/);
  }
});

test("标准 YAML 类型仍受 Skill 字段校验约束", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "numeric/SKILL.md": skillDoc("numeric", "123"),
    "boolean/SKILL.md": skillDoc("boolean", "true"),
    "mapping/SKILL.md": skillDoc("mapping", "{text: content}"),
    "quoted/SKILL.md": skillDoc("quoted", '"123"', 'disable-model-invocation: "true"\n'),
  });
  const { skills, diagnostics } = loadSkills({ cwd, home });
  assert.deepEqual(skills.map((skill) => skill.name), ["quoted"]);
  assert.equal(skills[0].description, "123");
  assert.equal(skills[0].disableModelInvocation, false);
  assert.deepEqual(diagnostics.map((entry) => entry.code), Array(3).fill("missing-description"));
});

// ---------------------------------------------------------------------------
// 注入与展开
// ---------------------------------------------------------------------------

test("catalog format and XML escaping", () => {
  const text = formatSkillsForPrompt([
    { name: "pdf", description: 'Use <b> & "quotes".', filePath: "/s/pdf/SKILL.md" },
  ]);
  assert.ok(text.includes("<available_skills>"));
  assert.ok(text.includes("<name>pdf</name>"));
  assert.ok(text.includes("<description>Use &lt;b&gt; &amp; &quot;quotes&quot;.</description>"));
  assert.ok(text.includes("<location>/s/pdf/SKILL.md</location>"));
  // 正文不进目录：渐进式披露靠模型自己 read_file。
  assert.ok(!text.includes("Body of"));
  assert.equal(formatSkillsForPrompt([]), "");
});

test("disable-model-invocation skills stay out of the catalog", () => {
  const text = formatSkillsForPrompt([
    { name: "public", description: "可见", filePath: "/s/a/SKILL.md" },
    { name: "secret", description: "不可见", filePath: "/s/b/SKILL.md", disableModelInvocation: true },
  ]);
  assert.ok(text.includes("<name>public</name>"));
  assert.ok(!text.includes("secret"));
});

test("parseSkillCommand only accepts /skill:<name>", () => {
  assert.deepEqual(parseSkillCommand("/skill:pdf"), { name: "pdf", args: null });
  assert.deepEqual(parseSkillCommand("/skill:pdf extract page 3"), { name: "pdf", args: "extract page 3" });
  assert.equal(parseSkillCommand("/skill:"), null);
  assert.equal(parseSkillCommand("/skills"), null);
  assert.equal(parseSkillCommand("please run /skill:pdf"), null);
});

test("expands /skill:<name> into a <skill> block, keeping args and multi-line body", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs.\n---\n\nStep one.\nStep two.\n",
  });
  const { skills } = loadSkills({ cwd, home });

  const expanded = expandSkillCommand("/skill:pdf extract page 3", skills);
  assert.ok(expanded.startsWith(`<skill name="pdf" location="${join(home, ".miro", "skills", "pdf", "SKILL.md")}">`));
  assert.ok(expanded.includes(`References are relative to ${join(home, ".miro", "skills", "pdf")}.`));
  assert.ok(expanded.includes("Step one.\nStep two."));
  assert.ok(!expanded.includes("description: Work with PDFs."));
  assert.ok(expanded.endsWith("extract page 3"));
});

test("unknown skill, plain text or unreadable body returns null for the caller to send as-is", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), { "pdf/SKILL.md": skillDoc("pdf", "Work with PDFs.") });
  const { skills } = loadSkills({ cwd, home });

  assert.equal(expandSkillCommand("/skill:nope", skills), null);
  assert.equal(expandSkillCommand("hello", skills), null);
  assert.equal(expandSkillCommand("/skill:pdf", []), null);
  assert.equal(expandSkillCommand("/skill:pdf", [{ name: "pdf", filePath: join(cwd, "missing", "SKILL.md") }]), null);
});

test("disable-model-invocation skills can still be pulled in via /skill:", () => {
  const { home, cwd } = sandbox();
  writeTree(join(home, ".miro", "skills"), {
    "internal/SKILL.md": skillDoc("internal", "Only by hand.", "disable-model-invocation: true\n"),
  });
  const { skills } = loadSkills({ cwd, home });
  assert.equal(formatSkillsForPrompt(skills), "");
  assert.ok(expandSkillCommand("/skill:internal", skills).includes("Body of internal."));
});

test("发现后元数据变坏或超限时不再展开 Skill", () => {
  const { home, cwd } = sandbox();
  const root = join(home, ".miro", "skills");
  writeTree(root, { "pdf/SKILL.md": skillDoc("pdf", "Work with PDFs.") });
  const { skills } = loadSkills({ cwd, home });
  for (const text of [
    '---\ndescription: "unterminated\n---\nbody',
    `---\ndescription: ${"x".repeat(MAX_FRONTMATTER_BYTES + 1)}\n---\nbody`,
    "# No frontmatter",
  ]) {
    writeTree(root, { "pdf/SKILL.md": text });
    assert.equal(expandSkillCommand("/skill:pdf args", skills), null);
  }
});
