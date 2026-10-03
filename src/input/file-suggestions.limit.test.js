import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { clearFileSuggestionCache, generateFileSuggestions } from "./file-suggestions.js";

test("@ 根目录、目录下钻和搜索均返回完整匹配，显式 limit 仍然有效", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "miro-file-suggestion-limit-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
    await mkdir(path.join(cwd, "src"));
    const names = Array.from({ length: 40 }, (_, index) => `entry-${String(index).padStart(2, "0")}.js`);
    await Promise.all(names.flatMap((name) => [
      writeFile(path.join(cwd, name), ""),
      writeFile(path.join(cwd, "src", name), ""),
    ]));
    clearFileSuggestionCache();

    const root = await generateFileSuggestions("", { cwd });
    assert.deepEqual(root.map((item) => item.displayText), ["src/", ...names]);
    const nested = await generateFileSuggestions("src/", { cwd });
    assert.deepEqual(nested.map((item) => item.displayText), names.map((name) => `src/${name}`));
    assert.equal((await generateFileSuggestions("entry-", { cwd })).length, 80);
    for (const query of ["", "src/", "entry-"]) {
      const all = await generateFileSuggestions(query, { cwd });
      assert.deepEqual(await generateFileSuggestions(query, { cwd, limit: 5 }), all.slice(0, 5));
      assert.deepEqual(await generateFileSuggestions(query, { cwd, limit: 0 }), []);
    }
  } finally {
    clearFileSuggestionCache();
    await rm(cwd, { recursive: true, force: true });
  }
});
