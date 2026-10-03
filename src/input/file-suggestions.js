import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const AT_TOKEN_HEAD_RE = /^@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u;
const PATH_CHAR_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u;
const QUOTED_AT_TOKEN_HEAD_RE = /^@"[^"]*$/u;
const QUOTED_PATH_CHAR_HEAD_RE = /^[^"]*"?/u;

const MAX_SUGGESTIONS = 15;
const CACHE_TTL_MS = 5000;
const GIT_TIMEOUT_MS = 2000;
const SEARCH_TIMEOUT_MS = 5000;
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_FILES = 5000;
const SCAN_MAX_DIRS = 5000;
const SCAN_SKIP_DIRS = new Set([".git", "node_modules"]);

/** 识别光标处的 @ 令牌；光标在中间时向后扩到整个令牌。 */
export function extractAtToken(text, cursorPos) {
  if (!text) return null;

  const before = text.substring(0, cursorPos);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) return null;
  if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return null;

  const fromAt = before.substring(atIdx);
  if (fromAt.startsWith('@"')) {
    if (!QUOTED_AT_TOKEN_HEAD_RE.test(fromAt)) return null;
    const after = text.substring(cursorPos);
    const afterMatch = after.match(QUOTED_PATH_CHAR_HEAD_RE);
    const token = fromAt + (afterMatch ? afterMatch[0] : "");
    const quotedPath = token.slice(2, token.endsWith('"') ? -1 : undefined);
    return { token, startPos: atIdx, query: quotedPath, quoted: true };
  }
  const headMatch = fromAt.match(AT_TOKEN_HEAD_RE);
  if (!headMatch || headMatch[0].length !== fromAt.length) return null;

  const after = text.substring(cursorPos);
  const afterMatch = after.match(PATH_CHAR_HEAD_RE);
  const token = headMatch[0] + (afterMatch ? afterMatch[0] : "");
  return { token, startPos: atIdx, query: token.slice(1) };
}

/** 连确认键也要用最新草稿重算身份，不能依赖上一帧闭包里的令牌。 */
export function fileSuggestionKey(token) {
  return token ? `${token.startPos}:${token.token}` : null;
}

let cache = { cwd: null, expiresAt: 0, promise: null };

export function clearFileSuggestionCache() {
  cache = { cwd: null, expiresAt: 0, promise: null };
}

function execCommand(command, args, cwd, timeout = SEARCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });
}

async function listFilesViaGit(cwd) {
  const inRepo = await execCommand(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    cwd,
    GIT_TIMEOUT_MS
  );
  if (inRepo === null) return { inRepo: null, files: null };
  if (inRepo.trim() !== "true") return { inRepo: false, files: null };
  const [stdout, ignoredStdout] = await Promise.all([
    execCommand(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      cwd,
      GIT_TIMEOUT_MS
    ),
    execCommand(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--directory",
        "--empty-directory",
        "--exclude-standard",
      ],
      cwd,
      GIT_TIMEOUT_MS
    ),
  ]);
  if (stdout === null) return { inRepo: true, files: null, dirs: null };

  const ignoredDirs = new Set(
    (ignoredStdout ?? "")
      .split("\0")
      .filter((entry) => entry.endsWith("/"))
      .map((entry) => entry.slice(0, -1))
  );
  const scannedDirs =
    ignoredStdout === null ? null : await listDirectoriesViaScan(cwd, ignoredDirs);
  return {
    inRepo: true,
    files: stdout.split("\0").filter(Boolean),
    dirs: scannedDirs,
  };
}

/** ripgrep 的文件枚举同样遵守 .gitignore/.ignore，作为 Git 失败时的安全回退。 */
async function listFilesViaRipgrep(cwd) {
  const stdout = await execCommand(
    "rg",
    ["--files", "--null", "--hidden", "--glob", "!.git", "--glob", "!.git/**"],
    cwd
  );
  if (stdout === null) return null;
  return stdout.split("\0").filter(Boolean);
}

/** Git 不可执行时仍识别常见仓库/工作树，避免退化成会暴露 ignored 文件的裸扫描。 */
async function hasGitMetadata(cwd) {
  let current = path.resolve(cwd);
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return true;
    } catch {
      // 继续向父目录查找，覆盖从仓库子目录启动的情况。
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function listFilesViaScan(cwd) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > SCAN_MAX_DEPTH || files.length >= SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= SCAN_MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(cwd, full));
      }
    }
  };
  await walk(cwd, 0);
  return files;
}

function isInsideIgnoredDirectory(candidate, ignoredDirs) {
  let current = candidate;
  for (;;) {
    if (ignoredDirs.has(current)) return true;
    const slash = current.lastIndexOf("/");
    if (slash < 0) return false;
    current = current.slice(0, slash);
  }
}

/** 独立枚举真实目录，避免从文件反推时漏掉空目录。 */
async function listDirectoriesViaScan(cwd, ignoredDirs = new Set()) {
  const dirs = [];
  const walk = async (dir, prefix, depth) => {
    if (depth > SCAN_MAX_DEPTH || dirs.length >= SCAN_MAX_DIRS) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dirs.length >= SCAN_MAX_DIRS) return;
      if (!entry.isDirectory() || SCAN_SKIP_DIRS.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isInsideIgnoredDirectory(relative, ignoredDirs)) continue;
      dirs.push(relative);
      await walk(path.join(dir, entry.name), relative, depth + 1);
    }
  };
  await walk(cwd, "", 0);
  return dirs;
}

/** 由文件路径推导所有父目录，带尾部 "/"。 */
export function getDirectoryNames(files) {
  const dirs = new Set();
  for (const file of files) {
    let dir = path.dirname(file);
    while (dir !== "." && !dirs.has(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dirs.add(dir);
      dir = parent;
    }
  }
  return [...dirs].map((d) => d + "/");
}

/** 工作区路径列表：Git 优先、ripgrep 安全回退，非 Git 目录才允许裸扫描。 */
async function listWorkspacePaths(cwd) {
  const now = Date.now();
  if (cache.cwd === cwd && cache.promise && now < cache.expiresAt) {
    return cache.promise;
  }
  const promise = (async () => {
    const git = await listFilesViaGit(cwd);
    let files = git.files ?? (await listFilesViaRipgrep(cwd));
    if (files === null) {
      const inRepo = git.inRepo ?? (await hasGitMetadata(cwd));
      files = inRepo ? [] : await listFilesViaScan(cwd);
    }
    const dirs = new Set(getDirectoryNames(files));
    for (const dir of git.dirs ?? []) dirs.add(`${dir}/`);
    return { files, dirs: [...dirs] };
  })();
  cache = { cwd, expiresAt: now + CACHE_TTL_MS, promise };
  promise.catch(() => {
    if (cache.promise === promise) cache = { cwd: null, expiresAt: 0, promise: null };
  });
  return promise;
}

function toSuggestion(p) {
  const isDirectory = p.endsWith("/");
  return {
    path: isDirectory ? p.slice(0, -1) : p,
    isDirectory,
    displayText: p,
  };
}

function byDirFirst(a, b) {
  const aDir = a.endsWith("/");
  const bDir = b.endsWith("/");
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.localeCompare(b);
}

/** 从同一份过滤后的索引列出一层，防止裸 @ 与目录下钻绕过 ignore。 */
function listIndexedLevel(files, dirs, dirPrefix) {
  return [...dirs, ...files]
    .filter((candidate) => {
      if (!candidate.startsWith(dirPrefix) || candidate === dirPrefix) return false;
      const remainder = candidate.slice(dirPrefix.length);
      const withoutTrailingSlash = remainder.endsWith("/") ? remainder.slice(0, -1) : remainder;
      return withoutTrailingSlash !== "" && !withoutTrailingSlash.includes("/");
    })
    .sort(byDirFirst);
}

function matchRank(candidate, query) {
  const p = candidate.toLowerCase();
  const base = path.basename(candidate.endsWith("/") ? candidate.slice(0, -1) : candidate).toLowerCase();
  if (base.startsWith(query)) return 0;
  if (p.startsWith(query)) return 1;
  if (p.includes(query)) return 2;
  return -1;
}

export async function generateFileSuggestions(query, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  // 可见行数由 picker 控制；默认返回完整匹配，避免后面的路径永远无法选中。
  const limit = opts.limit ?? Infinity;

  try {
    const { files, dirs } = await listWorkspacePaths(cwd);
    if (query === "" || query === "." || query === "./") {
      const level = listIndexedLevel(files, dirs, "");
      return level.slice(0, limit).map(toSuggestion);
    }

    let normalized = query.startsWith("./") ? query.slice(2) : query;

    if (normalized.endsWith("/")) {
      const level = listIndexedLevel(files, dirs, normalized);
      return level.slice(0, limit).map(toSuggestion);
    }

    const q = normalized.toLowerCase();
    return [...dirs, ...files]
      .map((candidate) => ({ candidate, rank: matchRank(candidate, q) }))
      .filter((item) => item.rank >= 0)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.candidate.length - b.candidate.length ||
          a.candidate.localeCompare(b.candidate)
      )
      .slice(0, limit)
      .map((item) => toSuggestion(item.candidate));
  } catch {
    return [];
  }
}

/** startPos 是 code-unit 索引，返回的 nextCursor 是码点索引。 */
export function applyFileSuggestion(chars, token, suggestion) {
  const value = chars.join("");
  const pathText = `${suggestion.path}${suggestion.isDirectory ? "/" : ""}`;
  const quoted = token.quoted || /\s/u.test(pathText);
  const replacement = quoted
    ? `@"${pathText}"${suggestion.isDirectory ? "" : " "}`
    : `@${pathText}${suggestion.isDirectory ? "" : " "}`;
  const before = value.slice(0, token.startPos);
  const after = value.slice(token.startPos + token.token.length);
  const nextChars = [...(before + replacement + after)];
  const cursorText = quoted && suggestion.isDirectory ? replacement.slice(0, -1) : replacement;
  return { nextChars, nextCursor: [...(before + cursorText)].length };
}

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function extractPathToken(text, cursorPos) {
  const before = text.substring(0, cursorPos);
  let start = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(before[i])) {
      start = i + 1;
      break;
    }
  }
  let token = before.slice(start);
  if (start === 0 && token.startsWith("!")) {
    token = token.slice(1);
    start += 1;
  }
  return { token, startPos: start, query: token };
}

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** 生成层级路径候选；显示形态保留用户输入的前缀。 */
export async function generatePathSuggestions(prefix, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const limit = opts.limit ?? MAX_SUGGESTIONS;

  try {
    const expanded = expandHome(prefix);

    let displayDir;
    let searchDir;
    let namePrefix;
    const isRoot = prefix === "" || prefix === "~";

    if (isRoot || prefix.endsWith("/")) {
      displayDir = prefix === "~" ? "~/" : prefix;
      searchDir = path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
      namePrefix = "";
    } else {
      const slashIdx = prefix.lastIndexOf("/");
      displayDir = slashIdx === -1 ? "" : prefix.slice(0, slashIdx + 1);
      namePrefix = prefix.slice(slashIdx + 1).toLowerCase();
      const dir = expandHome(displayDir === "" ? "." : displayDir);
      searchDir = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    }

    const entries = await readdir(searchDir, { withFileTypes: true });
    const matched = [];
    for (const entry of entries) {
      if (namePrefix && !entry.name.toLowerCase().startsWith(namePrefix)) continue;
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(path.join(searchDir, entry.name))).isDirectory();
        } catch {
          // ignore
        }
      }
      matched.push({ name: entry.name, isDirectory });
    }

    matched.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return matched.slice(0, limit).map((entry) => {
      const p = displayDir + entry.name;
      return {
        path: p,
        isDirectory: entry.isDirectory,
        displayText: p + (entry.isDirectory ? "/" : ""),
      };
    });
  } catch {
    return [];
  }
}

/** 目录补 "/"，命令名补空格；startPos 为 code-unit，nextCursor 为码点。 */
export function applyPathSuggestion(chars, token, suggestion) {
  const value = chars.join("");
  const suffix = suggestion.isDirectory ? "/" : suggestion.isCommand ? " " : "";
  const replacement = suggestion.path + suffix;
  const before = value.slice(0, token.startPos);
  const after = value.slice(token.startPos + token.token.length);
  const nextChars = [...(before + replacement + after)];
  return { nextChars, nextCursor: [...(before + replacement)].length };
}

/** 去掉 "!" 后，token 之前为空或以 | || && ; & ` ( 结尾。 */
export function isCommandPosition(text, startPos) {
  let before = text.slice(0, startPos);
  if (before.startsWith("!")) before = before.slice(1);
  const trimmed = before.trim();
  if (trimmed === "") return true;
  return /(\|\||&&|[|;&(`])$/.test(trimmed);
}

let commandCache = { key: null, expiresAt: 0, promise: null };
const COMMAND_CACHE_TTL_MS = 30_000;

export function clearCommandNameCache() {
  commandCache = { key: null, expiresAt: 0, promise: null };
}

async function listPathCommands(paths) {
  const key = paths.join(path.delimiter);
  const now = Date.now();
  if (commandCache.key === key && commandCache.promise && now < commandCache.expiresAt) {
    return commandCache.promise;
  }
  const promise = (async () => {
    const names = new Set();
    for (const dir of paths) {
      if (!dir) continue;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() || entry.isSymbolicLink()) names.add(entry.name);
      }
    }
    return [...names];
  })();
  commandCache = { key, expiresAt: now + COMMAND_CACHE_TTL_MS, promise };
  promise.catch(() => {
    if (commandCache.promise === promise) clearCommandNameCache();
  });
  return promise;
}

export async function generateCommandNameSuggestions(prefix, opts = {}) {
  const limit = opts.limit ?? MAX_SUGGESTIONS;
  const paths = opts.paths ?? (process.env.PATH ?? "").split(path.delimiter);
  try {
    const names = await listPathCommands(paths);
    const q = prefix.toLowerCase();
    return names
      .filter((name) => name.toLowerCase().startsWith(q))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, limit)
      .map((name) => ({ path: name, isDirectory: false, isCommand: true, displayText: name }));
  } catch {
    return [];
  }
}

/** 命令位补 PATH 命令名，否则补路径。 */
export async function generateBashSuggestions(text, token, opts = {}) {
  const { query } = token;
  const looksLikePath = query.includes("/") || query.startsWith(".") || query.startsWith("~");
  if (query !== "" && !looksLikePath && isCommandPosition(text, token.startPos)) {
    const commands = await generateCommandNameSuggestions(query, opts);
    if (commands.length > 0) return commands;
  }
  return generatePathSuggestions(query, opts);
}
