/**
 * terminal：唯一的命令工具。
 *
 * 工具名固定为 `terminal`，`miro.sandbox.enabled` 只决定它跑在哪条执行路径上：
 *
 * - 关闭（默认）：宿主 shell，与用户手敲命令行等价，出网命令按普通命令审批；
 * - 开启：`@anthropic-ai/sandbox-runtime` 在 OS 层限制网络，多出 `allowedDomains`
 *   与 `sandbox` 两个参数。
 *
 * 因此模型始终只看到一个叫 terminal 的工具，两种模式只在参数集与执行器上分叉，
 * 不会出现「同一个能力换名字」而让配置、审批记忆与文档各自漂移。
 *
 * SandboxManager 是进程级单例，不能让两条命令在不同策略下同时包装；本模块
 * 因此串行化整个「配置 → 包装 → 执行」区间，避免某个 subagent 的域名白名单
 * 泄漏给另一条命令。
 */

import { stat } from "node:fs/promises";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

import { RISK_LEVELS, RISK_LEVEL_DESCRIPTION } from "../risk-level.js";
import { textContent, truncate } from "./shared.js";

const EXECUTE_MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/** 两种模式共有的参数；差异只在沙箱模式追加的 allowedDomains / sandbox。 */
const BASE_PARAMETERS = {
  command: { type: "string", description: "Shell command to run." },
  risk_level: {
    type: "string",
    enum: [...RISK_LEVELS],
    description: RISK_LEVEL_DESCRIPTION,
  },
  workdir: {
    type: "string",
    description: "Directory to run the command in, absolute or relative to the workspace (default: workspace root).",
  },
  timeout_ms: {
    type: "integer",
    description: "Kill the command after this many milliseconds (default 120000, min 1000, max 600000).",
  },
};

/** 宿主模式：没有 OS 沙箱，出网命令与危险命令都按命令权限模式审批。 */
export const TERMINAL_DEFINITION = {
  name: "terminal",
  kind: "execute",
  title: "Terminal",
  description:
    "Run a shell command in the workspace. Non-interactive; output is captured. Always set risk_level; read-only commands marked \"low\" run without interrupting the user for approval. Optional workdir avoids wrapping the command in cd; optional timeout_ms overrides the 120s default (clamped to 1s–10min). The host shell is used: there is no OS sandbox, so outbound network commands require approval.",
  parameters: {
    type: "object",
    properties: { ...BASE_PARAMETERS },
    required: ["command", "risk_level"],
  },
};

/** 沙箱模式：同一工具多出两个沙箱参数（`miro.sandbox.enabled` 为真时使用）。 */
export const SANDBOX_TERMINAL_DEFINITION = {
  ...TERMINAL_DEFINITION,
  description:
    "Run a shell command with sandboxed network access. Network access is denied unless allowedDomains is provided; filesystem access follows host permissions. Set sandbox to false only when the host shell is genuinely required; that always requires approval.",
  parameters: {
    type: "object",
    properties: {
      ...BASE_PARAMETERS,
      allowedDomains: {
        type: "array",
        items: { type: "string" },
        description: "Domains allowed for this sandboxed invocation only. Empty or omitted means no network access.",
      },
      sandbox: { type: "boolean", description: "Whether to use the sandbox (default true). false always requires approval." },
    },
    required: ["command", "risk_level"],
  },
};

/** 按沙箱开关取当前模式的定义。签名与 activeToolDefinitions 保持一致。 */
export function terminalDefinition(sandboxEnabled = false) {
  return sandboxEnabled === true ? SANDBOX_TERMINAL_DEFINITION : TERMINAL_DEFINITION;
}

/** 相对路径相对工作区；空值回退 cwd。与 permission-mode 的 workdir 解析同规则。 */
export function resolveCommandWorkdir(cwd, input) {
  const raw = typeof input?.workdir === "string" ? input.workdir.trim() : "";
  if (!raw) return cwd;
  return raw.startsWith("/") ? raw : `${cwd}/${raw}`.replace(/\/{2,}/g, "/");
}

export function resolveCommandTimeoutMs(input) {
  const raw = Number(input?.timeout_ms);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
}

function outcomeTextOf(outcome) {
  return outcome?.type === "exited"
    ? `exit ${outcome.code}`
    : outcome?.type === "signaled"
      ? `signal ${outcome.signal}`
      : (outcome?.type ?? "unknown");
}

/** 共享的收尾：结局行 + stdout/stderr 正文，两者都截断。 */
function outputFromParts({ stdout, stderr, outcome }, maxOutput = EXECUTE_MAX_OUTPUT) {
  const body = [stdout, stderr].filter((part) => part && part.trim().length > 0).join("\n");
  const output = truncate(`[${outcomeTextOf(outcome)}]\n${body}`.trim(), maxOutput);
  return {
    output,
    content: textContent(output),
    rawOutput: {
      stdout: truncate(stdout ?? "", maxOutput),
      stderr: truncate(stderr ?? "", maxOutput),
    },
    failed: outcome?.type === "exited" && outcome.code !== 0,
  };
}

/** 解析并校验 command 与 workdir；失败返回 { error }。 */
async function resolveInvocation(cwd, input) {
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  if (!command) return { error: "terminal: missing required parameter 'command'" };

  const workdir = resolveCommandWorkdir(cwd, input);
  try {
    const info = await stat(workdir);
    if (!info.isDirectory()) return { error: `terminal: workdir is not a directory: ${workdir}` };
  } catch {
    return { error: `terminal: workdir not found: ${workdir}` };
  }
  return { command, workdir };
}

/** 起一条宿主命令并等它收尾；复用 src/bash.js 的进程组管理与超时截断。 */
async function runHostCommand(startBash, { command, workdir, timeoutMs, signal }) {
  const { result, interrupt } = startBash(command, { cwd: workdir, timeoutMs });
  const onAbort = () => interrupt();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return outputFromParts(await result);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 宿主分支（沙箱关闭，以及沙箱模式下显式 `sandbox: false`）。
 *
 * 出网与危险命令的审批由循环层负责，这里只负责执行与输出。
 */
export function hostTerminalTool(cwd, { startBash } = {}) {
  return async (input, { signal = null } = {}) => {
    const invocation = await resolveInvocation(cwd, input);
    if (invocation.error) return { error: invocation.error };
    return runHostCommand(startBash, {
      command: invocation.command,
      workdir: invocation.workdir,
      timeoutMs: resolveCommandTimeoutMs(input),
      signal,
    });
  };
}

// Explore 的 shell 仍然有价值（git log/diff、find、ls），但不能把「只读」
// 交给模型自觉。这里是一个故意保守的词法白名单：每个管道/分隔段都必须是
// 观察类命令，且不允许重定向。复杂命令宁可回退到 read_file/grep，也不能让
// Explore 始终使用只读执行器。
const READONLY_COMMANDS = new Map([
  ["git", new Set(["status", "log", "diff", "show", "branch", "remote", "describe", "blame", "ls-files", "ls-tree", "rev-parse", "shortlog", "whatchanged", "cat-file", "for-each-ref", "grep"])],
  ["ls", null],
  ["pwd", null],
  ["cat", null],
  ["head", null],
  ["tail", null],
  ["find", null],
  ["grep", null],
  ["rg", null],
  ["wc", null],
  ["file", null],
  ["which", null],
  ["type", null],
  ["whereis", null],
  ["realpath", null],
  ["readlink", null],
  ["stat", null],
  ["du", null],
  ["df", null],
  ["tree", null],
  ["uname", null],
  ["id", null],
  ["whoami", null],
  ["printenv", null],
  ["ps", null],
  ["echo", null],
  ["printf", null],
  ["command", new Set(["-v", "-V"])],
]);

const COMMAND_SEPARATOR = /\s*(?:;|&&|\|\||\|)\s*/;

/** Explore 专用只读执行器只需识别每段实际调用的命令名。 */
function commandAndArgs(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^(sudo|nohup|env)$/.test(tokens[index])) {
    index += 1;
    while (index < tokens.length && /^-/.test(tokens[index])) index += 1;
  }
  while (index < tokens.length && tokens[index].includes("=")) index += 1;
  return tokens.slice(index);
}

/** `/dev/null` 只丢弃输出，不会改变项目；其余重定向仍全部拒绝。 */
function stripSafeRedirections(command) {
  return command
    .replace(/(?:^|\s)(?:\d*>\s*\/dev\/null|2>&1)(?=\s|$)/g, " ")
    .trim();
}

/** 只允许查询可执行文件位置这一种命令替换。 */
function stripSafeCommandSubstitutions(command) {
  const stripped = command.replace(
    /\$\(\s*command\s+-(?:v|V)\s+(?:\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._+-]+)\s*\)/g,
    "__command_path__",
  );
  return stripped.includes("$(") || stripped.includes("`") ? null : stripped;
}

function segmentsAreReadOnly(command) {
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const tokens = commandAndArgs(segment);
    const name = tokens[0];
    if (!name || name.includes("/") || !READONLY_COMMANDS.has(name)) return false;
    const subcommands = READONLY_COMMANDS.get(name);
    if (subcommands != null) {
      const subcommand = tokens.slice(1).find((token) => token === "-v" || token === "-V" || !token.startsWith("-"));
      if (!subcommand || !subcommands.has(subcommand)) return false;
    }
    if (name === "git") {
      const subcommandIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith("-"));
      const subcommand = tokens[subcommandIndex];
      const args = tokens.slice(subcommandIndex + 1);
      // 输出文件与外部 diff/textconv 会绕开「只读子命令」这一层。
      if (tokens.some((token) => /^--output(?:=|$)|^--ext-diff$|^--textconv$/.test(token))) return false;
      if (subcommand === "branch") {
        const safe = /^(?:-a|-r|-v|-vv|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--sort=.*|--format=.*)$/;
        if (args.some((token) => !safe.test(token))) return false;
      }
      if (subcommand === "remote") {
        const safeRemote = args.length === 0 || (args.length === 1 && args[0] === "-v") ||
          (args[0] === "get-url" && args.slice(1).every((token) => token === "--all" || token === "--push" || !token.startsWith("-")));
        if (!safeRemote) return false;
      }
    }
    // find 的这些动作会删除文件、运行任意命令或写出结果文件。
    if (name === "find" && tokens.some((token) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf)$/.test(token))) {
      return false;
    }
  }
  return true;
}

/** 支持 `for x in a b; do <只读命令>; done` 这类常见环境探测。 */
function readOnlyForLoop(command) {
  const match = command.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]+);\s*do\s+(.+);\s*done$/s);
  if (!match) return null;
  const [, variable, rawItems, body] = match;
  const items = rawItems.trim().split(/\s+/).filter(Boolean);
  if (items.length === 0 || items.some((item) => !/^[A-Za-z0-9._+-]+$/.test(item))) return false;
  // body 只能引用循环变量；其它参数展开、算术与通配执行语法不进入宿主 shell。
  const expansions = body.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (expansions.some((item) => item !== `$${variable}`)) return false;
  return segmentsAreReadOnly(body);
}

export function isReadOnlyCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  let normalized = stripSafeCommandSubstitutions(command.trim());
  if (normalized == null) return false;
  normalized = stripSafeRedirections(normalized);
  // 其余重定向能创建/截断文件；换行、子 shell 与后台执行也扩大了解析边界。
  if (/[<>\n\r]|\(\s*[^)]|&\s*$/.test(normalized)) return false;
  const loop = readOnlyForLoop(normalized);
  if (loop != null) return loop;
  return segmentsAreReadOnly(normalized);
}

export function readOnlyHostTerminalTool(cwd, options = {}) {
  const execute = hostTerminalTool(cwd, options);
  return async (input, context) => {
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    if (!isReadOnlyCommand(command)) {
      const output =
        "This terminal is read-only. Use inspection commands such as ls, find, grep/rg, cat, " +
        "command -v, which, or read-only git commands; only /dev/null output redirection is allowed.";
      return { error: output, content: textContent(output), failed: true };
    }
    return execute(input, context);
  };
}

/** 这层只约束网络；文件系统完全沿用宿主权限。 */
export function sandboxPolicy(allowedDomains) {
  return {
    network: { allowedDomains, deniedDomains: [], strictAllowlist: true },
    // sandbox-runtime 缺省会生成「写入全拒绝」的文件系统策略；明确 disabled
    // 才是只启用网络隔离，且会跳过其 Git 配置等强制文件保护挂载。
    filesystem: { disabled: true },
  };
}

export function normalizeAllowedDomains(value) {
  if (value == null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: "terminal: allowedDomains must be an array of domain strings" };
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      return { ok: false, error: "terminal: allowedDomains must contain non-empty domain strings" };
    }
    seen.add(item.trim());
  }
  return { ok: true, value: [...seen] };
}

let initialized = false;
let queue = Promise.resolve();

function exclusive(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

/**
 * 会话收尾：拆掉沙箱运行时留在宿主进程里的桥与 mux proxy。
 *
 * `initialize()` 会在宿主侧起一个常驻的 socat 桥子进程（UNIX-LISTEN → mux proxy
 * 的 TCP 端口），它既没有 unref，也不是 no-op 的资源：只要它活着，事件循环就永远
 * 不空。而退出路径只卸载 Ink、把 `process.exitCode` 交给运行时（没有 `process.exit()`），
 * 于是 TUI 没了、终端却回不到 shell——表现为「Ctrl+C 连按也退不出去」。
 *
 * 收尾必须和命令排队共用 `exclusive()`：resetting 的同时包装或执行另一条命令，
 * 会把它的桥从脚下拆掉。
 */
export async function shutdownSandbox({ sandboxManager = SandboxManager } = {}) {
  try {
    return await exclusive(async () => {
      if (!initialized) return false;
      // 先复位再 reset：拆桥失败也只该让下一条命令重新 initialize，
      // 而不是留下「以为桥还在」的状态。
      initialized = false;
      try {
        await sandboxManager.reset?.();
      } catch {
        // 收尾失败不能挡住退出：最多是残留句柄让进程晚一点结束。
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * `isSandboxingEnabled()` 只表示 manager 已经 initialize 过，首次调用必为 false；
 * 可用性必须由平台能力与依赖探测共同决定。
 */
export async function sandboxUnavailableReason(sandboxManager) {
  if (!sandboxManager.isSupportedPlatform()) return "sandbox runtime is not supported on this platform";
  const dependencies = await sandboxManager.checkDependenciesAsync();
  const errors = Array.isArray(dependencies?.errors) ? dependencies.errors.filter(Boolean) : [];
  return errors.length > 0 ? `sandbox runtime prerequisites are missing: ${errors.join("; ")}` : null;
}

/**
 * 沙箱分支：网络走 sandbox-runtime 的 allowedDomains，`sandbox: false` 退回宿主分支。
 * 保留既有超时、进程组与取消语义。
 */
export function sandboxedTerminalTool(cwd, { startBash, sandboxManager = SandboxManager } = {}) {
  return async (input, { signal = null, toolCallId = null } = {}) => {
    const sandbox = input?.sandbox !== false;
    const domains = normalizeAllowedDomains(input?.allowedDomains);
    if (!domains.ok) return { error: domains.error };
    if (!sandbox && domains.value.length > 0) {
      return { error: "terminal: allowedDomains cannot be used when sandbox is false" };
    }

    const invocation = await resolveInvocation(cwd, input);
    if (invocation.error) return { error: invocation.error };
    const { command, workdir } = invocation;

    if (!sandbox) {
      return runHostCommand(startBash, { command, workdir, timeoutMs: resolveCommandTimeoutMs(input), signal });
    }
    return exclusive(async () => {
      const policy = sandboxPolicy(domains.value);
      const commandId = toolCallId ?? `terminal-${crypto.randomUUID()}`;
      try {
        if (!initialized) {
          const unavailable = await sandboxUnavailableReason(sandboxManager);
          if (unavailable) return { error: `terminal: ${unavailable}` };
          await sandboxManager.initialize(policy);
          initialized = true;
        } else {
          sandboxManager.updateConfig(policy);
        }
        const wrapped = await sandboxManager.wrapWithSandboxArgv(
          command,
          undefined,
          policy,
          signal ?? undefined,
          workdir,
          { commandId, commandText: command },
        );
        const { result, interrupt } = startBash(command, {
          cwd: workdir,
          timeoutMs: resolveCommandTimeoutMs(input),
          argv: wrapped.argv,
          env: wrapped.env,
        });
        const onAbort = () => interrupt();
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          const { stdout, stderr, outcome } = await result;
          let annotatedStderr = stderr ?? "";
          try {
            annotatedStderr = sandboxManager.annotateStderrWithSandboxFailures(commandId, annotatedStderr);
          } catch {
            // 违规注释只是附加诊断，不能遮住命令本身的输出。
          }
          return outputFromParts({ stdout, stderr: annotatedStderr, outcome });
        } finally {
          if (signal) signal.removeEventListener("abort", onAbort);
          sandboxManager.cleanupAfterCommand?.();
        }
      } catch (error) {
        return { error: `terminal: sandbox setup failed: ${error?.message ?? String(error)}` };
      }
    });
  };
}
