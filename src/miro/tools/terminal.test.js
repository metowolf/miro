import assert from "node:assert/strict";
import test from "node:test";

import {
  hostTerminalTool,
  isReadOnlyCommand,
  normalizeAllowedDomains,
  sandboxPolicy,
  sandboxUnavailableReason,
  sandboxedTerminalTool,
  shutdownSandbox,
} from "./terminal.js";

test("Plan terminal accepts environment inspection and safe read-only shell composition", () => {
  const allowed = [
    "command -v python3",
    "which -a python3 python go g++ gcc node rustc java 2>/dev/null",
    'for c in python3 go g++ gcc rustc node javac; do command -v $c >/dev/null 2>&1 && echo "$c: $(command -v $c)"; done',
    "uname -a && id",
    "find . -maxdepth 2 -type f | head -20",
  ];
  for (const command of allowed) assert.equal(isReadOnlyCommand(command), true, command);
});

test("Plan terminal still rejects writes and executable shell escape hatches", () => {
  const rejected = [
    "echo changed > file.txt",
    "find . -delete",
    "find . -exec rm {} +",
    "git branch new-branch",
    "git branch -D old-branch",
    "git remote add origin example.invalid/repo",
    "git diff --output=changes.txt",
    "command rm -rf .",
    "python3 -c 'open(\"x\", \"w\").write(\"x\")'",
    "for c in python3; do touch $c; done",
    "for c in python3; do echo $(rm -rf .); done",
  ];
  for (const command of rejected) assert.equal(isReadOnlyCommand(command), false, command);
});

test("terminal normalizes per-call domain allowlists and builds a deny-by-default policy", () => {
  assert.deepEqual(normalizeAllowedDomains(undefined), { ok: true, value: [] });
  assert.deepEqual(normalizeAllowedDomains(["api.github.com", "api.github.com"]), {
    ok: true, value: ["api.github.com"],
  });
  assert.equal(normalizeAllowedDomains([""]).ok, false);
  const policy = sandboxPolicy(["api.github.com"]);
  assert.deepEqual(policy.network.allowedDomains, ["api.github.com"]);
  assert.deepEqual(policy.filesystem, { disabled: true });
});

test("terminal validates sandbox-specific inputs before starting a process", async () => {
  const neverStart = () => { throw new Error("must not start"); };
  const runner = sandboxedTerminalTool(process.cwd(), { startBash: neverStart });
  const domainsWithHostShell = await runner({ command: "echo hi", sandbox: false, allowedDomains: ["example.com"] });
  assert.match(domainsWithHostShell.error, /allowedDomains cannot be used/);
  const missing = await runner({ command: "echo hi", workdir: "/does-not-exist" });
  assert.match(missing.error, /workdir not found/);
});

test("the host branch runs commands without a sandbox and reports the same output shape", async () => {
  const calls = [];
  const runner = hostTerminalTool(process.cwd(), {
    startBash: (command, options) => {
      calls.push({ command, options });
      return { result: Promise.resolve({ stdout: "out", stderr: "", outcome: { type: "exited", code: 0 } }), interrupt: () => {} };
    },
  });
  const result = await runner({ command: "echo out", timeout_ms: 500, workdir: process.cwd() });
  assert.equal(result.output, "[exit 0]\nout");
  assert.deepEqual(result.rawOutput, { stdout: "out", stderr: "" });
  assert.deepEqual(calls[0].options, { cwd: process.cwd(), timeoutMs: 1_000 });
  assert.equal(result.failed, false);
  assert.match((await runner({ command: "   " })).error, /missing required parameter/);
});

test("terminal checks platform support and dependencies instead of initialization state", async () => {
  const ready = {
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
  };
  assert.equal(await sandboxUnavailableReason(ready), null);
  assert.match(
    await sandboxUnavailableReason({ isSupportedPlatform: () => false, checkDependenciesAsync: async () => ({ errors: [] }) }),
    /not supported/,
  );
  assert.match(
    await sandboxUnavailableReason({ isSupportedPlatform: () => true, checkDependenciesAsync: async () => ({ errors: ["bwrap not found"] }) }),
    /bwrap not found/,
  );
});

/**
 * 沙箱桥是宿主侧的常驻子进程：只要它还活着，事件循环就不空。
 * 会话收尾不拆桥时，退出路径只卸载了 Ink，终端会一直回不到 shell
 * （用户看到的就是「Ctrl+C 连按也退不出去」）。
 */
function fakeSandboxManager(calls, overrides = {}) {
  return {
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [] }),
    initialize: async (policy) => calls.push(["initialize", policy.network.allowedDomains]),
    updateConfig: (policy) => calls.push(["updateConfig", policy.network.allowedDomains]),
    reset: async () => calls.push(["reset"]),
    wrapWithSandboxArgv: async () => ({ argv: ["/bin/echo", "hi"], env: {} }),
    annotateStderrWithSandboxFailures: (_commandId, stderr) => stderr,
    cleanupAfterCommand: () => calls.push(["cleanupAfterCommand"]),
    ...overrides,
  };
}

function fakeStartBash() {
  return () => ({
    result: Promise.resolve({ stdout: "hi", stderr: "", outcome: { type: "exited", code: 0 } }),
    interrupt: () => {},
  });
}

test("shutting the sandbox down resets the host bridges and the next command re-initializes them", async () => {
  const calls = [];
  const manager = fakeSandboxManager(calls);
  const runner = sandboxedTerminalTool(process.cwd(), { startBash: fakeStartBash(), sandboxManager: manager });
  try {
    await runner({ command: "echo hi" });
    await runner({ command: "echo hi" });
    // 同一个进程只 initialize 一次，后续命令只更新策略。
    assert.equal(calls.filter(([name]) => name === "initialize").length, 1);
    assert.equal(calls.filter(([name]) => name === "updateConfig").length, 1);

    assert.equal(await shutdownSandbox({ sandboxManager: manager }), true);
    assert.deepEqual(calls.at(-1), ["reset"]);

    // 幂等：已经拆过了就不必再 reset。
    assert.equal(await shutdownSandbox({ sandboxManager: manager }), false);
    assert.equal(calls.filter(([name]) => name === "reset").length, 1);

    // 拆过之后的下一条命令必须重新建桥，而不是以为桥还在。
    await runner({ command: "echo hi" });
    assert.equal(calls.filter(([name]) => name === "initialize").length, 2);
  } finally {
    await shutdownSandbox({ sandboxManager: manager });
  }
});

test("a failing sandbox teardown never blocks the exit path", async () => {
  const calls = [];
  const manager = fakeSandboxManager(calls, {
    reset: async () => {
      calls.push(["reset"]);
      throw new Error("bridge refused to die");
    },
  });
  const runner = sandboxedTerminalTool(process.cwd(), { startBash: fakeStartBash(), sandboxManager: manager });
  await runner({ command: "echo hi" });
  assert.equal(await shutdownSandbox({ sandboxManager: manager }), true);
  // 拆桥失败也要复位状态：下一条命令重新 initialize，而不是留一个假象。
  await runner({ command: "echo hi" });
  assert.equal(calls.filter(([name]) => name === "initialize").length, 2);
  assert.equal(await shutdownSandbox({ sandboxManager: manager }), true);
});
