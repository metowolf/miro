/** 工具执行结果一律转成字符串，避免把 Node 对象泄漏进 transcript。 */
export function stringifyResult(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncate(text, limit) {
  if (typeof text !== "string") return text;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated]`;
}

/** ACP content 块；UI 与 DiffView 都按这个结构提取文本。 */
export function textContent(text) {
  return [{ type: "content", content: { type: "text", text } }];
}

export function diffContent(path, oldText, newText) {
  return [
    {
      type: "content",
      content: {
        type: "diff",
        path,
        oldText,
        newText,
      },
    },
  ];
}

/** 相对 cwd 的路径，用于 locations 与展示。 */
export function resolveToolPath(cwd, input) {
  const raw = typeof input?.path === "string" ? input.path : null;
  if (!raw) return null;
  return raw.startsWith("/") ? raw : `${cwd}/${raw}`.replace(/\/{2,}/g, "/");
}

export function linesOf(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * 版本控制元数据目录：与 .gitignore 无关，任何情况下都该跳过。
 *
 * 这类目录不会被 .gitignore 覆盖（git 不忽略自己的 .git），但命中它们
 * 对调用方永远是噪音，所以单独成层、无条件生效。
 */
export const VCS_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

/**
 * 构建产物与依赖目录：始终生效的基线黑名单。
 *
 * .gitignore 是叠加在这层之上的补充，而不是替代——很多仓库靠全局
 * gitignore 或约定忽略 node_modules，本地 .gitignore 里并没有这一行，
 * 若以它为唯一来源就会把几万个文件重新放进搜索结果。
 * 想搜这些目录里的东西时，在 .gitignore 用 `!name` 显式取消即可。
 */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

/** 把子目录规则锚定到共同根目录；模式本身仍交给 ignore 解析。 */
function scopedIgnoreRules(text, scope) {
  if (!scope) return text;
  const prefix = scope.replace(/[\\*?[\] ]/g, "\\$&");
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line || line.startsWith("#") || /^\s*$/.test(line)) return [];
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    if (!pattern.trim() || pattern.trimEnd() === "/") return [];
    const anchored = pattern.startsWith("/") || pattern.trimEnd().replace(/\/$/, "").includes("/");
    const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    return `${negated ? "!" : ""}/${prefix}/${anchored ? "" : "**/"}${body}`;
  });
}

/**
 * 搜索规则以最近的 Git 仓库为边界；非仓库只继承 cwd 内的规则。
 * 每个目录按需加载 .gitignore，子目录规则覆盖父级，忽略目录不读取内部规则。
 * glob 的 exclude 是同步回调，因此这里同步读取小文件并在单次搜索内缓存。
 */
export async function buildIgnoreFilter(searchRoot, { cwd = searchRoot } = {}) {
  const { lstatSync, readFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  const { default: ignore } = await import("ignore");
  const root = nodePath.resolve(searchRoot);
  const relative = (base, path) => nodePath.relative(base, path).split(nodePath.sep).join("/");
  const within = (base, path) => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith("../") && !nodePath.isAbsolute(rel);
  };
  const info = (path) => {
    try { return lstatSync(path); } catch { return null; }
  };

  let boundary = within(nodePath.resolve(cwd), root) ? nodePath.resolve(cwd) : root;
  for (let dir = root; ; dir = nodePath.dirname(dir)) {
    if (info(nodePath.join(dir, ".git"))) {
      boundary = dir;
      break;
    }
    if (dir === nodePath.dirname(dir)) break;
  }

  const createMatcher = () => ignore({ ignoreCase: false });
  const baseline = createMatcher().add([...DEFAULT_IGNORED_DIRS].map((name) => `${name}/`));
  const cache = new Map();
  const hasVcsDir = (path) => relative(boundary, path).split("/").some((name) => VCS_DIRS.has(name));

  function matcherForDirectory(dir) {
    if (cache.has(dir)) return cache.get(dir);
    const parent = dir === boundary ? baseline : matcherForDirectory(nodePath.dirname(dir));
    const scope = relative(boundary, dir);
    let matcher = parent;
    // 被忽略的父目录不能靠内部 .gitignore 重新纳入。
    if (!scope || (!hasVcsDir(dir) && !parent.ignores(`${scope}/`))) {
      const file = nodePath.join(dir, ".gitignore");
      if (info(file)?.isFile()) {
        try {
          matcher = createMatcher().add(parent).add(scopedIgnoreRules(readFileSync(file, "utf8"), scope));
        } catch {
          // 文件不可读时继续使用父级规则。
        }
      }
    }
    cache.set(dir, matcher);
    return matcher;
  }

  function isIgnoredPath(entry, isDirectory = false) {
    const absolute = nodePath.resolve(root, entry);
    if (!within(boundary, absolute)) return true;
    const path = relative(boundary, absolute);
    if (!path) return false;
    const directories = isDirectory ? absolute : nodePath.dirname(absolute);
    if (hasVcsDir(directories)) return true;
    return matcherForDirectory(nodePath.dirname(absolute)).ignores(`${path}${isDirectory ? "/" : ""}`);
  }

  return {
    isIgnoredPath,
    /** 调用方使用 withFileTypes，避免只按 basename 剪掉同名但不同作用域的目录。 */
    isIgnoredEntry(entry) {
      const parent = entry?.parentPath ?? entry?.path;
      if (typeof parent !== "string" || typeof entry?.name !== "string") return false;
      return isIgnoredPath(nodePath.join(parent, entry.name), entry.isDirectory());
    },
  };
}
