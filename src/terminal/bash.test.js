import assert from "node:assert/strict";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  activeProcessTreeCount,
  cleanupActiveProcessTrees,
  formatBashContext,
  formatBashOutcome,
  startBash,
} from "./bash.js";

const POSIX = process.platform !== "win32";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("formatBashOutcome covers every termination outcome", () => {
  assert.equal(formatBashOutcome({ type: "exited", code: 7 }), "exited(7)");
  assert.equal(formatBashOutcome({ type: "signaled", signal: "SIGTERM" }), "signaled(SIGTERM)");
  assert.equal(formatBashOutcome({ type: "timed_out" }), "timed_out");
  assert.equal(formatBashOutcome({ type: "cancelled" }), "cancelled");
  assert.equal(formatBashOutcome({ type: "spawn_failed" }), "spawn_failed");
});

test("bash context contains the escaped command result", () => {
  assert.equal(
    formatBashContext({
      command: "printf '<ok>'",
      stdout: "<ok>\n",
      stderr: "",
      outcome: { type: "exited", code: 0 },
    }),
    "<bash-input>printf '&lt;ok&gt;'</bash-input>\n" +
      "<bash-result>exited(0)</bash-result>\n" +
      "<bash-stdout>&lt;ok&gt;\n</bash-stdout><bash-stderr></bash-stderr>"
  );
});

test("returns spawn_failed when the child process cannot be created", async () => {
  const cwd = join(process.cwd(), `.missing-bash-cwd-${process.pid}-${Date.now()}`);
  const { result } = startBash("echo unreachable", { cwd, timeoutMs: 1_000 });
  const value = await result;
  assert.equal(value.outcome.type, "spawn_failed");
  assert.match(value.stderr, /ENOENT|no such file/i);
});

test("POSIX commands keep the exit code and termination signal", { skip: !POSIX }, async () => {
  const exited = await startBash("printf out; printf err >&2; exit 7").result;
  assert.equal(exited.stdout, "out");
  assert.equal(exited.stderr, "err");
  assert.deepEqual(exited.outcome, { type: "exited", code: 7 });

  const signaled = await startBash("exec sh -c 'kill -TERM $$'").result;
  assert.deepEqual(signaled.outcome, { type: "signaled", signal: "SIGTERM" });
});

test("interrupt returns cancelled and force-kills the process after the grace period", { skip: !POSIX }, async () => {
  const task = startBash("exec sh -c 'trap \"\" TERM; while :; do :; done'", {
    timeoutMs: 5_000,
    termGraceMs: 30,
    killWaitMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(task.interrupt(), true);
  const value = await task.result;
  assert.deepEqual(value.outcome, { type: "cancelled" });
});

test("timeout cleanup also kills shell descendants that ignore SIGTERM", { skip: !POSIX }, async () => {
  const task = startBash(
    "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & child=$!; printf '%s %s\\n' \"$$\" \"$child\"; wait",
    { timeoutMs: 60, termGraceMs: 30, killWaitMs: 1_000 }
  );
  const value = await task.result;
  assert.deepEqual(value.outcome, { type: "timed_out" });

  const [shellPid, descendantPid] = value.stdout.trim().split(/\s+/).map(Number);
  assert.ok(Number.isInteger(shellPid), `expected a shell PID, got ${JSON.stringify(value.stdout)}`);
  assert.ok(Number.isInteger(descendantPid), `expected a descendant PID, got ${JSON.stringify(value.stdout)}`);
  assert.notEqual(shellPid, descendantPid);
  assert.equal(pidAlive(shellPid), false, `shell process ${shellPid} must not survive`);
  assert.equal(pidAlive(descendantPid), false, `descendant process ${descendantPid} must not survive`);
});

test("host-exit cleanup kills and unregisters active process groups", { skip: !POSIX }, async () => {
  const task = startBash("exec sh -c 'trap \"\" TERM; while :; do :; done'", { timeoutMs: 10_000 });
  assert.ok(activeProcessTreeCount() >= 1);
  cleanupActiveProcessTrees();
  const result = await task.result;
  assert.equal(result.outcome.type, "signaled");
  assert.equal(activeProcessTreeCount(), 0);
});
