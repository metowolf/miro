import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";

import { readTool } from "./read-file.js";

async function fixture(files) {
  const cwd = await mkdtemp(nodePath.join(os.tmpdir(), "miro-read-"));
  await Promise.all(Object.entries(files).map(async ([name, content]) => {
    const path = nodePath.join(cwd, name);
    await mkdir(nodePath.dirname(path), { recursive: true });
    await writeFile(path, content);
  }));
  return cwd;
}

test("read_file reads numbered lines and continues with a zero-based offset", async () => {
  const cwd = await fixture({ "a.txt": "one\ntwo\nthree\n" });
  const read = readTool(cwd);
  const first = await read({ path: "a.txt", limit: 2 });
  assert.match(first.output, /1→one\n2→two/);
  assert.match(first.output, /use offset=2/);
  const second = await read({ path: "a.txt", offset: 2 });
  assert.match(second.output, /3→three/);
  assert.match(second.output, /end of file; showed lines 3-3 of 3/);
});

test("read_file validates ranges and reports offsets beyond EOF", async () => {
  const cwd = await fixture({ "a.txt": "one\n" });
  const read = readTool(cwd);
  assert.match((await read({ path: "a.txt", offset: 1 })).error, /beyond end of file \(1 lines total\)/);
  assert.match((await read({ path: "a.txt", limit: 1.5 })).error, /'limit' must be an integer/);
  assert.match((await read({ path: "a.txt", offset: -1 })).error, /'offset' must be an integer/);
});

test("read_file uses UTF-8 byte limits without claiming an incomplete line was shown", async () => {
  const cwd = await fixture({ "wide.txt": `${"中".repeat(200_000)}\nnext\n` });
  const result = await readTool(cwd)({ path: "wide.txt" });
  assert.match(result.output, /line truncated/);
  assert.match(result.output, /one or more lines were truncated/);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 512 * 1024);
});

test("read_file rejects binary files, directories, and resolves symlinks", async () => {
  const cwd = await fixture({ "binary.bin": Buffer.from([0, 1, 2]), "target.txt": "ok\n" });
  await mkdir(nodePath.join(cwd, "dir"));
  await symlink(nodePath.join(cwd, "target.txt"), nodePath.join(cwd, "link.txt"));
  const read = readTool(cwd);
  assert.match((await read({ path: "binary.bin" })).error, /binary file/);
  assert.match((await read({ path: "dir" })).error, /path is a directory/);
  assert.match((await read({ path: "link.txt" })).output, /1→ok/);
});
