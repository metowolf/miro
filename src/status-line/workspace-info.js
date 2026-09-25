import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 状态栏用的工作区信息：项目名（同步、带缓存）与 git 分支（异步、带缓存）。
 * 渲染路径只读缓存，绝不同步执行子进程。
 */

const projectNameCache = new Map();
const branchCache = new Map();
const inFlight = new Map();

const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"];

/** 向上查找项目根目录名；找不到标记时返回当前目录名。 */
export function projectNameFor(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  if (projectNameCache.has(cwd)) return projectNameCache.get(cwd);

  let dir = cwd;
  let found = null;
  while (true) {
    if (PROJECT_MARKERS.some((marker) => existsSync(path.join(dir, marker)))) {
      found = path.basename(dir);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const name = found ?? (path.basename(cwd) || null);
  projectNameCache.set(cwd, name);
  return name;
}

/**
 * 异步查询 git 分支，同一 cwd 只允许一个 in-flight 请求。
 * 失败（非仓库、无 git）一律记为 null 且不抛错。
 */
export function loadGitBranch(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return Promise.resolve(null);
  if (branchCache.has(cwd)) return Promise.resolve(branchCache.get(cwd));
  const pending = inFlight.get(cwd);
  if (pending) return pending;

  const task = new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000 },
      (error, stdout) => {
        const branch = error ? null : String(stdout).trim();
        resolve(branch && branch !== "HEAD" ? branch : null);
      }
    );
  }).then((branch) => {
    branchCache.set(cwd, branch);
    inFlight.delete(cwd);
    return branch;
  });

  inFlight.set(cwd, task);
  return task;
}
