import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyFileSuggestion,
  clearFileSuggestionCache,
  extractAtToken,
  generateFileSuggestions,
} from "./file-suggestions.js";

let cwd;

function git(...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "miro-file-suggestions-"));
  git("init", "--quiet");

  await mkdir(path.join(cwd, "visible-dir"));
  await mkdir(path.join(cwd, "visible-empty-dir"));
  await mkdir(path.join(cwd, "ignored-dir"));
  await mkdir(path.join(cwd, "ignored-empty-dir"));
  await mkdir(path.join(cwd, "nested", "visible-empty"), { recursive: true });
  await mkdir(path.join(cwd, "nested", "ignored-empty"));
  await mkdir(path.join(cwd, "my folder"));
  await writeFile(path.join(cwd, "visible.txt"), "visible");
  await writeFile(path.join(cwd, "visible-dir", "item.txt"), "visible");
  await writeFile(path.join(cwd, "ignored.txt"), "ignored");
  await writeFile(path.join(cwd, "ignored-dir", "secret.txt"), "ignored");
  await writeFile(path.join(cwd, "tracked-later.txt"), "tracked");
  await writeFile(path.join(cwd, "nested", ".gitignore"), "ignored-empty/\n");
  await writeFile(path.join(cwd, "my folder", "my file.txt"), "spaces");
  await writeFile(
    path.join(cwd, ".gitignore"),
    "ignored.txt\nignored-dir/\nignored-empty-dir/\ntracked-later.txt\n"
  );

  // Git ignore 不影响已经纳管的文件，picker 应保持这一语义。
  git("add", ".gitignore", "visible.txt", "visible-dir/item.txt");
  git("add", "--force", "tracked-later.txt");
});

beforeEach(() => {
  clearFileSuggestionCache();
});

afterAll(async () => {
  clearFileSuggestionCache();
  await rm(cwd, { recursive: true, force: true });
});

describe("generateFileSuggestions gitignore", () => {
  test("bare @ only lists top-level paths from the filtered index", async () => {
    const items = await generateFileSuggestions("", { cwd, limit: 50 });
    const paths = items.map((item) => item.displayText);

    expect(paths).toContain("visible-dir/");
    expect(paths).toContain("visible-empty-dir/");
    expect(paths).toContain("visible.txt");
    expect(paths).toContain("tracked-later.txt");
    expect(paths).not.toContain("ignored.txt");
    expect(paths).not.toContain("ignored-dir/");
    expect(paths).not.toContain("ignored-empty-dir/");
  });

  test("fuzzy search hides ignored files but keeps tracked files", async () => {
    expect(await generateFileSuggestions("ignored", { cwd })).toEqual([]);
    expect((await generateFileSuggestions("tracked-later", { cwd })).map((item) => item.path)).toEqual([
      "tracked-later.txt",
    ]);
  });

  test("descending into a directory keeps using the same filtered index", async () => {
    expect(
      (await generateFileSuggestions("visible-dir/", { cwd })).map((item) => item.displayText)
    ).toEqual(["visible-dir/item.txt"]);
    expect(await generateFileSuggestions("ignored-dir/", { cwd })).toEqual([]);
  });

  test("non-ignored empty directories are indexed independently", async () => {
    expect((await generateFileSuggestions("visible-empty-dir", { cwd })).map((item) => item.path)).toEqual([
      "visible-empty-dir",
    ]);
    expect(await generateFileSuggestions("ignored-empty", { cwd })).toEqual([]);
  });

  test("nested .gitignore also filters empty directories", async () => {
    const paths = (await generateFileSuggestions("nested/", { cwd, limit: 50 })).map(
      (item) => item.displayText
    );
    expect(paths).toContain("nested/visible-empty/");
    expect(paths).not.toContain("nested/ignored-empty/");
  });
});

describe("@ paths with spaces", () => {
  test("recognizes a full path when the cursor sits before the closing quote", () => {
    const value = '@"my folder/"';
    expect(extractAtToken(value, value.length - 1)).toEqual({
      token: value,
      startPos: 0,
      query: "my folder/",
      quoted: true,
    });
  });

  test("directory gets quoted automatically and the cursor stays inside the closing quote", () => {
    const token = extractAtToken("@my", 3);
    const result = applyFileSuggestion([..."@my"], token, {
      path: "my folder",
      isDirectory: true,
    });
    expect(result.nextChars.join("")).toBe('@"my folder/"');
    expect(result.nextCursor).toBe([...'@"my folder/'].length);
  });

  test("can keep picking files inside a directory with spaces", async () => {
    const items = await generateFileSuggestions("my folder/", { cwd });
    expect(items.map((item) => item.displayText)).toEqual(["my folder/my file.txt"]);

    const value = '@"my folder/"';
    const token = extractAtToken(value, value.length - 1);
    const result = applyFileSuggestion([...value], token, items[0]);
    expect(result.nextChars.join("")).toBe('@"my folder/my file.txt" ');
    expect(result.nextCursor).toBe(result.nextChars.length);
  });
});
