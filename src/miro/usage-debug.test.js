import assert from "node:assert/strict";
import test from "node:test";

import { logUsageDebug, usageDebugEnabled } from "./usage-debug.js";

/** 替换 process.stderr.write 收集行，跑完恢复。 */
function captureStderr(run) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

function withEnv(value, run) {
  const original = process.env.MIRO_DEBUG_USAGE;
  if (value === undefined) delete process.env.MIRO_DEBUG_USAGE;
  else process.env.MIRO_DEBUG_USAGE = value;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.MIRO_DEBUG_USAGE;
    else process.env.MIRO_DEBUG_USAGE = original;
  }
}

test("usage debug is off unless MIRO_DEBUG_USAGE is a truthy token", () => {
  for (const value of ["", "0", "no", "off", "false"]) {
    withEnv(value, () => assert.equal(usageDebugEnabled(), false, `value=${value}`));
  }
  for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    withEnv(value, () => assert.equal(usageDebugEnabled(), true, `value=${value}`));
  }
});

test("logUsageDebug stays silent while disabled", () => {
  withEnv(undefined, () => {
    assert.deepEqual(captureStderr(() => logUsageDebug("sse", { cacheWrite: 0 })), []);
  });
});

test("logUsageDebug writes one prefixed line per payload when enabled", () => {
  withEnv("1", () => {
    const lines = captureStderr(() => {
      logUsageDebug("backend", { cacheRead: 5, cacheWrite: 0 });
      logUsageDebug("sse", '{"raw":true}');
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '[miro:usage] backend {"cacheRead":5,"cacheWrite":0}\n');
    // 已经是字符串的载荷原样写出，不再套一层引号。
    assert.equal(lines[1], '[miro:usage] sse {"raw":true}\n');
  });
});
