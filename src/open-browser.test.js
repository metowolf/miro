import assert from "node:assert/strict";
import test from "node:test";

import { browserCommand, findExecutable, openUrl } from "./open-browser.js";

test("browserCommand 按平台与 PATH 选择打开器", () => {
  assert.deepEqual(browserCommand("https://x", { platform: "darwin" }), ["open", "https://x"]);
  assert.deepEqual(browserCommand("https://x", { platform: "win32" }), ["cmd.exe", "/c", "start", "", "https://x"]);

  const only = (name) => (target) => target === `/usr/bin/${name}`;
  // 候选按固定顺序回退：xdg-open 缺席时用下一个。
  assert.deepEqual(
    browserCommand("https://x", { platform: "linux", pathValue: "/usr/bin", isFile: only("sensible-browser") }),
    ["/usr/bin/sensible-browser", "https://x"],
  );
  assert.deepEqual(
    browserCommand("https://x", { platform: "linux", pathValue: "/usr/bin", isFile: () => true }),
    ["/usr/bin/xdg-open", "https://x"],
  );
  // 一个都没有（无桌面环境）必须返回 null，由调用方降级成手动打开。
  assert.equal(browserCommand("https://x", { platform: "linux", pathValue: "/usr/bin", isFile: () => false }), null);
});

test("findExecutable 按 PATH 顺序查找并接受绝对路径", () => {
  const pathValue = ["/a", "/b"].join(process.platform === "win32" ? ";" : ":");
  assert.equal(findExecutable("xdg-open", pathValue, (target) => target === "/b/xdg-open"), "/b/xdg-open");
  assert.equal(findExecutable("xdg-open", pathValue, () => false), null);
  assert.equal(findExecutable("/opt/bin/opener", pathValue, (target) => target === "/opt/bin/opener"), "/opt/bin/opener");
});

test("openUrl 没有可用打开器时不 spawn，直接返回 false", () => {
  let spawned = 0;
  const opened = openUrl("https://x", {
    platform: "linux",
    pathValue: "/usr/bin",
    isFile: () => false,
    spawnImpl: () => { spawned += 1; return { on() {}, unref() {} }; },
  });
  assert.equal(opened, false);
  assert.equal(spawned, 0);
});

test("openUrl 必须给子进程挂 'error' 监听", () => {
  // Bun 的 node:child_process 把 Bun.spawn 推到下一个 tick，ENOENT 只能靠异步 'error'
  // 事件兜住；少了这个监听就是未捕获异常，会打崩整个 TUI（回归点）。
  const events = [];
  const opened = openUrl("https://x", {
    platform: "linux",
    pathValue: "/usr/bin",
    isFile: (target) => target === "/usr/bin/xdg-open",
    spawnImpl: (file, args, options) => {
      events.push({ file, args, options });
      return { on: (name) => events.push({ listen: name }), unref: () => events.push({ unref: true }) };
    },
  });

  assert.equal(opened, true);
  assert.deepEqual(events, [
    { file: "/usr/bin/xdg-open", args: ["https://x"], options: { detached: true, stdio: "ignore" } },
    { listen: "error" },
    { unref: true },
  ]);
});

test("openUrl 吞掉 spawn 的同步异常", () => {
  const opened = openUrl("https://x", {
    platform: "darwin",
    spawnImpl: () => { throw new Error("boom"); },
  });
  assert.equal(opened, false);
});

test("openUrl 在浏览器进程真的起不来时也不打崩进程", async () => {
  // 用真实 spawn 打一个不存在的可执行文件；若 'error' 监听被摘掉，这里会以未捕获异常
  // 结束整个测试进程。
  const opened = openUrl("https://x", {
    platform: "linux",
    pathValue: "/nonexistent-miro-open-browser-dir",
    isFile: (target) => target.endsWith("xdg-open"),
  });
  assert.equal(opened, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
});
