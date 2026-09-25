import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { buildIgnoreFilter } from "./shared.js";

async function fixture(t, files, { repository = true } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "miro-search-ignore-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (repository) await mkdir(path.join(cwd, ".git"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), content);
  }
  return cwd;
}

async function assertSearch(cwd, expected, options = {}) {
  const glob = await globTool(cwd)({ pattern: "**/*.txt", ...options });
  const grep = await grepTool(cwd)({ pattern: "needle", glob: "**/*.txt", ...options });
  assert.equal(glob.error, undefined);
  assert.equal(grep.error, undefined);
  const sorted = [...expected].sort((a, b) => a.localeCompare(b));
  assert.equal(glob.output, sorted.join("\n") || "No files found matching pattern");
  assert.equal(grep.output, sorted.map((name) => `${name}:1: needle`).join("\n") || "No matches found");
}

test("搜索遵循文件模式、根锚点、目录规则与规则顺序", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "*.log\n/root-only/\ncache/\nsecret*.txt\n!secret-keep.txt\nordered.txt\n!ordered.txt\nordered.txt\n",
    "root-only/a.txt": "needle",
    "nested/root-only/a.txt": "needle",
    "cache/a.txt": "needle",
    "nested/cache/a.txt": "needle",
    "secret.txt": "needle",
    "secret-keep.txt": "needle",
    "ordered.txt": "needle",
    "visible.txt": "needle",
    "trace.log": "needle",
    "nested/trace.log": "needle",
  });
  await assertSearch(cwd, ["nested/root-only/a.txt", "secret-keep.txt", "visible.txt"]);
  assert.equal((await globTool(cwd)({ pattern: "**/*.log" })).output, "No files found matching pattern");
});

test("嵌套规则相对所在目录，且只覆盖本作用域", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "*.txt\n",
    "src/.gitignore": "!*.txt\n/local.txt\ncache/  \n",
    "src/local.txt": "needle",
    "src/deep/local.txt": "needle",
    "src/cache/a.txt": "needle",
    "src/deep/cache/a.txt": "needle",
    "src/keep.txt": "needle",
    "other/keep.txt": "needle",
  });
  await assertSearch(cwd, ["src/deep/local.txt", "src/keep.txt"]);
});

test("忽略目录不能靠内部规则救回，父目录反忽略后才继续递归", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "closed/\n!closed/keep.txt\nopened/\n!opened/\n",
    "closed/.gitignore": "!*.txt\n",
    "closed/keep.txt": "needle",
    "opened/.gitignore": "*.txt\n!keep.txt\n",
    "opened/keep.txt": "needle",
    "opened/hide.txt": "needle",
    "visible.txt": "needle",
  });
  await assertSearch(cwd, ["opened/keep.txt", "visible.txt"]);
  await assertSearch(cwd, [], { path: "closed" });
});

test("基线目录可被反忽略且只过滤目录，VCS 不可反忽略", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "!dist/\n!.git/\n!.svn/\n",
    "dist/a.txt": "needle",
    "nested/dist/a.txt": "needle",
    "node_modules/a.txt": "needle",
    "nested/target/a.txt": "needle",
    ".git/a.txt": "needle",
    ".svn/a.txt": "needle",
    "build": "needle",
    "visible.txt": "needle",
  });
  await assertSearch(cwd, ["dist/a.txt", "nested/dist/a.txt", "visible.txt"]);
  assert.equal((await globTool(cwd)({ pattern: "build" })).output, "build");
  await assertSearch(cwd, [], { path: ".git" });
  await assertSearch(cwd, [], { path: ".svn" });
});

test("子目录搜索继承仓库父级规则但不越过仓库边界", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "*.txt\n",
    "repo/.git": "gitdir: elsewhere\n",
    "repo/.gitignore": "*.log\n/src/skip.txt\n",
    "repo/src/skip.txt": "needle",
    "repo/src/keep.txt": "needle",
    "repo/src/a.log": "needle",
  });
  const subdir = path.join(cwd, "repo/src");
  await assertSearch(subdir, ["keep.txt"]);
  assert.equal((await globTool(subdir)({ pattern: "*.log" })).output, "No files found matching pattern");
});

test("非仓库搜索继承 cwd 的规则但不会读取工作区外的规则", async (t) => {
  // 部分开发环境把整个临时目录放进仓库，此时无法构造非仓库前提。
  for (let dir = path.resolve(os.tmpdir()); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return t.skip("临时目录位于 Git 仓库内");
    if (dir === path.dirname(dir)) break;
  }
  const cwd = await fixture(t, {
    ".gitignore": "*.txt\n",
    "workspace/.gitignore": "hidden.txt\n",
    "workspace/src/hidden.txt": "needle",
    "workspace/src/visible.txt": "needle",
  }, { repository: false });
  await assertSearch(path.join(cwd, "workspace"), ["visible.txt"], { path: "src" });
});

test("转义字符、双星号和大小写按 gitignore 语义匹配", async (t) => {
  const cwd = await fixture(t, {
    "src/.gitignore": "\\#hidden.txt\n\\!hidden.txt\nspace\\ .txt\ngenerated/**/*.txt\nUPPER.txt\n",
    "src/#hidden.txt": "needle",
    "src/!hidden.txt": "needle",
    "src/space .txt": "needle",
    "src/generated/a.txt": "needle",
    "src/generated/deep/a.txt": "needle",
    "src/UPPER.txt": "needle",
    "src/upper.txt": "needle",
    "src/visible.txt": "needle",
  });
  await assertSearch(cwd, ["src/upper.txt", "src/visible.txt"]);
});

test("作用域目录名中的 glob 字符不能成为规则通配符", async (t) => {
  const cwd = await fixture(t, {
    "pkg[1]/.gitignore": "hidden.txt\n",
    "pkg[1]/hidden.txt": "needle",
    "pkg[1]/visible.txt": "needle",
    "pkg1/hidden.txt": "needle",
  });
  await assertSearch(cwd, ["pkg[1]/visible.txt", "pkg1/hidden.txt"]);
});

test("单文件 grep 显式绕过忽略规则，符号链接的 ignore 文件不加载", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "hidden.txt\n",
    "hidden.txt": "needle",
    "rules": "visible.txt\n",
    "nested/visible.txt": "needle",
  });
  await symlink(path.join(cwd, "rules"), path.join(cwd, "nested/.gitignore"));
  await assertSearch(cwd, ["nested/visible.txt"]);
  assert.equal((await grepTool(cwd)({ pattern: "needle", path: "hidden.txt" })).output, "hidden.txt:1: needle");
});

test("完整路径过滤能兜住 glob 直接指定被忽略路径的情况", async (t) => {
  const cwd = await fixture(t, {
    ".gitignore": "ignored/\n",
    "ignored/a.txt": "needle",
    "visible.txt": "needle",
  });
  const filter = await buildIgnoreFilter(cwd);
  assert.equal(filter.isIgnoredPath("ignored/a.txt"), true);
  assert.equal(filter.isIgnoredPath("visible.txt"), false);
  assert.equal((await globTool(cwd)({ pattern: "ignored/a.txt" })).output, "No files found matching pattern");
});
