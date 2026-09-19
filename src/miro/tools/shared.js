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

/**
 * 从 .gitignore 提取可按「单段目录名」处理的条目。
 *
 * 只认无 glob 元字符的单段名字；`build/output/*.o` 这类需要完整 gitignore
 * 语义才能正确匹配，宁可漏掉也不要误伤。
 */
function parseGitignoreDirs(text) {
  const ignore = new Set();
  const unignore = new Set();
  for (const raw of linesOf(text)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;

    // 去掉前后的 '/'，剩下的必须是单段且不含 glob 元字符。
    const name = body.replace(/^\/+/, "").replace(/\/+$/, "");
    if (name === "" || name.includes("/") || /[*?[\]]/.test(name)) continue;

    if (negated) unignore.add(name);
    else ignore.add(name);
  }
  return { ignore, unignore };
}

/**
 * 构造搜索用的目录过滤器，三层叠加：
 *   1. VCS 元数据目录，无条件跳过；
 *   2. 依赖/构建产物基线黑名单；
 *   3. 项目 .gitignore 里的单段目录名，追加忽略；其中 `!name` 可从第 2 层豁免。
 */
export async function buildIgnoreFilter(searchRoot) {
  const { readFile } = await import("node:fs/promises");
  const nodePath = await import("node:path");

  const extraIgnored = new Set();
  const unignored = new Set();
  try {
    const text = await readFile(nodePath.join(searchRoot, ".gitignore"), "utf8");
    const { ignore, unignore } = parseGitignoreDirs(text);
    for (const name of ignore) extraIgnored.add(name);
    for (const name of unignore) unignored.add(name);
  } catch {
    // 没有 .gitignore：只用前两层。
  }

  const isIgnoredName = (name) => {
    if (typeof name !== "string") return false;
    // VCS 目录不可被 .gitignore 的否定规则救回来。
    if (VCS_DIRS.has(name)) return true;
    if (unignored.has(name)) return false;
    return DEFAULT_IGNORED_DIRS.has(name) || extraIgnored.has(name);
  };

  return {
    isIgnoredName,
    /** glob 的 exclude 在不同运行时分别传路径或 Dirent，两种都要能识别。 */
    isIgnoredEntry(entry) {
      const name = typeof entry === "string" ? entry.split("/").at(-1) : entry?.name;
      return isIgnoredName(name);
    },
    /** 产出路径逐段复查，兜住 exclude 回调未剪枝的情况。 */
    isIgnoredPath(entry) {
      return String(entry).split("/").some(isIgnoredName);
    },
  };
}
