import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { Validator } from "@cfworker/json-schema";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { CODEMODE_TOOL_NAMES } from "./codemode.ts";
import { createCodemodeScheduler } from "./codemode-scheduler.ts";
import { createWorkerGate } from "./codemode-worker-slot.ts";
import { textContent } from "./shared.ts";
import { fileURLToPath } from "node:url";
import type { CodemodeWorkerGate } from "./codemode-worker-slot.ts";
import type { ToolDefinition, ToolResult } from "./types.ts";
import type { Schema } from "@cfworker/json-schema";

export interface CodemodeLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxCalls: number;
  maxCodeChars: number;
  maxCallBytes: number;
  maxTotalBytes: number;
  maxOutputChars: number;
}

export const CODEMODE_LIMITS: Readonly<CodemodeLimits> = Object.freeze({
  timeoutMs: 60_000, memoryLimitBytes: 64 * 1024 * 1024, maxCalls: 64,
  maxCodeChars: 65_536, maxCallBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  maxOutputChars: 32_768,
});

/** build.ts 的两条产物路径都用输出入口名；编译版从 /$bunfs 的模块位置解析。 */
function workerUrl() {
  if (typeof __MIRO_BUNDLED__ !== "undefined" && __MIRO_BUNDLED__) return new URL("./codemode-worker.js", import.meta.url);
  return new URL("./codemode-worker.ts", import.meta.url);
}

/** 进程级「活着的 worker」槽位：子 agent 的 codemode 与主回合共用同一个上限。 */
const WORKER_GATE = createWorkerGate();

/** 本层只管理 VM、预算和调度；真实授权及 runner 来自当前 agent loop。 */
export async function runCodemode(input: any, context: any, definitions: ToolDefinition[], limits = CODEMODE_LIMITS, { gate = WORKER_GATE }: { gate?: CodemodeWorkerGate } = {}): Promise<ToolResult> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "code") ||
      typeof input.code !== "string" || !input.code.trim() || input.code.length > limits.maxCodeChars) {
    return { error: `codemode: expected a non-empty code string of at most ${limits.maxCodeChars} characters` };
  }
  if (typeof context?.executeNested !== "function") return { error: "codemode: nested execution context is unavailable" };
  const controller = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  const scheduler = createCodemodeScheduler();
  let count = 0;
  let totalBytes = 0;
  let fatal: string | null = null;
  let unfinished = false;
  const failBudget = (message: string): never => {
    fatal ??= message;
    controller.abort(new Error(message));
    throw new Error(message);
  };
  const account = (value: unknown) => {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json ?? "null", "utf8");
    if (bytes > limits.maxCallBytes) failBudget("Codemode per-call data budget exceeded; refine the query or page the result.");
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) failBudget("Codemode cumulative tool data budget exceeded.");
    return json === undefined ? null : JSON.parse(json);
  };
  const tools = definitions.filter((definition) => CODEMODE_TOOL_NAMES.has(definition.name)).map((definition) => {
    // 定义来自本地白名单；共享 JsonSchema 保留供应方扩展，校验器按自身类型消费。
    const validator = new Validator(definition.parameters as Schema, "2020-12", true);
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
      execute: async (args: unknown, toolContext: { signal: AbortSignal }) => {
        signal.throwIfAborted();
        if (++count > limits.maxCalls) failBudget(`Codemode tool-call limit (${limits.maxCalls}) exceeded.`);
        const index = count;
        const callSignal = AbortSignal.any([signal, toolContext.signal]);
        const safeArgs = account(args ?? {});
        const validation = validator.validate(safeArgs);
        if (!validation.valid) throw new Error(`Invalid ${definition.name} arguments: ${validation.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join("; ")}`);
        const task = scheduler.schedule(definition.name !== "mcp_call", callSignal, async () => {
          callSignal.throwIfAborted();
          const result: ToolResult = await context.executeNested(definition, safeArgs, { signal: callSignal, index });
          if (result.error || result.failed) throw new Error(result.error ?? result.output ?? `${definition.name} failed`);
          if (callSignal.aborted) unfinished = true;
          return account({ output: result.output ?? "", data: result.structuredContent ?? null });
        });
        // Worker 在 return/exit/失败时会取消未 await 的宿主调用；必须等宿主收尾。
        try { return await task; }
        catch (error) { if (toolContext.signal.aborted) unfinished = true; throw error; }
      },
    };
  });
  // 上一个 worker 真正退出前不开新的 VM：结果 settle 与 close() 只表示已请求停止。
  const slot = await gate.acquire({ signal });
  let workerStarted = false;
  let result;
  try {
    const sandbox = new CodemodeSandbox({ tools, timeoutMs: limits.timeoutMs, memoryLimitBytes: limits.memoryLimitBytes,
      wasm: loadQuickJSWasm(fileURLToPath(new URL(wasmPath, import.meta.url))), workerUrl: workerUrl(),
      // 槽位交给真正退出的那一刻；重复归还在 gate 内是空操作。
      onWorkerStarted(exited: Promise<void>) {
        workerStarted = true;
        void exited.then(slot.release, slot.release);
      } });
    try {
      result = await sandbox.execute(input.code, { signal });
    } finally {
      await sandbox.close();
    }
  } finally {
    await scheduler.close();
    // 没走到 worker（wasm 装载或构造失败）时立即归还，否则由 onWorkerStarted 归还。
    if (!workerStarted) slot.release();
  }
  const clip = (text: string, max: number) => {
    const marker = "\n[output truncated]";
    if (text.length <= max) return text;
    return max <= marker.length ? text.slice(0, max) : `${text.slice(0, max - marker.length)}${marker}`;
  };
  const parts: string[] = [];
  let chars = 0;
  for (const item of result.output) {
    const part = item.type === "text" ? item.text : "[Codemode image omitted: only text output is supported]";
    parts.push(clip(part, Math.max(0, limits.maxOutputChars - chars)));
    chars += part.length + 1;
    if (chars >= limits.maxOutputChars) break;
  }
  if (result.ok && result.value !== undefined) parts.push(JSON.stringify(result.value));
  const notices: string[] = [];
  if (!result.ok) notices.push(clip(`Codemode ${result.error.kind}: ${result.error.message}`, 4096));
  if (fatal) notices.push(fatal);
  if (unfinished || result.calls.some((call) => call.status === "cancelled")) {
    unfinished = true;
    notices.push("Unawaited or cancelled tool calls were stopped. Remote effects may have occurred; verify before retrying and await every call.");
  }
  const summary = result.calls.slice(0, limits.maxCalls).map((call) => `${call.name}: ${call.status}`).join(", ");
  notices.push(`Calls (${count}): ${summary || "none"}`);
  // 为诊断留空间，不能把失败原因截在海量 text() 后面。
  const suffix = clip(notices.join("\n"), limits.maxOutputChars);
  const body = clip(parts.join("\n"), Math.max(0, limits.maxOutputChars - suffix.length - 2));
  const output = body ? `${body}\n\n${suffix}` : suffix;
  return { output, content: textContent(output), failed: !result.ok || fatal != null || unfinished };
}
