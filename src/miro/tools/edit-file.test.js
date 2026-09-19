import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { editFileTool } from "./edit-file.js";

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "miro-edit-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, name, content) {
  const dir = await workspace(t);
  const path = join(dir, name);
  await writeFile(path, content);
  return { dir, path, edit: editFileTool(dir) };
}

test("applies multiple non-overlapping edits against the original text", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "one\ntwo\nthree\n");
  const result = await edit({
    path: "sample.txt",
    edits: [
      { oldText: "one", newText: "ONE" },
      { oldText: "three", newText: "THREE" },
    ],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "ONE\ntwo\nTHREE\n");
  assert.match(result.output, /Replaced 2 blocks/);
});

test("reports duplicate exact matches with their count and line numbers", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "value\nother\nvalue\n");
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "value", newText: "next" }] });

  assert.match(result.error, /appears 2 matches at lines 1, 3/);
  assert.equal(await Bun.file(path).text(), "value\nother\nvalue\n");
});

test("rejects missing, empty, and overlapping edits without writing", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "abcdef\n");

  assert.match((await edit({ path: "sample.txt", edits: [{ oldText: "missing", newText: "x" }] })).error, /not found/);
  assert.match((await edit({ path: "sample.txt", edits: [{ oldText: "", newText: "x" }] })).error, /must not be empty/);
  assert.match(
    (await edit({
      path: "sample.txt",
      edits: [{ oldText: "abc", newText: "A" }, { oldText: "bcd", newText: "B" }],
    })).error,
    /overlap/,
  );
  assert.equal(await Bun.file(path).text(), "abcdef\n");
});

test("uses line-trimmed matching only when it identifies one complete line block", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "function run() {\n    return 1;   \n}\n");
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: "function run() {\n  return 1;\n}", newText: "function run() {\n  return 2;\n}" }],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "function run() {\n  return 2;\n}\n");
  assert.match(result.output, /1 via line-trimmed match/);
});

test("rejects ambiguous line-trimmed matches without writing", async (t) => {
  const original = "  value  \n  next  \n\n    value\n    next\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "value\nnext", newText: "changed" }] });

  assert.match(result.error, /line-trimmed matching found 2 matches at lines 1-2, 4-5/);
  assert.equal(await Bun.file(path).text(), original);
});

test("uses normalized matching for smart punctuation and special spaces", async (t) => {
  const original = "label:\u00a0“alpha—beta”\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: 'label: "alpha-beta"', newText: 'label: "changed"' }],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), 'label: "changed"\n');
  assert.match(result.output, /1 via normalized match/);
});

test("maps NFKC full-width spans back without rewriting unrelated text", async (t) => {
  const original = "before ＡＢＣ after\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "ABC", newText: "XYZ" }] });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "before XYZ after\n");
});

test("rejects normalized matches whose widened span would swallow an extra compatibility character", async (t) => {
  const original = "ﬁx\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "ix", newText: "ok" }] });

  assert.match(result.error, /not found/);
  assert.equal(await Bun.file(path).text(), original);
});

test("rejects ambiguous normalized matches even when replaceAll is set", async (t) => {
  const original = "“value”\n„value‟\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: '\"value\"', newText: "changed", replaceAll: true }],
  });

  assert.match(result.error, /normalized matching found 2 matches/);
  assert.equal(await Bun.file(path).text(), original);
});

test("preserves UTF-8 BOM and CRLF line endings", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", Buffer.from("\ufefffirst\r\nsecond\r\n", "utf8"));
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "first\nsecond", newText: "first\nchanged" }] });

  assert.equal(result.error, undefined);
  assert.deepEqual(await readFile(path), Buffer.from("\ufefffirst\r\nchanged\r\n", "utf8"));
});

test("atomic replacement preserves the original file permissions and leaves no temporary file", async (t) => {
  const { dir, path, edit } = await fixture(t, "sample.txt", "before\n");
  await chmod(path, 0o744);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "before", newText: "after" }] });

  assert.equal(result.error, undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o744);
  assert.equal((await readdir(dir)).some((name) => name.startsWith(".miro-edit-")), false);
});

test("replaceAll rewrites every occurrence and reports the total", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "a b a a\n");
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: "a", newText: "x", replaceAll: true }],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "x b x x\n");
  assert.match(result.output, /Replaced 3 blocks/);
});

test("rejects a non-unique oldText unless replaceAll is set", async (t) => {
  const original = "a b a\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "a", newText: "x" }] });

  assert.match(result.error, /appears 2 matches/);
  assert.match(result.error, /set replaceAll: true/);
  assert.equal(await Bun.file(path).text(), original);
});

test("treats newText literally, without regex replacement semantics", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "alpha beta\n");
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: "beta", newText: "$& $$ $` $'" }],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "alpha $& $$ $` $'\n");
});

test("makes no write when the replacement leaves the content identical", async (t) => {
  const original = "unchanged\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "unchanged", newText: "unchanged" }] });

  assert.equal(result.error, undefined);
  assert.match(result.output, /No changes to make/);
  assert.equal(await Bun.file(path).text(), original);
});

test("preserves mixed line endings outside the edited span", async (t) => {
  const original = "alpha\r\nbeta\ngamma\r\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: "alpha\nbeta", newText: "one\ntwo" }],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "one\r\ntwo\ngamma\r\n");
});

test("leaves an unrelated mixed-ending file untouched by a small edit", async (t) => {
  const original = "alpha\r\nbeta\ngamma\r\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "beta", newText: "BETA" }] });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "alpha\r\nBETA\ngamma\r\n");
});

test("keeps a lone carriage return as content instead of turning it into a newline", async (t) => {
  const original = "a\rb\nc\n";
  const { path, edit } = await fixture(t, "sample.txt", original);
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "a\rb", newText: "a\rB" }] });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "a\rB\nc\n");
});

test("rejects a non-UTF-8 file and leaves its bytes untouched", async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "sample.txt");
  const original = Buffer.from([0x68, 0x69, 0x20, 0xff, 0x0a]);
  await writeFile(path, original);

  const result = await editFileTool(dir)({ path: "sample.txt", edits: [{ oldText: "hi", newText: "yo" }] });

  assert.match(result.error, /not valid UTF-8/);
  assert.deepEqual(await readFile(path), original);
});

test("rejects a binary file with NUL bytes", async (t) => {
  const { path, edit } = await fixture(t, "sample.bin", Buffer.from("a\u0000b\n"));
  const result = await edit({ path: "sample.bin", edits: [{ oldText: "b", newText: "c" }] });

  assert.match(result.error, /binary/);
});

test("edits through a symlink without replacing the link itself", async (t) => {
  const dir = await workspace(t);
  const target = join(dir, "target.txt");
  const link = join(dir, "link.txt");
  await writeFile(target, "before\n");
  await symlink(target, link);

  const result = await editFileTool(dir)({ path: "link.txt", edits: [{ oldText: "before", newText: "after" }] });

  assert.equal(result.error, undefined);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await Bun.file(target).text(), "after\n");
});

test("replaceAll scans non-overlapping matches", async (t) => {
  const { path, edit } = await fixture(t, "sample.txt", "aaa\n");
  const result = await edit({
    path: "sample.txt",
    edits: [{ oldText: "aa", newText: "b", replaceAll: true }],
  });

  assert.equal(result.error, undefined);
  assert.equal(await Bun.file(path).text(), "ba\n");
  assert.match(result.output, /Replaced 1 block/);
});

test("suggests re-reading when oldText is missing", async (t) => {
  const { edit } = await fixture(t, "sample.txt", "present\n");
  const result = await edit({ path: "sample.txt", edits: [{ oldText: "absent", newText: "x" }] });

  assert.match(result.error, /not found/);
  assert.match(result.error, /read_file/);
});
