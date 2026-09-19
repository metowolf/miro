import { spawn } from "node:child_process";
import process from "node:process";

/** `!` 开头的输入在本地执行，输出包成结构化文本随下一条 prompt 发送。 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 30_000;
const DEFAULT_TERM_GRACE_MS = 3_000;
const DEFAULT_KILL_WAIT_MS = 1_000;
const CLEANUP_POLL_MS = 20;
const activeProcessTrees = new Set();
let exitCleanupInstalled = false;

/** 正常宿主退出前的最后一道同步清理；SIGKILL 无法在进程内处理。 */
export function cleanupActiveProcessTrees() {
  for (const entry of activeProcessTrees) {
    if (!entry.posix || entry.pid == null) continue;
    try {
      process.kill(-entry.pid, "SIGKILL");
    } catch {
      // 已退出的进程组无需处理。
    }
  }
}

function registerProcessTree(proc, posix) {
  const entry = { pid: proc.pid, posix };
  activeProcessTrees.add(entry);
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.once("exit", cleanupActiveProcessTrees);
  }
  return () => activeProcessTrees.delete(entry);
}

/** 仅供生命周期测试与诊断，不暴露进程或命令内容。 */
export function activeProcessTreeCount() {
  return activeProcessTrees.size;
}

export function isBashInput(text) {
  return text.startsWith("!");
}

export function getBashCommand(text) {
  return text.slice(1).trim();
}

export function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(text, maxOutput) {
  if (text.length <= maxOutput) return text;
  return `${text.slice(0, maxOutput)}\n[output truncated]`;
}

function exitedOutcome(code) {
  return { type: "exited", code };
}

function closeOutcome(code, signal, requestedOutcome) {
  if (requestedOutcome) return requestedOutcome;
  if (signal) return { type: "signaled", signal };
  return exitedOutcome(code);
}

/** POSIX shell 单独占用一个进程组，终止时可覆盖它创建的后代进程。 */
function signalProcessTree(proc, signal, posix) {
  if (posix && proc.pid != null) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      // 进程组信号不可用时，至少终止直接子进程。
    }
  }

  try {
    return proc.kill(signal);
  } catch {
    return false;
  }
}

function processTreeAlive(proc, posix) {
  if (posix && proc.pid != null) {
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
  return proc.exitCode == null && proc.signalCode == null;
}

export function formatBashOutcome(outcome) {
  switch (outcome?.type) {
    case "exited":
      return `exited(${outcome.code})`;
    case "signaled":
      return `signaled(${outcome.signal})`;
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "spawn_failed":
      return "spawn_failed";
    default:
      return "spawn_failed";
  }
}

/** 返回 { result, interrupt }；输出按上限截断。 */
export function startBash(
  command,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutput = DEFAULT_MAX_OUTPUT,
    cwd = process.cwd(),
    termGraceMs = DEFAULT_TERM_GRACE_MS,
    killWaitMs = DEFAULT_KILL_WAIT_MS,
    // 沙箱运行时在 Windows 返回 argv + env，不能再交给宿主 shell 解析。
    // 其它调用保持原来的 shell 字符串语义。
    argv = null,
    env = process.env,
  } = {}
) {
  const posix = process.platform !== "win32";
  let proc;
  try {
    const isArgv = Array.isArray(argv) && argv.length > 0;
    proc = isArgv ? spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
    }) : spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    return {
      result: Promise.resolve({
        stdout: "",
        stderr: truncate(message, maxOutput),
        outcome: { type: "spawn_failed", message },
      }),
      interrupt: () => false,
    };
  }

  let stdout = "";
  let stderr = "";
  let requestedOutcome = null;
  let closeInfo = null;
  let cleanupDone = true;
  let cleanupTimer = null;
  let timer = null;
  let settled = false;
  let resolveResult;
  const unregisterProcessTree = registerProcessTree(proc, posix);

  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    unregisterProcessTree();
    clearTimeout(timer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    resolveResult({
      stdout: truncate(stdout, maxOutput),
      stderr: truncate(stderr, maxOutput),
      outcome,
    });
  };

  const maybeFinish = () => {
    if (!closeInfo || !cleanupDone) return;
    finish(closeOutcome(closeInfo.code, closeInfo.signal, requestedOutcome));
  };

  const terminate = (type) => {
    if (settled || requestedOutcome) return false;
    requestedOutcome = { type };
    clearTimeout(timer);
    cleanupDone = false;
    const startedAt = Date.now();
    let forced = false;
    signalProcessTree(proc, "SIGTERM", posix);

    const poll = () => {
      if (!processTreeAlive(proc, posix)) {
        cleanupDone = true;
        maybeFinish();
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (!forced && elapsed >= termGraceMs) {
        forced = true;
        signalProcessTree(proc, "SIGKILL", posix);
      }
      if (elapsed >= termGraceMs + killWaitMs) {
        // 清理等待有界；截止前再补发一次，避免平台级状态检查异常拖住 TUI。
        signalProcessTree(proc, "SIGKILL", posix);
        cleanupDone = true;
        maybeFinish();
        return;
      }
      cleanupTimer = setTimeout(poll, CLEANUP_POLL_MS);
    };

    poll();
    return true;
  };

  const result = new Promise((resolve) => {
    resolveResult = resolve;
    proc.once("error", (error) => {
      const message = String(error?.message ?? error);
      if (!stderr) stderr = message;
      finish({ type: "spawn_failed", message });
    });
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      closeInfo = { code, signal };
      maybeFinish();
    });
  });

  timer = setTimeout(() => terminate("timed_out"), timeoutMs);

  return {
    result,
    interrupt: () => terminate("cancelled"),
  };
}

export function formatBashContext({ command, stdout, stderr, outcome }) {
  return (
    `<bash-input>${escapeXml(command)}</bash-input>\n` +
    `<bash-result>${escapeXml(formatBashOutcome(outcome))}</bash-result>\n` +
    `<bash-stdout>${escapeXml(stdout)}</bash-stdout>` +
    `<bash-stderr>${escapeXml(stderr)}</bash-stderr>`
  );
}

export function buildBashCardLines(stdout, stderr) {
  const lines = [];
  const out = String(stdout ?? "").replace(/\n+$/, "");
  const err = String(stderr ?? "").replace(/\n+$/, "");
  if (out) for (const text of out.split("\n")) lines.push({ text, err: false });
  if (err) for (const text of err.split("\n")) lines.push({ text, err: true });
  if (lines.length === 0) lines.push({ text: "(No output)", err: false });
  return lines;
}

/** 折叠时只保留开头 previewLines 行。 */
export function previewBashLines(lines, expanded, previewLines) {
  if (expanded || lines.length <= previewLines) return { visible: lines, hidden: 0 };
  return { visible: lines.slice(0, previewLines), hidden: lines.length - previewLines };
}
