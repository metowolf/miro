import process from "node:process";

import { loadStartupContext } from "./agents-md.js";
import { AcpClient } from "./acp/acp-client.js";
import { matchConfigChoice } from "./acp/config-options.js";
import {
  currentModelName,
  effortChoices,
  modelChoices,
} from "./acp/model.js";
import { isMiroProvider } from "./config.js";
import { MiroAgentClient } from "./miro/agent-client.js";
import { AUTO_WARNING, MANUAL_WARNING, isAuto, isManual } from "./miro/permission-mode.js";
import { detectProviders } from "./providers.js";
import { SessionRecorder } from "./session-store.js";
import { readEffortPreference, readHomeSettings, readModelPreference } from "./settings.js";
import { errorMessage } from "./utils.js";

export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;

function writeLine(stream, text) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function jsonResult({ output = "", exitCode = 1, sessionId = "", provider = "", stopReason = null, error = null, permissionDenials = [] }) {
  return {
    type: "result",
    subtype: exitCode === 0 ? "success" : "error_during_execution",
    is_error: exitCode !== 0,
    result: output,
    stop_reason: stopReason,
    session_id: sessionId,
    provider,
    permission_denials: permissionDenials,
    ...(error ? { error } : {}),
  };
}

export async function readPrompt(input, limit = MAX_PROMPT_BYTES) {
  if (input.isTTY) throw new Error("no prompt provided; pass one as an argument or pipe it on stdin");
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > limit) throw new Error(`stdin prompt exceeds ${limit} bytes`);
    chunks.push(bytes);
  }
  const prompt = Buffer.concat(chunks).toString("utf8").trim();
  if (!prompt) throw new Error("no prompt provided; pass one as an argument or pipe it on stdin");
  return prompt;
}

async function applyConfig(client, options, settings, resumed, providerId) {
  const models = modelChoices(client.modelConfig);
  const requestedModel = options.model ?? (!resumed ? readModelPreference(settings, providerId) : null);
  let model = matchConfigChoice(client.modelConfig, requestedModel);
  if (options.model && !model) throw new Error(`model "${options.model}" is not available`);
  if (!model && !resumed && models.length > 0) model = models[0];
  if (model && model.value !== client.modelConfig?.currentValue) await client.setModel(model.value);
  if (typeof client.enableThinking === "function") await client.enableThinking();

  const efforts = effortChoices(client.effortConfig);
  const requestedEffort = options.effort ?? (!resumed ? readEffortPreference(settings, providerId) : null);
  const effort = matchConfigChoice(client.effortConfig, requestedEffort);
  if (options.effort && !effort) throw new Error(`effort "${options.effort}" is not available`);
  if (effort && effort.value !== client.effortConfig?.currentValue) await client.setEffort(effort.value);
}

function selectProvider(options, settings, detected) {
  if (options.acp == null) return { id: "miro", name: "Miro", kind: "miro" };
  const provider = detected.find((item) => !isMiroProvider(item) && item.id === options.acp);
  if (provider) return provider;
  const available = detected.filter((item) => !isMiroProvider(item)).map((item) => item.id).join(", ") || "none";
  throw new Error(`ACP provider "${options.acp}" is not available; available ACP providers: ${available}`);
}

/** 执行一次 ACP prompt。stdout 只承载结果，诊断写入 stderr。 */
export async function runHeadless(options, dependencies = {}) {
  const input = dependencies.input ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const Client = dependencies.Client ?? AcpClient;
  const MiroAgent = dependencies.MiroAgentClient ?? MiroAgentClient;
  const settings = dependencies.settings ?? readHomeSettings();
  const detected = dependencies.providers ?? detectProviders();
  const loadContext = dependencies.loadContext ?? loadStartupContext;
  const createRecorder = dependencies.createRecorder ?? ((record) => new SessionRecorder(record));
  const signalTarget = dependencies.signalTarget ?? process;

  let provider;
  let client;
  let runPromise;
  let recorder;
  let sessionId = "";
  let assistantOutput = "";
  let stopReason = null;
  let signalCode = null;
  const permissionDenials = [];
  let resolveSignal;
  const signalled = new Promise((resolve) => { resolveSignal = resolve; });

  const finish = (result) => {
    if (options.outputFormat === "json") writeLine(stdout, JSON.stringify(result));
    else if (result.result) writeLine(stdout, result.result);
    if (options.outputFormat !== "json" && result.error) writeLine(stderr, `miro: ${result.error}`);
    return result.is_error ? result.exit_code ?? 1 : 0;
  };

  const onSignal = (code) => {
    if (signalCode != null) return;
    signalCode = code;
    client?.cancel();
    client?.close();
    resolveSignal({ signal: code });
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  signalTarget.on("SIGINT", onSigint);
  signalTarget.on("SIGTERM", onSigterm);

  try {
    const prompt = options.prompt ?? await readPrompt(input);
    provider = selectProvider(options, settings, detected);
    const { contextText } = loadContext({
      cwd: process.cwd(),
      settings,
      resumed: options.continueSessionId != null,
    });
    const common = {
      contextText,
      continueSessionId: options.continueSessionId,
    };
    // settings 显式透传：client 构造时缺省会再读一次磁盘，测试注入的配置
    // 就被 ~/.miro/settings.json 覆盖了。
    client = isMiroProvider(provider)
      ? new MiroAgent({ ...common, settings, permissionMode: options.permissionMode })
      : new Client({
        bin: provider.bin,
        args: provider.args,
        sessionMeta: provider.sessionMeta,
        ...common,
      });

    client.on("chunk", (text) => { assistantOutput += String(text ?? ""); });
    client.on("stderr", (text) => writeLine(stderr, `${client.bin}: ${text}`));
    // 压缩对调用方必须可见：stdout 只承载结果，水位骤降写 stderr。
    client.on("compacted", (payload) => {
      if (typeof payload?.notice === "string" && payload.notice.length > 0) {
        writeLine(stderr, payload.notice);
      }
    });
    // miro 的默认值与 settings 已在 client 合并，提示必须读实际档位。
    // auto 的常规操作已在循环里放行，到达这里的审批因无人确认而拒绝。
    const permissionMode = isMiroProvider(provider) ? client.permissionMode : options.permissionMode;
    const manual = permissionMode != null && isManual(permissionMode);
    const auto = permissionMode != null && isAuto(permissionMode);
    if (manual) writeLine(stderr, MANUAL_WARNING);
    if (auto) writeLine(stderr, AUTO_WARNING);

    client.onPermissionRequest = async (params) => {
      const rejected = params.options?.find((option) => option.kind === "reject_once") ??
        params.options?.find((option) => option.kind === "reject_always");
      const description = params.toolCall?.rawInput?.command ?? params.toolCall?.title ?? "tool call";
      permissionDenials.push({ tool_call_id: params.toolCall?.toolCallId ?? null, description });
      writeLine(stderr, `miro: denied permission request: ${description}`);
      return rejected?.optionId ?? null;
    };

    const ready = new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("fatal", ({ error }) => reject(error));
    });
    runPromise = client.run();
    const readyResult = await Promise.race([ready, signalled]);
    if (readyResult?.signal) return readyResult.signal;

    sessionId = readyResult.sessionId;
    await applyConfig(client, options, settings, readyResult.resumed, provider.id);
    recorder = createRecorder({ sessionId, providerId: provider.id, model: currentModelName(client.modelConfig) });
    recorder.recordBlock({ role: "user", text: prompt });
    recorder.recordModel(currentModelName(client.modelConfig));

    const promptResult = await Promise.race([client.prompt(prompt), signalled]);
    if (promptResult?.signal) return promptResult.signal;
    stopReason = promptResult?.stopReason ?? null;
    const exitCode = stopReason === "end_turn" ? 0 : 1;
    if (assistantOutput) recorder.recordBlock({ role: "assistant", text: assistantOutput });
    return finish({
      ...jsonResult({
        output: assistantOutput,
        exitCode,
        sessionId,
        provider: provider.id,
        stopReason,
        permissionDenials,
        error: exitCode === 0 ? null : `request stopped: ${stopReason ?? "unknown"}`,
      }),
      exit_code: exitCode,
    });
  } catch (error) {
    if (signalCode != null) return signalCode;
    return finish({
      ...jsonResult({
        output: assistantOutput,
        exitCode: 1,
        sessionId,
        provider: provider?.id ?? "",
        stopReason,
        permissionDenials,
        error: errorMessage(error),
      }),
      exit_code: 1,
    });
  } finally {
    signalTarget.off("SIGINT", onSigint);
    signalTarget.off("SIGTERM", onSigterm);
    client?.close();
    await runPromise;
  }
}
