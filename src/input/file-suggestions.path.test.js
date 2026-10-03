import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyPathSuggestion,
  clearCommandNameCache,
  extractPathToken,
  generateBashSuggestions,
  generateCommandNameSuggestions,
  generatePathSuggestions,
  isCommandPosition,
} from "./file-suggestions.js";

// ---------------------------------------------------------------------------
// extractPathToken
// ---------------------------------------------------------------------------

describe("extractPathToken", () => {
  test("plain token: takes everything after the last space", () => {
    expect(extractPathToken("! cat src/co", 12)).toEqual({
      token: "src/co",
      startPos: 6,
      query: "src/co",
    });
  });

  test("trailing space: token is an empty string", () => {
    expect(extractPathToken("! ls ", 5)).toEqual({ token: "", startPos: 5, query: "" });
  });

  test("bash prefix !git with no space: strips the !", () => {
    expect(extractPathToken("!git", 4)).toEqual({ token: "git", startPos: 1, query: "git" });
  });

  test("lone !: token is an empty string", () => {
    expect(extractPathToken("!", 1)).toEqual({ token: "", startPos: 1, query: "" });
  });

  test("quotes and equals signs act as separators", () => {
    expect(extractPathToken('! echo "src', 11).token).toBe("src");
    expect(extractPathToken("! FOO=src/a", 11).token).toBe("src/a");
  });

  test("cursor in the middle: only the prefix before the cursor is used", () => {
    expect(extractPathToken("! cat src/co more", 12).token).toBe("src/co");
  });
});

// ---------------------------------------------------------------------------
// generatePathSuggestions（临时目录树）
// ---------------------------------------------------------------------------

let cwd;

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "miro-path-test-"));
  await mkdir(path.join(cwd, "src", "components"), { recursive: true });
  await mkdir(path.join(cwd, "scripts"));
  await writeFile(path.join(cwd, "src", "commands.js"), "");
  await writeFile(path.join(cwd, "src", "config.js"), "");
  await writeFile(path.join(cwd, "README.md"), "");
  await symlink(path.join(cwd, "src"), path.join(cwd, "src-link"));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("generatePathSuggestions", () => {
  test("empty prefix: lists cwd top level, directories first then lexicographic order", async () => {
    const items = await generatePathSuggestions("", { cwd });
    expect(items.map((i) => i.displayText)).toEqual([
      "scripts/",
      "src/",
      "src-link/",
      "README.md",
    ]);
  });

  test("prefix filtering is case-insensitive", async () => {
    const items = await generatePathSuggestions("readme", { cwd });
    expect(items.map((i) => i.displayText)).toEqual(["README.md"]);
  });

  test("descending into src/: lists that level and keeps the prefix in displayText", async () => {
    const items = await generatePathSuggestions("src/", { cwd });
    expect(items.map((i) => i.displayText)).toEqual([
      "src/components/",
      "src/commands.js",
      "src/config.js",
    ]);
  });

  test("prefix match within a level: src/com", async () => {
    const items = await generatePathSuggestions("src/com", { cwd });
    expect(items.map((i) => i.displayText)).toEqual(["src/components/", "src/commands.js"]);
  });

  test("../ resolves against the real filesystem and keeps its display form", async () => {
    const items = await generatePathSuggestions("../", {
      cwd: path.join(cwd, "src"),
    });
    const names = items.map((i) => i.displayText);
    expect(names).toContain("../scripts/");
    expect(names).toContain("../README.md");
  });

  test("symlink pointing at a directory is treated as a directory", async () => {
    const items = await generatePathSuggestions("src-l", { cwd });
    expect(items).toEqual([
      { path: "src-link", isDirectory: true, displayText: "src-link/" },
    ]);
  });

  test("missing directory returns an empty array", async () => {
    expect(await generatePathSuggestions("nope/", { cwd })).toEqual([]);
    expect(await generatePathSuggestions("zzz", { cwd })).toEqual([]);
  });

  test("limit truncates the results", async () => {
    const items = await generatePathSuggestions("", { cwd, limit: 2 });
    expect(items.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyPathSuggestion
// ---------------------------------------------------------------------------

describe("applyPathSuggestion", () => {
  test("directory appends / and the cursor lands after the /", () => {
    const chars = [..."! cat sr"];
    const token = extractPathToken("! cat sr", 8);
    const { nextChars, nextCursor } = applyPathSuggestion(chars, token, {
      path: "src",
      isDirectory: true,
    });
    expect(nextChars.join("")).toBe("! cat src/");
    expect(nextCursor).toBe(10);
  });

  test("file does not append a space", () => {
    const chars = [..."! cat src/comm"];
    const token = extractPathToken("! cat src/comm", 14);
    const { nextChars, nextCursor } = applyPathSuggestion(chars, token, {
      path: "src/commands.js",
      isDirectory: false,
    });
    expect(nextChars.join("")).toBe("! cat src/commands.js");
    expect(nextCursor).toBe(21);
  });

  test("text after the cursor is preserved", () => {
    const value = "! cat sr && ls";
    const chars = [...value];
    const token = extractPathToken(value, 8);
    const { nextChars } = applyPathSuggestion(chars, token, {
      path: "src",
      isDirectory: true,
    });
    expect(nextChars.join("")).toBe("! cat src/ && ls");
  });

  test("multi-byte characters: nextCursor is a code point index", () => {
    const value = "! cat 😀 sr";
    const chars = [...value]; // 码点数组，长度 10
    // code unit 索引：😀 占 2 个 code unit，"sr" 结束于 code unit 11
    const token = extractPathToken(value, 11);
    expect(token.token).toBe("sr");
    const { nextChars, nextCursor } = applyPathSuggestion(chars, token, {
      path: "src",
      isDirectory: true,
    });
    expect(nextChars.join("")).toBe("! cat 😀 src/");
    // 码点计数："! cat 😀 src/" = 12 个码点
    expect(nextCursor).toBe(12);
  });

  test("command name candidate appends a space after completion", () => {
    const value = "!unam";
    const chars = [...value];
    const token = extractPathToken(value, 5);
    const { nextChars, nextCursor } = applyPathSuggestion(chars, token, {
      path: "uname",
      isDirectory: false,
      isCommand: true,
    });
    expect(nextChars.join("")).toBe("!uname ");
    expect(nextCursor).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 命令位补全：isCommandPosition / generateCommandNameSuggestions / 统一入口
// ---------------------------------------------------------------------------

describe("isCommandPosition", () => {
  test("start of line (including the immediate ! prefix) is a command position", () => {
    expect(isCommandPosition("!unam", 1)).toBe(true);
    expect(isCommandPosition("! unam", 2)).toBe(true);
  });

  test("after a pipe, &&, ; or $( is a command position", () => {
    expect(isCommandPosition("! ls | gre", 7)).toBe(true);
    expect(isCommandPosition("! ls && ec", 8)).toBe(true);
    expect(isCommandPosition("! ls; ec", 6)).toBe(true);
    expect(isCommandPosition("! echo $(unam", 9)).toBe(true);
  });

  test("plain argument positions are not command positions", () => {
    expect(isCommandPosition("! cat sr", 6)).toBe(false);
    expect(isCommandPosition("! uname -", 8)).toBe(false);
  });
});

describe("generateCommandNameSuggestions", () => {
  let binDir;

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), "miro-bin-test-"));
    for (const name of ["uname", "unar", "cat"]) {
      await writeFile(path.join(binDir, name), "", { mode: 0o755 });
    }
    clearCommandNameCache();
  });

  afterAll(async () => {
    await rm(binDir, { recursive: true, force: true });
    clearCommandNameCache();
  });

  test("unam prefix matches uname", async () => {
    const items = await generateCommandNameSuggestions("unam", { paths: [binDir] });
    expect(items).toEqual([
      { path: "uname", isDirectory: false, isCommand: true, displayText: "uname" },
    ]);
  });

  test("una prefix: shorter names first, then lexicographic order", async () => {
    clearCommandNameCache();
    const items = await generateCommandNameSuggestions("una", { paths: [binDir] });
    // unar(4) 比 uname(5) 短，短名优先
    expect(items.map((i) => i.path)).toEqual(["unar", "uname"]);
  });

  test("no match returns an empty array", async () => {
    clearCommandNameCache();
    const items = await generateCommandNameSuggestions("zzz", { paths: [binDir] });
    expect(items).toEqual([]);
  });

  test("unified entry point: command position yields command names, argument position yields paths", async () => {
    clearCommandNameCache();
    const cmdToken = extractPathToken("!unam", 5);
    const cmdItems = await generateBashSuggestions("!unam", cmdToken, { paths: [binDir], cwd });
    expect(cmdItems.map((i) => i.path)).toEqual(["uname"]);

    // 参数位（cat 之后）：同名前缀走路径补全而非命令名
    const argToken = extractPathToken("! cat sr", 8);
    const argItems = await generateBashSuggestions("! cat sr", argToken, { paths: [binDir], cwd });
    expect(argItems.map((i) => i.displayText)).toEqual(["src/", "src-link/"]);
  });

  test("unified entry point: command position with no match falls back to path completion", async () => {
    clearCommandNameCache();
    const token = extractPathToken("!scri", 5);
    const items = await generateBashSuggestions("!scri", token, { paths: [binDir], cwd });
    expect(items.map((i) => i.displayText)).toEqual(["scripts/"]);
  });

  test("unified entry point: explicit path form (./) does not use command names", async () => {
    clearCommandNameCache();
    const token = extractPathToken("!./scri", 7);
    const items = await generateBashSuggestions("!./scri", token, { paths: [binDir], cwd });
    expect(items.map((i) => i.displayText)).toEqual(["./scripts/"]);
  });
});
