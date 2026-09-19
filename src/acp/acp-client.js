import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { APP_NAME, APP_VERSION, PROVIDERS } from "../config.js";
import { normalizeSessionMeta } from "../providers.js";
import { errorMessage } from "../utils.js";
import { AcpSessionRecorder, createRecordingTransform } from "./session-recorder.js";
import { isSpawnAgentTool } from "./subagent.js";
import {
  currentEffortName,
  currentModelName,
  effortConfigFrom,
  modelConfigFrom,
  thinkingConfigFrom,
  thinkingOnValue,
} from "./model.js";

/** 无参构造时的兜底默认值：跟随内置 provider 列表首项，不再硬编码具体 provider。 */
const [DEFAULT_PROVIDER] = PROVIDERS;

/** session/load 回放中可丢弃的历史更新类型。 */
const REPLAYABLE_UPDATES = new Set([
  "agent_message_chunk",
  "user_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** ACP 会话事件源：UI 只订阅事件，不接触 JSON-RPC 与子进程。 */
export class AcpClient extends EventEmitter {
  constructor({
    bin = DEFAULT_PROVIDER?.bin,
    args = DEFAULT_PROVIDER?.args ?? [],
    cwd = process.cwd(),
    contextText = null,
    continueSessionId = null,
    resumeContext = null,
    recordRawThinking = false,
    mcpServers = [],
    sessionMeta = null,
  } = {}) {
    super();
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.contextText = contextText;
    this.continueSessionId = continueSessionId;
    this.resumeContext = resumeContext;
    // 恢复的会话里 AGENTS.md 已经在原会话注入过，再来一份只会让历史出现
    // 第二份同样的规则，所以直接当作已注入。
    this.contextSent = continueSessionId != null;
    this.mcpServers = mcpServers;
    this.sessionMeta = normalizeSessionMeta(sessionMeta);
    this.proc = null;
    this.context = null;
    this.sessionId = null;
    this.loadingReplay = false;
    this.replayUpdates = [];
    this.suppressReplay = false;
    this.modelConfig = null;
    this.effortConfig = null;
    this.thinkingConfig = null;
    this.configOptions = [];
    this.modes = null;
    this.startupInfo = null;
    this.optimisticConfig = null;
    this.fatalError = null;
    this.closed = false;
    this.recorder = new AcpSessionRecorder({
      cwd: this.cwd,
      recordRawThinking,
      onError: (error) => {
        if (!this.closed) {
          this.emit("stderr", `Failed to write ACP session log: ${errorMessage(error)}`);
        }
      },
    });
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.onPermissionRequest = async () => null;
  }

  async run() {
    const proc = spawn(this.bin, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text && !this.closed) this.emit("stderr", text);
    });

    proc.once("error", (error) => {
      this.fail(error, `Failed to start ${this.bin}: ${errorMessage(error)}`);
    });

    proc.once("exit", (code, signal) => {
      const reason = signal ?? `code ${code}`;
      this.fail(new Error(`${this.bin} exited (${reason})`));
    });

    const outbound = createRecordingTransform(this.recorder, "client");
    const inbound = createRecordingTransform(this.recorder, "agent");
    outbound.pipe(proc.stdin);
    proc.stdout.pipe(inbound);
    const stream = acp.ndJsonStream(Writable.toWeb(outbound), Readable.toWeb(inbound));

    try {
      await acp
        .client({ name: APP_NAME, version: APP_VERSION })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
          this.requestPermission(params)
        )
        .onNotification(acp.methods.client.session.update, ({ params }) =>
          this.receiveUpdate(params)
        )
        .connectWith(stream, async (ctx) => {
          this.context = ctx;
          this.emit("progress", "Initializing ACP…");
          const initialized = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          this.agentCapabilities = initialized.agentCapabilities ?? {};
          this.agentInfo = initialized.agentInfo;

          const resumed = this.continueSessionId != null;
          if (resumed) {
            if (initialized.agentCapabilities?.loadSession !== true) {
              throw new Error(`${this.bin} does not support loading ACP sessions`);
            }
            this.sessionId = this.continueSessionId;
            await this.recorder.start(this.sessionId);
            this.loadingReplay = true;
            this.emit("progress", "Loading ACP session…");
            const sessionResponse = await ctx.request(acp.methods.agent.session.load, {
              sessionId: this.sessionId,
              cwd: this.cwd,
              mcpServers: this.mcpServers,
            });
            this.loadingReplay = false;
            this.updateConfigs(sessionResponse?.configOptions);
            this.modes = sessionResponse?.modes ?? null;
          } else {
            this.emit("progress", "Creating ACP session…");
            const sessionResponse = await ctx.request(
              acp.methods.agent.session.new,
              this.sessionNewParams(),
            );
            this.sessionId = sessionResponse.sessionId;
            await this.recorder.start(this.sessionId);
            this.startupInfo = sessionResponse?._meta?.piAcp?.startupInfo ?? null;
            this.updateConfigs(sessionResponse?.configOptions);
            this.modes = sessionResponse?.modes ?? null;
          }
          this.emit("ready", this.sessionPayload(resumed));
          for (const update of this.replayUpdates.splice(0)) {
            if (this.suppressReplay && REPLAYABLE_UPDATES.has(update.sessionUpdate)) continue;
            this.handleUpdate(update);
          }
          this.suppressReplay = false;
          await this.done;
        });
    } catch (error) {
      await this.settleExit();
      this.fail(error, `Connection lost: ${errorMessage(error)}`);
    } finally {
      this.kill();
      await this.recorder.close();
    }

    return this.fatalError;
  }

  /** 等子进程 exit（最多 grace 毫秒）。 */
  async settleExit(grace = 100) {
    const proc = this.proc;
    if (!proc || proc.exitCode != null || proc.signalCode != null) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        proc.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(finish, grace);
      proc.once("exit", finish);
    });
  }

  async prompt(content, { injectContext = true } = {}) {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const inject = injectContext && !this.contextSent;
    if (inject) this.contextSent = true;
    const prefix = inject
      ? [
          ...(this.resumeContext != null ? [{ type: "text", text: this.resumeContext }] : []),
          ...(this.contextText != null ? [{ type: "text", text: this.contextText }] : []),
        ]
      : [];
    const payload = prefix.length > 0 ? [...prefix, ...blocks] : blocks;

    try {
      const response = await this.context.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: payload,
      });
      // usage 在 ACP 中是 UNSTABLE 可选字段，agent 未返回时静默跳过。协议里这几个
      // 数是**会话累计**快照（totalTokens 是 "Sum of all token types across session"），
      // 所以必须带上口径标记：store 按增量累加，误当增量会让用量成倍虚高。
      if (response?.usage) this.emit("token_usage", { ...response.usage, sessionCumulative: true });
      return response;
    } catch (error) {
      if (inject) this.contextSent = false;
      throw error;
    }
  }

  sessionPayload(resumed) {
    return {
      agentName: this.agentInfo?.name ?? "Miro",
      modelConfig: this.modelConfig,
      effortConfig: this.effortConfig,
      configOptions: this.configOptions,
      modes: this.modes,
      sessionId: this.sessionId,
      resumed,
    };
  }

  /**
   * session/new 载荷。settings.providers.*.sessionMeta 有值时放进 `_meta`，
   * 让按 agentId 路由的 ACP 后端认出要复用哪条逻辑 agent。
   * 没有配置时不带该字段，避免给不认识扩展的 agent 多一个空对象。
   */
  sessionNewParams() {
    const params = {
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    };
    if (this.sessionMeta != null) params._meta = this.sessionMeta;
    return params;
  }

  cancel() {
    if (!this.context || !this.sessionId) return;
    void this.context.notify(acp.methods.agent.session.cancel, {
      sessionId: this.sessionId,
    });
  }

  async setConfigOption(configId, value) {
    this.optimisticConfig = { configId, value, expiresAt: Date.now() + 3000 };
    const response = await this.context.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.sessionId,
      configId,
      value,
    });
    this.updateConfigs(response.configOptions);
    this.applyOptimisticConfig();
    this.emitConfig();
  }

  /** 窗口期内用刚提交的值覆盖过期回推。 */
  applyOptimisticConfig() {
    const opt = this.optimisticConfig;
    if (!opt) return;
    if (Date.now() > opt.expiresAt) {
      this.optimisticConfig = null;
      return;
    }
    if (Array.isArray(this.configOptions)) {
      this.configOptions = this.configOptions.map((item) =>
        item?.id === opt.configId && item.currentValue !== opt.value
          ? { ...item, currentValue: opt.value }
          : item
      );
    }
    for (const config of [this.modelConfig, this.effortConfig, this.thinkingConfig]) {
      if (config && config.id === opt.configId && config.currentValue !== opt.value) {
        config.currentValue = opt.value;
      }
    }
  }

  /** 仅在 options 包含可开启值时打开 thinking，再刷新 reasoning_effort。 */
  async enableThinking() {
    const config = this.thinkingConfig;
    const on = thinkingOnValue(config);
    if (on == null || config.currentValue === on) return;
    await this.setConfigOption(config.id, on);
  }

  /** 切换模型。 */
  async setModel(value) {
    await this.setConfigOption(this.modelConfig.id, value);
    await this.enableThinking().catch(() => {});
    return currentModelName(this.modelConfig);
  }

  /** 设置思考强度。 */
  async setEffort(value) {
    await this.enableThinking().catch(() => {});
    await this.setConfigOption(this.effortConfig.id, value);
    return currentEffortName(this.effortConfig) ?? value;
  }

  /** 切换会话模式。 */
  async setMode(modeId) {
    await this.context.request(acp.methods.agent.session.setMode, {
      sessionId: this.sessionId,
      modeId,
    });
    if (this.modes) {
      this.modes = { ...this.modes, currentModeId: modeId };
      this.emit("mode", this.modes);
    }
    if (Array.isArray(this.configOptions)) {
      this.configOptions = this.configOptions.map((item) =>
        item?.id === "mode" || item?.category === "mode" ? { ...item, currentValue: modeId } : item
      );
    }
    this.emitConfig();
    return modeId;
  }

  /** 从 configOptions 刷新本地缓存。 */
  updateConfigs(configOptions) {
    if (Array.isArray(configOptions)) this.configOptions = configOptions;
    this.modelConfig = modelConfigFrom(configOptions) ?? this.modelConfig;
    this.effortConfig = effortConfigFrom(configOptions) ?? this.effortConfig;
    this.thinkingConfig = thinkingConfigFrom(configOptions) ?? this.thinkingConfig;
  }

  emitConfig() {
    this.emit("config", {
      modelConfig: this.modelConfig,
      effortConfig: this.effortConfig,
      configOptions: this.configOptions,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.resolveDone();
    this.kill();
  }

  receiveUpdate(params) {
    if (!this.sessionId || params.sessionId !== this.sessionId) return;
    if (this.loadingReplay) {
      this.replayUpdates.push(params.update);
      return;
    }
    this.handleUpdate(params.update);
  }

  handleUpdate(update) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          const text = update.content.text;
          const startupInfo = this.startupInfo;
          this.startupInfo = null;
          if (startupInfo != null && text.trim() === startupInfo.trim()) {
            this.emit("info", text);
          } else {
            this.emit("chunk", text, update.messageId);
          }
        }
        break;
      case "user_message_chunk":
        if (update.content?.type === "text") {
          this.emit("user_chunk", update.content.text, update.messageId);
        }
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text") {
          this.emit("thought", update.content.text);
        }
        break;
      case "plan":
        this.emit("plan", Array.isArray(update.entries) ? update.entries : []);
        break;
      case "tool_call":
      case "tool_call_update":
        if (
          update.sessionUpdate === "tool_call" ||
          update.title ||
          update.status ||
          update.name ||
          update.rawInput ||
          update.rawOutput ||
          update.locations ||
          update.content
        ) {
          this.emit("tool", {
            kind: update.sessionUpdate,
            toolCallId: update.toolCallId,
            title: update.title,
            name: update.name,
            toolKind: update.kind,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            locations: update.locations,
            content: update.content,
            isSubagent: isSpawnAgentTool(update),
          });
        }
        break;
      case "available_commands_update":
        this.emit(
          "commands",
          (update.availableCommands ?? []).filter((cmd) => /^[a-zA-Z0-9]/.test(cmd?.name ?? "")),
        );
        break;
      case "usage_update":
        this.emit("usage", {
          used: update.used,
          size: update.size,
          cost: update.cost ?? null,
          // ACP 的 cost 是会话累计值，不能当增量累加（见 store 的 setUsage）。
          costCumulative: true,
        });
        break;
      case "session_info_update":
        this.emit("session_info", {
          title: update.title ?? null,
          updatedAt: update.updatedAt ?? null,
        });
        break;
      case "config_option_update":
        this.updateConfigs(update.configOptions);
        this.applyOptimisticConfig();
        this.emitConfig();
        break;
      case "current_mode_update":
        if (update.currentModeId) {
          this.modes = { availableModes: [], ...(this.modes ?? {}), currentModeId: update.currentModeId };
          this.emit("mode", this.modes);
        }
        break;
      default:
        break;
    }
  }

  async requestPermission(params) {
    const optionId = await this.onPermissionRequest(params);
    if (optionId == null) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  }

  fail(error, message) {
    if (this.closed) return;
    this.fatalError = error;
    this.emit("fatal", { error, message: message ?? `${errorMessage(error)}.` });
    this.close();
  }

  kill() {
    const proc = this.proc;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill("SIGTERM");
  }
}
