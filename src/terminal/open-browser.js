/**
 * 打开系统浏览器。
 *
 * 命令选择抽成不依赖进程的纯函数（platform / PATH / 文件探测都可注入），方便回归测试；
 * App 只留一行接线。这里必须显式看清一个坑：Bun 的 node:child_process 会把真正的
 * Bun.spawn 推到下一个 tick，可执行文件不存在时 ENOENT 是异步 'error' 事件，同步
 * try/catch 抓不到；不挂监听就是未捕获异常，会把整个 Ink TUI 连渲染帧一起打崩
 * （用户看到的是被 Bun 源码预览覆盖的残帧）。所以 spawn 之后一定要挂 'error'。
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

// 无桌面环境（最小容器、服务器、没装 wslu 的 WSL）通常一个都不存在，此时不能崩，
// 只让调用方把 URL 打给用户手动打开。
const LINUX_OPENERS = ["xdg-open", "sensible-browser", "x-www-browser", "wslview"];

function isExecutableFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 里按顺序找第一个存在的可执行文件；找不到返回 null。 */
export function findExecutable(name, pathValue = "", isFile = isExecutableFile) {
  if (name.includes("/") || name.includes("\\")) return isFile(name) ? name : null;
  for (const dir of String(pathValue).split(delimiter)) {
    const target = join(dir || ".", name);
    if (isFile(target)) return target;
  }
  return null;
}

/** 返回要执行的命令；null 表示这台机器没有可用的打开器。 */
export function browserCommand(url, { platform = process.platform, pathValue = process.env.PATH ?? "", isFile } = {}) {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd.exe", "/c", "start", "", url];
  const opener = LINUX_OPENERS.map((name) => findExecutable(name, pathValue, isFile)).find(Boolean);
  return opener ? [opener, url] : null;
}

/**
 * 尽力打开 url，返回是否真的起了进程；任何失败都不抛给调用方——打不开浏览器不该影响
 * 登录流程本身，用户仍可手动打开 URL 或粘贴授权码。
 */
export function openUrl(url, { spawnImpl = spawn, ...deps } = {}) {
  const command = browserCommand(url, deps);
  if (!command) return false;
  try {
    const child = spawnImpl(command[0], command.slice(1), { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
