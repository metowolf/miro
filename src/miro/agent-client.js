import { EventEmitter } from "node:events";
import os from "node:os";
import process from "node:process";

import {
  currentEffortName,
  currentModelName,
  effortConfigFrom,
  modelConfigFrom,
  thinkingConfigFrom,
} from "../acp/model.js";
import { startBash } from "../bash.js";
import { loadSessionBlocks } from "../session-store.js";
import { readSystemSettings, writeSystemSettings } from "../settings-file.js";
import { normalizeDisabledTools, saveDisabledTools } from "../settings.js";
import { errorMessage } from "../utils.js";
import { SYSTEM_PROMPT, compactContext, environmentPrompt, runAgentLoop } from "./agent-loop.js";
import { isSummaryMessage } from "./compaction.js";
import {
  GOAL_CONTINUATION_PROMPT,
  GOAL_ROUND_CAP_CONTINUATION_PROMPT,
  createGoalState,
} from "./goal.js";
import {
  applyModelConnection,
  buildConfigOptions,
  contextWindowOf,
  defaultBaseUrlForProtocol,
  normalizeEffortForModel,
  readMiroConfig,
  normalizeMiroProtocol,
} from "./config-options.js";
import {
  MODELS_FILE,
  catalogKey,
  findCatalogModel,
  loadMiroModelCatalog,
  mergeModelCatalogs,
  resolveModelSecrets,
} from "./models-file.js";
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
} from "./permission-mode.js";
import { expandSkillCommand, formatSkillsForPrompt, loadSkills, skillsFromSettings } from "./skills.js";
import { shutdownSandbox } from "./tools/terminal.js";
import {
  PLAN_ENTRY_GUIDANCE,
  createPlanFile,
  normalizePlanModeState,
  planModePrompt,
} from "./plan-mode.js";
import { MiroCredentialStore, storedCredentialProviderIds } from "./credential-store.js";
import { createOAuthModels, oauthCatalogForCredentialIds } from "./oauth-providers.js";

/**
 * Miro 内置 agent 的会话事件源。
 *
 * 与 AcpClient 平级：对外 emit 同名事件、暴露同名方法，UI 与 headless
 * 不需要知道底层是 ACP 还是直连 LLM。差别只在内部——没有子进程、没有
 * JSON-RPC，工具循环由 src/miro/agent-loop.js 自己跑。
 */
export class MiroAgentClient extends EventEmitter {
  constructor({
    cwd = process.cwd(),
    contextText = null,
    continueSessionId = null,
    resumeContext = null,
    settings = null,
    permissionMode = null,
    interactive = true,
    dependencies = {},
  } = {}) {
    super();
    this.bin = "miro";
    this.args = [];
    this.cwd = cwd;
    this.contextText = contextText;
    this.continueSessionId = continueSessionId;
    this.resumeContext = resumeContext;
    // 恢复的会话里 AGENTS.md 已经在原会话注入过，再来一份只会让历史出现
    // 第二份同样的规则；hydrate 不出历史时再由 beginSession 把它放回 false。
    this.contextSent = continueSessionId != null;
    this.dependencies = dependencies;
    this.interactive = interactive;

    this.settings = settings ?? readSystemSettings();
    this.modelsFile = dependencies.modelsFile === undefined ? MODELS_FILE : dependencies.modelsFile;
    this.credentialStore = dependencies.credentialStore ?? new MiroCredentialStore(dependencies.authFile);
    this.oauthModels = dependencies.oauthModels ?? createOAuthModels(this.credentialStore);
    this.config = this.readConfig();
    // 命令行权限模式优先于配置：一次性运行的意图比持久化的偏好更具体。
    if (permissionMode != null) {
      this.config.permissionMode = normalizePermissionMode(permissionMode);
    }
    // skill 目录只在构造时扫一次：/new、切 provider、/resume 都会换 client，
    // 那时自然重扫。不做 watcher —— 目录是拼进 system prompt 的，而压缩会把
    // 首条 system 消息原样保留，中途改动要么看不见，要么得重建整段历史。
    const skillSetting = skillsFromSettings(this.settings);
    const discoverSkills = dependencies.loadSkills ?? loadSkills;
    const discovered = skillSetting.disabled
      ? { skills: [], diagnostics: [] }
      : discoverSkills({ cwd: this.cwd, home: dependencies.home ?? os.homedir(), extraPaths: skillSetting.paths });
    this.skills = discovered?.skills ?? [];
    // 写坏的 SKILL.md 只记在这里：会话中途也很难把「启动时发现的问题」
    // 再塞回 transcript，先留着给 /skills 之类的入口用。
    this.skillDiagnostics = discovered?.diagnostics ?? [];

    this.sessionId = null;
    this.modelConfig = null;
    this.effortConfig = null;
    this.thinkingConfig = null;
    this.configOptions = [];
    this.interactionMode = "default";
    this.planId = null;
    this.planPath = null;
    // 交互模式与权限模式正交：Shift+Tab 只循环 Default / Plan。
    this.modes = this.modesPayload();
    this.startupInfo = null;
    this.optimisticConfig = null;
    this.fatalError = null;
    this.closed = false;
    this.suppressReplay = false;
    this.messages = [];
    this.abortController = null;
    // 「总是允许 / 总是拒绝」按会话记忆。放在 client 而不是 runAgentLoop 里：
    // 每条用户输入都会新调一次循环，集合声明在循环内等于点过的「Allow always」
    // 下一轮就失效。换 client（/new、/resume、切 provider）时自然重新开始。
    this.alwaysAllowedTools = new Set();
    this.alwaysRejectedTools = new Set();
    // 跨回合的目标状态。放在 client 而不是 runAgentLoop 里，理由同上面两个
    // 集合，只是更强：目标的全部意义就是跨越多次 prompt() 调用而存活。
    this.goal = createGoalState({
      onChange: (snapshot) => this.emit("goal", snapshot, this.sessionId),
    });
    // 正在跑的续跑循环。用户手动输入时要能立刻掐断它，否则会出现两条并发的
    // prompt() 往同一个 messages 数组里写，消息顺序直接错乱。
    this.goalRunId = 0;

    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.onPermissionRequest = async () => null;
    this.onPlanEntryRequest = async () => false;
    this.onPlanReviewRequest = async () => ({ action: "dismiss" });
    this.onUserInputRequest = async () => null;

    this.refreshConfigs();
  }

  readConfig({ selectedModel = null } = {}) {
    // 先合并再选模型：settings 顶层的 `provider/id` 偏好必须能对上 OAuth 目录。
    // 订阅模型放前面，旧的裸 id 偏好也会优先对上已登录的提供方。
    const catalog = mergeModelCatalogs(
      oauthCatalogForCredentialIds(
        this.oauthModels,
        storedCredentialProviderIds(this.credentialStore.file),
      ),
      loadMiroModelCatalog(this.modelsFile),
    );
    return readMiroConfig(this.settings, {
      catalog,
      selectedModel: selectedModel ?? this.config?.model,
    });
  }

  /**
   * 重读 ~/.miro/models.json。
   *
   * pi 每次打开 /model 都重新加载文件，编辑后不必重启。会话里改过的
   * permissionMode / effort / thinking 要留下来，不能连 settings 默认值一起盖掉。
   */
  reloadSessionOptions() {
    const previous = this.config;
    const next = this.readConfig({ selectedModel: previous.model });
    next.effort = normalizeEffortForModel(next.models, next.model, previous.effort);
    next.thinking = previous.thinking;
    next.permissionMode = previous.permissionMode;
    next.maxToolRounds = previous.maxToolRounds;
    next.temperature = previous.temperature;
    this.config = next;
    this.refreshConfigs();
    this.emitConfig();
    return this.configOptions;
  }

  /** 按当前 model / effort / thinking 重建 configOptions。 */
  refreshConfigs() {
    this.configOptions = buildConfigOptions({
      models: this.config.models,
      model: this.config.model,
      effort: this.config.effort,
      thinking: this.config.thinking,
      disabledTools: this.config.disabledTools,
      sandboxEnabled: this.config.sandboxEnabled,
      protocol: this.config.protocol,
      includeProtocol: !this.config.models.some((entry) => entry.fromCatalog),
    });
    this.modelConfig = modelConfigFrom(this.configOptions);
    this.effortConfig = effortConfigFrom(this.configOptions);
    this.thinkingConfig = thinkingConfigFrom(this.configOptions);
  }

  /** run() 不发任何网络请求：只是声明会话已就绪，然后挂起到 close()。 */
  async run() {
    try {
      // AcpClient 的 ready 来自子进程握手，天然是异步的；调用方常写成
      // run() 之后再注册监听。这里让出一个微任务，避免同步 emit 丢掉 ready。
      await Promise.resolve();
      const resumed = this.continueSessionId != null;
      this.sessionId = resumed ? this.continueSessionId : Bun.randomUUIDv7();
      if (resumed) {
        this.ensureSystemPrompt();
        // 取不到历史时（例如会话属于别的工作目录）至少把项目上下文补回去，
        // 否则模型既没有对话记录也没有 AGENTS.md。
        if (!this.hydrateMessages()) this.contextSent = false;
      }
      this.agentName = "Miro";
      this.agentInfo = { name: "Miro", version: "miro" };
      this.agentCapabilities = {};
      this.emit("progress", resumed ? "Preparing miro session…" : "Starting miro agent…");
      this.emit("ready", this.sessionPayload(resumed));
      await this.done;
    } catch (error) {
      this.fail(error, `Miro agent failed: ${errorMessage(error)}`);
    }
    return this.fatalError;
  }

  /** 首条消息固定是 system prompt；模式切换时原位更新，不能留下互相冲突的 system。 */
  ensureSystemPrompt() {
    if (!SYSTEM_PROMPT) return;
    const content = this.systemPrompt();
    // 摘要也使用 system role，必须按身份找基础提示，不能覆盖首条 system。
    const index = this.messages.findIndex((message) => message?.role === "system" &&
      !isSummaryMessage(message) && (message.miro_system === true ||
        (typeof message.content === "string" && message.content.startsWith(SYSTEM_PROMPT))));
    if (index >= 0) this.messages.splice(index, 1);
    this.messages.unshift({ role: "system", content, miro_system: true });
  }

  /**
   * 系统提示 = 固定人格 + 环境块 + skill 目录。
   *
   * 三段并进同一条 system 消息，而不是新开几条：anthropic-messages 会把所有
   * system 消息并进同一个 systemPrompt，plan 模式那两条通知已经踩过这个坑；
   * 压缩时 head 里的 system 消息又是整条原样带回的，只有一条才不会互相错位。
   */
  systemPrompt() {
    return [
      SYSTEM_PROMPT,
      this.interactive && this.interactionMode === "default" ? PLAN_ENTRY_GUIDANCE : "",
      this.interactionMode === "plan" ? planModePrompt(this.planPath, this.interactive) : "",
      environmentPrompt({ cwd: this.cwd }),
      formatSkillsForPrompt(this.skills),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  /**
   * 优先恢复模型上下文检查点（摘要、工具调用及对应结果），旧会话仍回退到
   * 可见 transcript。可见 block 与模型消息不是一一对应，不能混着重放。
   */
  hydrateMessages() {
    const load = this.dependencies.loadSessionBlocks ?? loadSessionBlocks;
    let saved = null;
    try {
      // miro 的历史只会写在 miro/ 下；同一个 sessionId 可能另有 ACP 那份，
      // 传入 providerId 才能优先取回本 agent 写入的那一份。
      saved = load(this.sessionId, this.cwd, "miro");
    } catch {
      saved = null;
    }

    let restored = 0;
    const restoredPlan = normalizePlanModeState(saved?.planModeState);
    if (restoredPlan) {
      this.interactionMode = restoredPlan.mode;
      this.planId = restoredPlan.planId;
      this.planPath = restoredPlan.planPath;
      this.modes = this.modesPayload();
      this.ensureSystemPrompt();
    }
    if (saved?.contextState?.messages?.length > 0) {
      this.messages = structuredClone(saved.contextState.messages);
      this.contextSent = saved.contextState.contextSent;
      this.ensureSystemPrompt();
      return true;
    }
    for (const block of saved?.blocks ?? []) {
      if (block?.role !== "user" && block?.role !== "assistant" && block?.role !== "proposedPlan") continue;
      const content = String(block.text ?? "").trim();
      if (content.length === 0) continue;
      this.messages.push({ role: block.role === "proposedPlan" ? "assistant" : block.role, content });
      restored += 1;
    }
    return restored > 0;
  }

  sessionPayload(resumed) {
    return {
      agentName: this.agentName ?? "Miro",
      modelConfig: this.modelConfig,
      effortConfig: this.effortConfig,
      configOptions: this.configOptions,
      modes: this.modes,
      sessionId: this.sessionId,
      resumed,
    };
  }

  /**
   * 跑一轮对话。首轮普通输入前置 AGENTS.md 上下文，语义与 AcpClient.prompt 一致：
   * 注入失败要还原标记，恢复的会话不再注入。
   */
  async prompt(content, { injectContext = true } = {}) {
    this.assertIdle();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const inject = injectContext && !this.contextSent;
    if (inject) this.contextSent = true;
    const prefix = inject
      ? [
          ...(this.resumeContext != null ? [this.resumeContext] : []),
          ...(this.contextText != null ? [this.contextText] : []),
        ]
      : [];
    this.ensureSystemPrompt();
    this.messages.push({ role: "user", content: this.promptText(blocks, prefix) });

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const result = await runAgentLoop({
        messages: this.messages,
        config: this.loopConfig(),
        handlers: this.loopHandlers(),
        signal: controller.signal,
        dependencies: this.loopDependencies(),
        goal: this.goal,
      });
      return {
        stopReason: result.stopReason,
        ...(result.transition ? { transition: result.transition } : {}),
      };
    } catch (error) {
      if (inject) this.contextSent = false;
      // cancel() / close() 中断请求时抛出的 AbortError 属于正常结局。
      if (this.closed || controller.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      this.checkpointContext();
      if (this.abortController === controller) this.abortController = null;
    }
  }

  /** 回合互斥由 client 保底，避免 UI 或脚本同时改写同一段历史。 */
  assertIdle() {
    if (this.closed) throw new Error("Session is closed");
    if (this.abortController) throw new Error("Wait for the current operation to finish before starting another one");
  }

  checkpointContext() {
    this.emit("context_checkpoint", { messages: this.messages, contextSent: this.contextSent });
  }

  /** /compact 是独立操作，不把命令当用户消息，也不自动续跑旧任务。 */
  async compact({ instructions = "" } = {}) {
    this.assertIdle();
    if (["pending", "active", "pausing"].includes(this.goalSnapshot()?.status)) {
      throw new Error("Pause the active goal before compacting context");
    }
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const result = await compactContext({
        messages: this.messages,
        config: this.loopConfig(),
        handlers: this.loopHandlers(),
        signal: controller.signal,
        dependencies: this.loopDependencies(),
        instructions,
      });
      if (controller.signal.aborted) return { ok: false, reason: "cancelled", stopReason: "cancelled" };
      if (!result.ok && result.reason !== "nothing_to_compact") {
        throw new Error(`Context was not changed: ${result.reason}`);
      }
      return { ...result, stopReason: "end_turn" };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, reason: "cancelled", stopReason: "cancelled" };
      throw error;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  /**
   * 目标模式的续跑驱动。
   *
   * 这是整个特性的编排层，刻意放在 client 而不是 agent-loop：只有这一层知道
   * 「一次 prompt 何时真正结束」。agent-loop 的 for 循环管的是单个回合内的
   * 工具轮次，把跨回合的续跑塞进去会把两个关注点焊死。
   *
   * 循环不变式（缺一条就会出现重复回合或消息错序）：
   *   1. 同一时刻只有一个在飞的 prompt()——while 里严格 await，绝不并发投递；
   *   2. 用户手动输入或取消时立刻停——靠 goalRunId 版本号，见 interruptGoalRun；
   *   3. 只有目标仍为 active 才继续——终态由模型的 update_goal 或预算写入。
   *
   * 异常一律映射为 paused 而不是 blocked：限流、断网、鉴权失败都是外部故障，
   * 目标本身没有受阻，用户修好之后 /goal resume 就该能接着跑。
   */
  async promptGoal(objective, { completionCriterion = null, replace = false, maxTurns = null } = {}) {
    const snapshot = this.goal.create({ objective, completionCriterion, replace });
    // 首轮把目标原文作为用户输入发出去，之后的轮次发续跑提示。首轮不用续跑
    // 文案，否则模型会读到「继续推进目标」却看不到目标是什么。
    return this.driveGoal(snapshot.objective, { maxTurns });
  }

  /**
   * 运行中输入 /goal 时先登记为 pending。调用方必须先中断并收尾旧回合，
   * 再调用 activatePendingGoal；这条边界避免旧回合的 token/时间混入新目标。
   */
  createPendingGoal(objective, { completionCriterion = null, replace = true } = {}) {
    this.interruptGoalRun();
    return this.goal.create({ objective, completionCriterion, replace, pending: true });
  }

  /** 接管协调器确认没有在飞回合后，激活 pending goal 并启动续跑。 */
  async activatePendingGoal({ maxTurns = null } = {}) {
    const snapshot = this.goal.activatePending();
    return this.driveGoal(snapshot.objective, { maxTurns });
  }

  queueResumeGoal() {
    this.interruptGoalRun();
    return this.goal.queueResume();
  }

  /** 会话恢复由 UI 在 transcript/recorder 就绪后调用。 */
  restoreGoal(snapshot) {
    return this.goal.restore(snapshot);
  }

  /**
   * 续跑循环本体。promptGoal（新建）与 resumeGoal（恢复）共用。
   *
   * 必须共用：恢复若走一条独立实现，「已用回合数」「预算余量」这些累计量
   * 很容易在两条路径上算得不一样，而它们正是预算判定的输入。
   */
  async driveGoal(firstInput, { maxTurns = null } = {}) {
    // 版本号在进入循环前取：这一次运行独占它，任何后来的输入都会让它失效。
    this.goalRunId += 1;
    const runId = this.goalRunId;
    const isCurrent = () => this.goalRunId === runId && !this.closed;

    let input = firstInput;
    let lastStopReason = null;
    let turns = 0;

    while (isCurrent() && this.goal.isActive()) {
      // 回合边界也要查预算，而不是只依赖 runAgentLoop 内部那道。
      //
      // 两道检查覆盖不同的区间：循环层那道管一个回合**之内**的工具轮次（长回合
      // 里 token 与墙钟会一路涨），这道管回合**之间**。少了这道，预算就与
      // 「是否走过 runAgentLoop」绑死，任何别的续跑路径都不受约束。
      if (this.goal.blockIfOverBudget() != null) break;

      if (maxTurns != null && turns >= maxTurns) {
        // 驱动层的安全阀，不是目标预算：预算触顶要走 blockIfOverBudget，
        // 那条路径才会带上原因并让模型有机会写总结。这里只防无限循环。
        this.goal.pause(`Paused after ${turns} goal turns (driver limit)`);
        break;
      }
      // 回合在开跑前计数，这样预算判定看到的是「含本轮」的用量；放在回合
      // 结束后计会让最后一轮永远不受预算约束。
      this.goal.countTurn();
      turns += 1;

      let result;
      try {
        result = await this.prompt(input);
      } catch (error) {
        // 真实故障：暂停并记下原因，让用户看到为什么停了。
        if (isCurrent() && this.goal.isActive()) {
          this.goal.pause(`Paused after error: ${errorMessage(error)}`);
        }
        throw error;
      }
      lastStopReason = result.stopReason;

      // 目标在这一轮里被替换或取消（用户操作、/new、close）：本次运行的使命
      // 已经结束，绝不能继续投递——那会往一个不存在的目标上跑回合。
      if (!isCurrent()) break;

      if (result.stopReason === "cancelled") {
        // 用户按了 esc。中断不是受阻：目标保留为 paused，随时可以恢复。
        if (this.goal.isActive()) this.goal.pause("Paused after interruption");
        break;
      }

      // update_goal 已经宣布终态，或预算触顶后已置 blocked。状态机是唯一
      // 判据，不去猜 stopReason——模型可能在同一轮里既写了总结又正常收尾。
      if (!this.goal.isActive()) break;

      // max_turns 表示上一轮撞满了工具轮次上限而不是做完了：续跑提示要点明
      // 这件事并要求把切片收小，否则模型会以同样的粒度再撞一次。
      input =
        result.stopReason === "max_turns"
          ? GOAL_ROUND_CAP_CONTINUATION_PROMPT
          : GOAL_CONTINUATION_PROMPT;
    }

    return { stopReason: lastStopReason ?? "end_turn", goal: this.goal.get() };
  }

  /**
   * 让正在跑的续跑循环失效。
   *
   * 用户手动输入、取消、替换目标时必须调它：只把状态改成 paused 是不够的，
   * 循环可能正卡在 await prompt() 上，回来之后会读到一个已经变了的状态却仍然
   * 认为自己该继续。版本号让它自己认出「我已经过期了」。
   */
  interruptGoalRun() {
    this.goalRunId += 1;
  }

  /** 当前目标快照，供状态栏与 /goal status 使用。 */
  goalSnapshot() {
    return this.goal.get();
  }

  /** 暂停当前目标并停掉续跑循环。 */
  pauseGoal(reason = null) {
    this.interruptGoalRun();
    return this.goal.pause(reason);
  }

  requestPauseGoal(reason = null) {
    this.interruptGoalRun();
    return this.goal.requestPause(reason);
  }

  finishPauseGoal() {
    return this.goal.finishPause();
  }

  /**
   * 恢复被暂停/受阻的目标，并重新起一个续跑循环。
   *
   * 不复用 promptGoal：那会新建目标并把已用的回合数、token 归零，等于把
   * 「继续」变成「重开」。
   */
  async resumeGoal({ maxTurns = null } = {}) {
    this.goal.resume();
    return this.driveGoal(GOAL_CONTINUATION_PROMPT, { maxTurns });
  }

  /** 移除目标并停掉续跑循环。取消后无法恢复，这是与 pause 的唯一区别。 */
  cancelGoal() {
    this.interruptGoalRun();
    return this.goal.cancel();
  }

  /**
   * 展开 skill 命令并拼出发送文本。
   *
   * /skill:<name> 在 client 层展开：headless(-p) 不走 UI 的斜杠命令派发，
   * 放在 App.jsx 里会让 `miro -p "/skill:x"` 把原文发给模型。
   */
  promptText(blocks, prefix = []) {
    return [...prefix, ...textOf(blocks).map((part) => expandSkillCommand(part, this.skills) ?? part)]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  /**
   * 一次 agent loop 的 config。
   *
   * prompt() 与 promptIsolated() 必须拿到同一份：同一条命令在两条路径上落到
   * 不同的模型、权限或轮次配置，是最难发现的那类漂移。
   */
  loopConfig(overrides = {}) {
    const selected = findCatalogModel(this.config.models, this.config.model);
    return {
      cwd: this.cwd,
      ...this.requestConnection(),
      oauthProvider: selected?.oauth ? selected.provider : null,
      oauthModels: this.oauthModels,
      model: this.config.apiModel ?? this.config.model,
      // pi-ai 根据 model.thinkingLevelMap 把标准档位映射成上游值；
      // 这里必须保留 canonical level，否则 thinking budget 无法按档位计算。
      effort: this.config.effort,
      thinking: this.config.thinking,
      permissionMode: this.config.permissionMode,
      temperature: this.config.temperature,
      contextWindow: contextWindowOf(this.config.models, this.config.model),
      maxToolRounds: this.config.maxToolRounds,
      streamMaxRetries: this.config.streamMaxRetries,
      retryBaseDelayMs: this.config.retryBaseDelayMs,
      // 缺省开启：不设这个字段时 agent-loop 按 !== false 判定为开。
      autoCompact: this.config.autoCompact,
      disabledTools: this.config.disabledTools,
      sandboxEnabled: this.config.sandboxEnabled,
      interactive: this.interactive,
      interactionMode: this.interactionMode,
      plan: this.interactionMode === "plan" ? { id: this.planId, path: this.planPath } : null,
      ...overrides,
    };
  }

  /**
   * spawn_agent 的 model / effort 覆盖：把子智能体要用的模型解析成一份 child
   * config 补丁（上游连接、上下文窗口、effort 档位）。模型名必须命中父会话的
   * 模型目录——静默退回父模型会让「我指定了便宜模型」变成一次无声降级。
   *
   * 返回 `{ patch }` 或 `{ error }`；解析失败由 spawn_agent 转成给模型的失败结果。
   */
  resolveSubagentRouting({ model = null, effort = null } = {}) {
    const models = this.config.models;
    const requestedModel = typeof model === "string" ? model.trim() : "";
    const requestedEffort = typeof effort === "string" ? effort.trim() : "";
    const entry = requestedModel.length > 0
      ? findCatalogModel(models, requestedModel)
      : findCatalogModel(models, this.config.model);
    if (!entry) return { error: `model "${requestedModel}" is not available` };

    // 以父会话连接为底：非目录模型（settings.miro.models）沿用父配置，
    // 目录模型才会被 applyModelConnection 整体换成自己的上游参数。
    const patch = {
      models,
      model: entry.id,
      apiModel: entry.id,
      protocol: this.config.protocol,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      apiKeyRaw: this.config.apiKeyRaw ?? this.config.apiKey,
      baseUrlExplicit: this.config.baseUrlExplicit,
      apiKeyExplicit: this.config.apiKeyExplicit,
      headers: this.config.headers,
      compat: this.config.compat,
      maxTokens: this.config.maxTokens,
      samplingParams: this.config.samplingParams,
      reasoning: this.config.reasoning,
      thinkingLevelMap: this.config.thinkingLevelMap,
      cost: this.config.cost,
      contextWindow: contextWindowOf(models, entry.key, this.config.contextWindow),
      effort: this.config.effort,
    };

    if (requestedModel.length > 0) {
      applyModelConnection(patch, entry);
      const secrets = resolveModelSecrets(entry.fromCatalog ? entry : {
        apiKey: this.config.apiKeyRaw || this.config.apiKey,
        headers: this.config.headers,
      });
      // applyModelConnection 把 model 设成目录 key（provider/id），
      // 而循环发请求用的是 api id，两者不能混。
      patch.model = patch.apiModel ?? entry.id;
      patch.apiKey = secrets.apiKey || patch.apiKey;
      patch.headers = secrets.headers;
      if (entry.fromCatalog) {
        patch.reasoning = entry.reasoning === true;
        patch.thinkingLevelMap = entry.thinkingLevelMap ?? null;
        patch.cost = entry.cost ?? null;
      }
    }

    if (requestedEffort.length > 0) {
      const normalized = normalizeEffortForModel(models, entry.key, requestedEffort);
      if (normalized !== requestedEffort) {
        return { error: `effort "${requestedEffort}" is not available for model "${entry.key}"` };
      }
      patch.effort = normalized;
    }
    return { patch };
  }

  /**
   * 一次 agent loop 的事件订阅。
   *
   * 普通回合与隔离回合共用同一份：两者在界面上必须表现一致（工具行、流式
   * 正文、重试提示、权限弹窗都照常），差别只在消息历史。
   */
  loopHandlers(overrides = {}) {
    return {
      onChunk: (delta) => this.emit("chunk", delta, this.sessionId),
      onThought: (delta) => this.emit("thought", delta),
      onTool: (payload) => this.emit("tool", payload),
      onAutoReview: (payload) => this.emit("auto_review", payload),
      onUsage: (payload) => this.emit("usage", payload),
      onTokenUsage: (payload) => this.emit("token_usage", payload),
      onRetry: (payload) => this.emit("retry", payload),
      onCompactionState: (active) => this.emit("compaction_state", active),
      onContextCheckpoint: () => this.checkpointContext(),
      onCompacted: (payload) => {
        this.checkpointContext();
        this.emit("compacted", payload);
      },
      onPlan: (entries) => this.emit("plan", entries),
      requestPermission: (params) => this.onPermissionRequest(params),
      requestPlanEntry: async () => {
        const approved = await this.onPlanEntryRequest();
        if (approved) await this.enterPlanMode();
        return approved;
      },
      requestUserInput: (questions) => this.onUserInputRequest(questions),
      requestPlanReview: async (review) => {
        const result = await this.onPlanReviewRequest(review);
        if (result?.action === "approve" || result?.action === "reject") this.leavePlanMode();
        return result;
      },
      getPermissionMode: () => this.permissionMode,
      getSessionId: () => this.sessionId,
      alwaysAllowed: this.alwaysAllowedTools,
      alwaysRejected: this.alwaysRejectedTools,
      ...overrides,
    };
  }

  loopDependencies() {
    return {
      backend: this.dependencies.backend,
      startBash: this.dependencies.startBash ?? startBash,
      streamCompletion: this.dependencies.streamCompletion,
      fetchImpl: this.dependencies.fetchImpl,
      toolSchemas: this.dependencies.toolSchemas,
      // 子智能体的 model / effort 覆盖要按父会话的模型目录解析，只有 client 这层
      // 同时握着 config.models 与上游连接；循环层拿到的是一个纯函数。
      resolveSubagentRouting: (options) => this.resolveSubagentRouting(options),
    };
  }

  /**
   * 在独立上下文里跑一轮一次性任务（/review、/simplify、/commit、/init 这类
   * 斜杠命令）。
   *
   * 与 prompt() 共用同一个 loop、同一套权限通道，只有消息历史不同：这里从
   * 「system + 本次任务」开始，跑完把结论并回主历史。命令的产物是结论，而
   * 过程——rubric、预读的 git 上下文、几十次文件读取——对主会话没有信息量，
   * 留着只会挤占上下文，还会把压缩提前触发。
   *
   * 命令记录在回合开始时就进主历史，与 prompt() 推 user 消息、sendPrompt 写
   * transcript 的时机一致：transcript 里那条 user 块从回合开始就在，取消、
   * 空响应、请求失败都不撤回。主历史若什么都不留，/resume 还原出的上下文就
   * 比实时多出一条没有回音的命令——正是「与 hydrateMessages 对齐」要防的漂移。
   *
   * 结论必须回灌：不留的话用户下一句「把第 2 条修掉」，主会话对此一无所知。
   * 被中断的半截正文同样回灌——agent-loop 的中断路径把它写进普通回合的
   * messages，transcript 上也留着（commitPending 不看取消与否），丢掉它
   * 同样造成两侧分叉。
   *
   * 事件照常 emit，界面表现与普通回合完全一致，所以 UI 不需要为这条路径加分支。
   * 只有 miro 提供这个方法：ACP 的对话历史在 provider 进程里，miro 既不能
   * 隔离也不能事后修剪。
   */
  async promptIsolated(content, { displayText = null, injectContext = false } = {}) {
    this.assertIdle();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    // AGENTS.md 上下文按需进隔离历史而不是主历史：项目约定是 review / commit
    // 的判断依据，但它属于这次任务的输入，任务结束后没有再留在对话里的理由。
    const prefix = injectContext && this.contextText != null ? [this.contextText] : [];
    const messages = [
      { role: "system", content: this.systemPrompt() },
      { role: "user", content: this.promptText(blocks, prefix) },
    ];

    const record = String(displayText ?? "").trim();
    if (record.length > 0) this.messages.push({ role: "user", content: record });

    const controller = new AbortController();
    this.abortController = controller;
    // 工具轮次之间的正文在普通回合里是各自独立的 assistant 消息；隔离回合只
    // 并回一条，所以按段攒、段间用空行拼——等价于补回消息边界，否则「先叙述
    // 再调工具」的回合会把叙述与结论焊成一段，追问时模型读到的是粘连文本。
    const segments = [];
    let segment = "";
    const answer = () =>
      [...segments, segment]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n\n");

    try {
      const result = await runAgentLoop({
        messages,
        config: this.loopConfig(),
        handlers: this.loopHandlers({
          // 隔离历史不能写成主会话检查点；只在结论并回后保存主历史。
          onContextCheckpoint: () => {},
          onCompacted: (payload) => this.emit("compacted", payload),
          onChunk: (delta) => {
            if (typeof delta === "string") segment += delta;
            this.emit("chunk", delta, this.sessionId);
          },
          onTool: (payload) => {
            // 工具事件之后（若还有）的正文属于下一段叙述。
            if (segment.trim().length > 0) segments.push(segment.trim());
            segment = "";
            this.emit("tool", payload);
          },
        }),
        signal: controller.signal,
        dependencies: this.loopDependencies(),
      });
      this.rememberIsolatedAnswer(answer());
      return { stopReason: result.stopReason };
    } catch (error) {
      // cancel() / close() 中断请求时抛出的 AbortError 属于正常结局：与
      // runAgentLoop 自己的中断路径一样，已经流给 UI 的半截正文留在主历史里。
      if (this.closed || controller.signal.aborted) {
        this.rememberIsolatedAnswer(answer());
        return { stopReason: "cancelled" };
      }
      // 真实错误与 prompt() 的失败路径一致：命令记录已在回合开始时进来，
      // 半截正文两侧都不保留。
      throw error;
    } finally {
      this.checkpointContext();
      if (this.abortController === controller) this.abortController = null;
    }
  }

  /**
   * 把隔离回合的可见产出并回主历史（命令记录已在回合开始时进来）。
   *
   * 没有可见产出就不补 assistant 消息：空的会被 anthropic-messages 转成空
   * 文本块拒掉整条请求。空响应的回合因此只留下命令记录，与 transcript 上
   * 「user 块 + 一条提示」的可见内容一致。
   */
  rememberIsolatedAnswer(text) {
    const answer = String(text ?? "").trim();
    if (answer.length === 0) return;
    this.messages.push({ role: "assistant", content: answer });
  }

  cancel() {
    // 中断同时作废续跑循环：否则循环从 await prompt() 回来后发现目标仍是
    // active（本轮还没来得及改状态），于是又投递一轮，用户按了 esc 却看到
    // 目标继续在跑。
    this.interruptGoalRun();
    this.abortController?.abort();
  }

  /** 当前模型对应的上游连接；密钥在发请求时解析，好让 `!command` 每次取新值。 */
  requestConnection() {
    const entry = findCatalogModel(this.config.models, this.config.model);
    const secrets = resolveModelSecrets(entry?.fromCatalog ? entry : {
      apiKey: this.config.apiKeyRaw || this.config.apiKey,
      headers: this.config.headers,
    });
    return {
      baseUrl: this.config.baseUrl,
      apiKey: secrets.apiKey || this.config.apiKey,
      protocol: this.config.protocol,
      headers: secrets.headers,
      compat: this.config.compat,
      maxTokens: this.config.maxTokens,
      samplingParams: this.config.samplingParams,
      cost: entry?.cost ?? null,
      reasoning: entry?.reasoning === true,
      thinkingLevelMap: entry?.thinkingLevelMap ?? null,
    };
  }

  /** 供 TUI `/login` 调用；交互实现属于 App，认证生命周期属于 client。 */
  async login(providerId, interaction) {
    const credential = await this.oauthModels.login(providerId, "oauth", interaction);
    this.reloadSessionOptions();
    return credential;
  }

  async oauthProviderModels(providerId) {
    return (await this.oauthModels.getAvailable(providerId)).map((model) => ({
      value: catalogKey(model.provider, model.id),
      name: model.name ?? model.id,
      provider: model.provider,
    }));
  }

  /** 本地生效：改状态后直接广播 config，没有远端回推需要等。 */
  async setConfigOption(configId, value) {
    if (configId === "protocol") {
      const next = normalizeMiroProtocol(value);
      if (next !== value) throw new Error(`protocol "${value}" is not available`);
      const previous = this.config.protocol;
      this.config.protocol = next;
      if (!this.config.baseUrlExplicit && previous !== next) {
        this.config.baseUrl = defaultBaseUrlForProtocol(next);
      }
      if (!this.config.apiKeyExplicit && previous !== next) {
        this.config.apiKey = next === "anthropic-messages"
          ? process.env.ANTHROPIC_API_KEY ?? ""
          : process.env.OPENAI_API_KEY ?? "";
      }
    } else if (configId === "model") {
      // 目录与已登录 OAuth provider 都是模型来源；不能只重读 models.json，
      // 否则用户刚登录后切模型会把订阅模型从当前会话静默抹掉。
      this.config.models = this.readConfig({ selectedModel: this.config.model }).models;
      const entry = findCatalogModel(this.config.models, value);
      if (!entry) throw new Error(`model "${value}" is not available`);
      applyModelConnection(this.config, entry);
    } else if (configId === "reasoning_effort") {
      const normalized = normalizeEffortForModel(this.config.models, this.config.model, value);
      if (normalized !== value) throw new Error(`effort "${value}" is not available for the current model`);
      this.config.effort = normalized;
    } else if (configId === "enable_thinking") {
      this.config.thinking = value === "on" || value === true || value === "true";
    } else if (configId === "sandbox") {
      if (value !== "on" && value !== "off") throw new Error(`sandbox "${value}" is not available`);
      const miro = this.settings?.miro && typeof this.settings.miro === "object" && !Array.isArray(this.settings.miro)
        ? this.settings.miro
        : {};
      const sandbox = miro.sandbox && typeof miro.sandbox === "object" && !Array.isArray(miro.sandbox)
        ? miro.sandbox
        : {};
      const nextSettings = {
        ...this.settings,
        miro: { ...miro, sandbox: { ...sandbox, enabled: value === "on" } },
      };
      await (this.dependencies.writeSystemSettings ?? writeSystemSettings)(nextSettings);
      this.settings = nextSettings;
      this.config.sandboxEnabled = value === "on";
    } else if (configId.startsWith("tool:")) {
      const name = configId.slice("tool:".length);
      const known = this.configOptions
        .find((option) => option.id === "tools")?.tools
        ?.some((option) => option.id === configId);
      if (!known || (value !== "enabled" && value !== "disabled")) {
        throw new Error(`tool setting "${name}" is not available`);
      }
      const disabled = new Set(normalizeDisabledTools(this.config.disabledTools));
      if (value === "disabled") disabled.add(name);
      else disabled.delete(name);
      const next = [...disabled];
      await (this.dependencies.saveDisabledTools ?? saveDisabledTools)(next);
      this.config.disabledTools = next;
      this.settings = { ...this.settings, disableTools: next };
    } else {
      throw new Error(`config option "${configId}" is not supported by Miro's built-in agent`);
    }

    this.optimisticConfig = { configId, value, expiresAt: Date.now() + 3000 };
    this.refreshConfigs();
    this.emitConfig();
    return { configOptions: this.configOptions };
  }

  /** miro 侧的 thinking 是本地开关，无需通过 configOptions 协商。 */
  async enableThinking() {
    if (this.config.thinking) return;
    await this.setConfigOption("enable_thinking", "on");
  }

  async setModel(value) {
    await this.setConfigOption("model", value);
    await this.enableThinking().catch(() => {});
    return currentModelName(this.modelConfig);
  }

  async setEffort(value) {
    await this.enableThinking().catch(() => {});
    await this.setConfigOption("reasoning_effort", value);
    return currentEffortName(this.effortConfig) ?? value;
  }

  /** 当前权限模式；状态栏与 /permissions 都读这里。 */
  get permissionMode() {
    return normalizePermissionMode(this.config.permissionMode);
  }

  /** ACP 形状的交互模式载荷；权限模式是独立维度。 */
  modesPayload() {
    return {
      currentModeId: this.interactionMode,
      availableModes: [
        { id: "default", name: "Default", description: "Inspect and implement changes" },
        { id: "plan", name: "Plan", description: "Investigate and prepare a plan without implementing" },
      ],
    };
  }

  planModeSnapshot() {
    return { mode: this.interactionMode, planId: this.planId, planPath: this.planPath };
  }

  async enterPlanMode() {
    if (this.interactionMode === "plan") return this.planModeSnapshot();
    if (["pending", "active", "pausing"].includes(this.goalSnapshot()?.status)) {
      throw new Error("Pause or cancel the active goal before entering Plan Mode");
    }
    if (!this.sessionId) throw new Error("Session is not ready");
    const planId = Bun.randomUUIDv7();
    const create = this.dependencies.createPlanFile ?? createPlanFile;
    const planPath = await create({ cwd: this.cwd, sessionId: this.sessionId, planId });
    this.interactionMode = "plan";
    this.planId = planId;
    this.planPath = planPath;
    this.ensureSystemPrompt();
    this.modes = this.modesPayload();
    const snapshot = this.planModeSnapshot();
    this.emit("mode", this.modes);
    this.emit("plan_mode", snapshot);
    return snapshot;
  }

  leavePlanMode() {
    if (this.interactionMode !== "plan") return this.planModeSnapshot();
    this.interactionMode = "default";
    this.planId = null;
    this.planPath = null;
    this.ensureSystemPrompt();
    this.modes = this.modesPayload();
    const snapshot = this.planModeSnapshot();
    this.emit("mode", this.modes);
    this.emit("plan_mode", snapshot);
    return snapshot;
  }

  /** 运行时切换权限模式，只对当前会话生效（不写 settings）。 */
  async setPermissionMode(value) {
    const next = normalizePermissionMode(value);
    if (next === this.config.permissionMode) return next;

    this.config.permissionMode = next;
    this.modes = this.modesPayload();
    this.emit("mode", this.modes);
    this.emitConfig();
    return next;
  }

  /** Shift+Tab 与 /plan 走这里；权限模式由 /permissions 单独管理。 */
  async setMode(modeId) {
    if (modeId === "plan") return this.enterPlanMode();
    if (modeId === "default") return this.leavePlanMode();
    throw new Error(`interaction mode "${modeId}" is not available`);
  }

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
    this.interruptGoalRun();
    this.abortController?.abort();
    this.resolveDone();
    // 沙箱的网络桥是进程级资源，会话收尾必须显式交出：它是个活的子进程句柄，
    // 留着就让事件循环永远不空，退出路径只卸载 TUI 时终端会一直回不到 shell。
    // 不 await：调用方是同步的退出流程，桥的拆除靠它自己把循环排空带走。
    void shutdownSandbox();
  }

  fail(error, message) {
    if (this.closed) return;
    this.fatalError = error;
    this.emit("fatal", { error, message: message ?? `${errorMessage(error)}.` });
    this.close();
  }
}

/** prompt 载荷可能是 ACP content 块数组；只取文本部分。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return [String(blocks ?? "")];
  const parts = [];
  for (const block of blocks) {
    if (block == null) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts;
}
