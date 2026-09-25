import { Box, Text, useApp, useInput, useStdout } from "ink";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";

import { AcpClient } from "../acp/acp-client.js";
import { MiroAgentClient } from "../miro/agent-client.js";
import { catalogKey } from "../miro/models-file.js";
import { OAUTH_PROVIDERS } from "../miro/oauth-providers.js";
import { formatElapsed } from "../miro/goal.js";
import { approvedPlanPrompt } from "../miro/plan-mode.js";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_CHOICES,
  matchPermissionMode,
  normalizePermissionMode,
  permissionModeMessage,
} from "../miro/permission-mode.js";
import { isMiroProvider } from "../config.js";
import {
  currentEffortName,
  currentModelName,
  effortChoices,
  modelChoices,
  configChoices,
} from "../acp/model.js";
import {
  detectProviders,
} from "../providers.js";
import { loadStartupContext } from "../agents-md.js";
import {
  matchConfigChoice,
  matchConfigOption,
} from "../acp/config-options.js";
import { matchProviderCommand, parseCommandInput } from "../commands.js";
import { formatBashContext, getBashCommand, isBashInput, startBash } from "../bash.js";
import {
  CLEAR_TERMINAL,
  HELP,
  THOUGHT_UI_FLUSH_MS,
  APP_VERSION,
} from "../config.js";
import { buildDefaultFilename, ensureTxtExtension, osc52Copy, renderTranscript } from "../export.js";
import { openUrl } from "../open-browser.js";
import { buildInitPrompt } from "../prompts.js";
import {
  readEffortPreference,
  readHomeSettings,
  readModelPreference,
  saveEffort,
  saveModel,
  saveLanguage,
  saveThinkingDisplay,
} from "../settings.js";
import {
  DEFAULT_STATUS_LINE_ITEMS,
  readLanguageSetting,
  readStatusLineSettings,
  readThinkingSettings,
  writeStatusLineSettings,
} from "../settings-file.js";
import {
  THINKING_DISPLAY_CHOICES,
  matchThinkingDisplayMode,
  normalizeThinkingDisplayMode,
} from "../thinking.js";
import { isLanguageOption, withLanguageOption } from "../language-config.js";
import { languageDisplayName } from "../prompts/language.js";
import { parseStatusLineItems } from "../status-line/items.js";
import { loadGitBranch, projectNameFor } from "../status-line/workspace-info.js";
import {
  SessionRecorder,
  listSessions,
  loadSessionBlocks,
} from "../session-store.js";
import { getNextModeId } from "../mode-cycle.js";
import { findReviewTarget } from "../review-target.js";
import {
  buildReviewRequest,
  currentBranch,
  hasUncommittedChanges,
  isGitRepo,
  localBranches,
  recentCommits,
  reviewPrompt,
  userFacingHint,
} from "../review.js";
import {
  buildSimplifyRequest,
  looksLikePaths,
  simplifyPrompt,
  userFacingHint as simplifyHint,
} from "../simplify.js";
import {
  buildCommitPushPrRequest,
  buildCommitRequest,
  commitPrompt,
  commitPushPrPrompt,
  hasCommits,
  hasStagedChanges,
  parseCommitArgs,
  userFacingHint as commitHint,
} from "../commit.js";
import { useStore, setRecorder } from "../store.js";
import { createLoginInteraction } from "../login-interaction.js";
import { errorMessage } from "../utils.js";
import { BashCard } from "./BashCard.jsx";
import { ActivitySlot } from "./ActivitySlot.jsx";
import { StatusVerb } from "./StatusVerb.jsx";
import { Composer } from "./Composer.jsx";
import { InputPrompt } from "./InputPrompt.jsx";
import { Message } from "./Message.jsx";
import { PermissionDialog } from "./PermissionDialog.jsx";
import { PlanReviewDialog } from "./PlanReviewDialog.jsx";
import { UserQuestionDialog } from "./UserQuestionDialog.jsx";
import { Picker } from "./picker/Picker.jsx";
import { PickerFlow } from "./picker/PickerFlow.jsx";
import { ConfigPanel } from "./ConfigPanel.jsx";
import { StatusBar } from "./StatusBar.jsx";
import { StatusLineSetup } from "./StatusLineSetup.jsx";
import { ReviewBrowser } from "./ReviewBrowser.jsx";
import { QueueEditor } from "./QueueEditor.jsx";
import { Transcript } from "./Transcript.jsx";

/** 命令识别用 trim 副本；普通 prompt 保留原始空白。 */
export function prepareSubmittedInput(raw, display) {
  const content = String(raw ?? "");
  const commandText = content.trim();
  if (!commandText) return null;
  return {
    content,
    commandText,
    display: display == null ? null : String(display),
    // paste block 只属于输入框与输入历史；提交后的 transcript 使用展开原文。
    transcriptText: content,
  };
}

/**
 * 裸 `exit` / `quit` 与 `/exit` 等价：命令注册表只登记斜杠写法，这两个词由
 * 提交路径单独识别。返回命令描述，不是退出指令时返回 null。
 */
export function bareExitCommand(text) {
  const lower = String(text ?? "").trim().toLowerCase();
  return lower === "exit" || lower === "quit" ? { key: "exit", args: "" } : null;
}

/** 解析启动模型；显式参数无效时不静默回退到默认模型。 */
export function resolveStartupModel(config, startupModel, savedModel) {
  const choices = modelChoices(config);
  if (!config || choices.length === 0) {
    return { value: null, unavailable: startupModel != null };
  }

  const requested = startupModel ?? savedModel;
  const matched = matchConfigChoice(config, requested);
  if (startupModel != null && !matched) return { value: null, unavailable: true };
  return { value: matched?.value ?? choices[0].value, unavailable: false };
}

/** effort 无偏好时保留 provider 默认值，不能像模型一样回退到第一项。 */
export function resolveStartupEffort(config, startupEffort, savedEffort) {
  const matched = startupEffort != null
    ? matchConfigChoice(config, startupEffort)
    : effortChoices(config).find((choice) => choice.value === savedEffort);
  return { value: matched?.value ?? null, unavailable: startupEffort != null && !matched };
}

/** 构造审批选项。 */
export function buildPermissionDialogItems(options) {
  const kindRank = { allow_once: 0, allow_session: 1, allow_family: 2, reject_once: 3, reject_always: 4 };
  const sorted = [...(options ?? [])].sort(
    (a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
  );
  const items = sorted.map((option) => ({
    value: option.optionId,
    label: option.name,
    allow: option.kind?.startsWith("allow") ?? false,
  }));
  return items;
}

/** 将选择器值交还给 agent-loop。 */
export function permissionOptionIdForChoice(options, value) {
  return value;
}

/**
 * 这些 overlay 在回合仍是 busy 时打开，且阻塞回合等待用户按键。
 *
 * 权限审批是典型场景：`prompt()` 停在工具调用上等审批，`busy` 仍为真，于是
 * ActivitySlot 的 Thinking… 与 StatusVerb 的动词继续每 100ms 换一帧 spinner、
 * 每秒推进一次计时，把对话框顶得来回抖动。审批期间界面不推进是事实，不需要
 * 动画来暗示还在跑，因此整块活动区在这些 overlay 打开时让位。
 *
 * 注意与「只是占住输入区」的 overlay（model / config / statusline 等）区分：
 * 那些都要求空闲才能打开，本来就不会有活动区在跑。
 */
const AWAITING_INPUT_OVERLAYS = new Set([
  "permission",
  "plan-review",
  "user-question",
  "review-input",
  "export-input",
  "simplify-input",
  "commit-input",
]);

/** 阻塞 agent-loop 等用户决策的面板必须冻结动画与秒表。 */
export function isAwaitingInputOverlay(kind) {
  return AWAITING_INPUT_OVERLAYS.has(kind);
}

/**
 * 整屏接管的面板：它们替换掉 <Static> 之下的全部内容（含活动区与状态行），
 * 因此秒表继续走只会让这面面板每秒重画一次——长 diff 的 Review 窗口最能看出抖动。
 *
 * 与「只是占住输入区」的 picker（model / provider / session 等）刻意区分：
 * 那些面板打开时活动区仍在渲染，计时必须继续走，停表反而是功能退化。
 */
export const SCREEN_TAKEOVER_OVERLAYS = new Set(["review-browser", "queue-review"]);

/** 这些面板占用输入区，但 Composer 本身保持挂载以保留未提交草稿。 */
export function composerIsHidden(connecting, overlayKind) {
  return (
    Boolean(connecting) ||
    ["model", "effort", "config", "statusline", "permissions", "thinking"].includes(overlayKind)
  );
}

/** 底部面板替代常驻状态行；连接、退出等高优先级提示仍由 StatusBar 决定。 */
export function statusLineIsHidden({ helpOpen = false, completionOpen = false, overlay = null } = {}) {
  return helpOpen || completionOpen || overlay != null;
}

/**
 * Ctrl+C 的归属：overlay 先吃掉它，其次是输入框里的草稿，最后才轮到中断与退出确认。
 * 顺序是载重的：误按一次丢掉正在写的 prompt，远比打断一个跑了几分钟的回合便宜，
 * 所以「有草稿」必须挡在 interrupt() 之前。
 */
export function ctrlCIntent({ hasOverlay, hasDraft }) {
  if (hasOverlay) return "overlay";
  return hasDraft ? "draft" : "turn";
}

/**
 * 取消当前 overlay。picker 与各面板都靠 resolve(escapeValue) 收尾，而 InputPrompt
 * 那一类（oauth / export / review / simplify / commit 的文本输入）只有
 * onSubmit / onCancel，直接调 resolve 会抛 TypeError，Esc 与 Ctrl+C 必须走同一个
 * 出口——两边表现出不同行为比不能取消更糟。
 */
export function cancelOverlay(overlay) {
  if (!overlay) return;
  if (typeof overlay.resolve === "function") {
    overlay.resolve(overlay.escapeValue);
    return;
  }
  overlay.onCancel?.();
}

/**
 * 秒表开关：只有「动态区真的在显示耗时」时才每秒推进 now。
 *
 * 三类情况停表：本来就没在跑；等待用户按键的阻塞式 overlay（活动区整体隐藏）；
 * 整屏接管的面板（动态区被整块替换，继续走表只会让长 diff 每秒重排一遍）。
 * 抽成纯函数是为了能单独验证这条规则，而不是藏在组件里的一个布尔表达式。
 *
 * 目标在跑时即使没有工具在动也要走表：底栏右侧的 `◎ /goal active (4s)` 靠它
 * 刷新耗时，而目标的大部分时间花在「没工具在跑」的模型思考与回合间隙上。
 */
export function isClockRunning({
  activeTools = [],
  busy = false,
  awaitingInput = false,
  overlayKind = null,
  goalActive = false,
} = {}) {
  if (!busy && activeTools.length === 0 && !goalActive) return false;
  if (awaitingInput) return false;
  return !SCREEN_TAKEOVER_OVERLAYS.has(overlayKind);
}

/**
 * 秒表每走一秒额外做的一件事：把还在跑的目标的耗时刷新到底栏。
 *
 * 目标快照里的墙钟是「读的时候才结算」的（goal.js 的 snapshot 按需结算），而状态机
 * 只在生命周期变化与用量上报时 emit。长思考、长工具调用期间没有 emit，底栏右侧的
 * `◎ /goal active (4s)` 就会僵在上一个读数上，看上去像目标卡住了。所以跟着秒表主动
 * 取一次新快照，渲染层因此只需要把数据印出来，不必自己算时间。
 *
 * 只有 active 才取：paused / blocked / complete 的耗时不会再变，每秒问一遍只是白白
 * 重渲。ACP client 没有 goalSnapshot，可选调用顺带把这条差异吃掉。
 */
export function refreshActiveGoal(client) {
  const store = useStore.getState();
  if (store.goal?.status !== "active") return null;
  const snapshot = client?.goalSnapshot?.();
  if (snapshot == null) return null;
  store.setGoal(snapshot);
  return snapshot;
}

/** 隐藏输入区时保留同一个 Composer 实例，避免草稿状态被 React 重建。 */
export function ComposerSurface({ hidden, disabled, ...props }) {
  return (
    <Box display={hidden ? "none" : "flex"} flexDirection="column">
      <Composer disabled={hidden || disabled} {...props} />
    </Box>
  );
}

/** 会话列表用的相对时间。 */
function emptyComposerSnapshot() {
  return { value: "", cursor: 0, pastes: new Map(), nextPasteId: 1 };
}

/**
 * 全空的 UI 状态是否值得落盘。
 *
 * 空草稿 + 空队列没有任何可恢复的东西，而 recordUiState 会经 ensureMeta 建出
 * 会话文件：启动或 /new 后一字未输就退出，会留下零消息的 (untitled) 会话，并
 * 因最新 mtime 抢走 /sessions 首位与无 id 的 --continue。
 * 已经写过状态的会话是例外——必须记录「清空」，否则旧草稿会在恢复时复活。
 */
export function shouldRecordUiState({ composer, queuedInputs, alreadyRecorded }) {
  if (alreadyRecorded) return true;
  if (queuedInputs?.length > 0) return true;
  return Boolean(composer?.value) || (composer?.pastes?.size ?? 0) > 0;
}

function formatSessionAge(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function App({ continueSessionId = null, startupAcp = null, startupModel = null, startupEffort = null, startupPermissionMode = null, startupInteractionMode = null }) {
  const { exit } = useApp();
  const { write } = useStdout();

  const clientRef = useRef(null);
  const providerRef = useRef(null);
  const recorderRef = useRef(null);
  const uiCheckpointTimerRef = useRef(null);
  const pendingSessionKeyRef = useRef(0);
  // /goal 在忙碌时不与当前 prompt 并发：只登记接管意图，等旧回合收尾后由
  // drainQueue 作为唯一入口启动。这样旧 finally 不会踩掉新回合的 busy/transcript。
  const goalTakeoverRef = useRef(null);
  const goalAfterStopNoticeRef = useRef(null);
  const composerSnapshotRef = useRef(null);
  const composerControlsRef = useRef(null);
  // 本会话是否已落过 ui_state：决定「全空」到底是无事可存，还是要记录清空。
  const uiStateRecordedRef = useRef(false);
  const [composerSession, setComposerSession] = useState({ key: null, snapshot: null });

  const checkpointUiState = () => {
    if (uiCheckpointTimerRef.current != null) {
      clearTimeout(uiCheckpointTimerRef.current);
      uiCheckpointTimerRef.current = null;
    }
    if (!recorderRef.current || !composerSnapshotRef.current) return;
    const composer = composerSnapshotRef.current;
    const queuedInputs = useStore.getState().queuedInputs;
    if (
      !shouldRecordUiState({
        composer,
        queuedInputs,
        alreadyRecorded: uiStateRecordedRef.current,
      })
    ) {
      return;
    }
    uiStateRecordedRef.current = true;
    recorderRef.current.recordUiState({ composer, queuedInputs });
  };

  const scheduleUiCheckpoint = () => {
    if (!recorderRef.current || !composerSnapshotRef.current) return;
    if (uiCheckpointTimerRef.current != null) clearTimeout(uiCheckpointTimerRef.current);
    uiCheckpointTimerRef.current = setTimeout(checkpointUiState, 200);
  };

  const handleComposerSnapshotChange = (snapshot) => {
    composerSnapshotRef.current = snapshot;
    scheduleUiCheckpoint();
  };

  const stageSessionUiState = (key, uiState = null) => {
    const snapshot = uiState?.composer ?? emptyComposerSnapshot();
    composerSnapshotRef.current = snapshot;
    // 恢复出来的状态本身就来自文件，等价于「已写过」；全新会话则从未写过。
    uiStateRecordedRef.current = uiState != null;
    useStore.getState().replaceQueuedInputs(uiState?.queuedInputs ?? []);
    setComposerSession({ key, snapshot });
  };

  const exitRef = useRef(exit);
  exitRef.current = exit;
  // Ink 卸载时不会主动把 useCursor 钉住的光标移回 live region 底部。先提交一帧
  // 取消定位，再退出，才能让 runTui 的恢复命令接在输入区之后而非覆盖输入框。
  const [exiting, setExiting] = useState(false);

  /**
   * 先让输入组件交还真实终端光标，再由 Ink 卸载。
   *
   * useCursor 在提交期才把 undefined 交给 Ink；若同一调用栈立刻 exit()，最后一帧
   * 仍会停在输入行，随后 runTui 的普通 stdout 就会从那里开始写。
   */
  const requestExit = () => setExiting(true);

  useEffect(() => {
    if (exiting) exitRef.current();
  }, [exiting]);

  const bashTaskRef = useRef(null);
  const thoughtQueueRef = useRef("");
  const thoughtTimerRef = useRef(null);
  const exitConfirmUntilRef = useRef(0);
  const exitConfirmTimerRef = useRef(null);
  const [exitConfirming, setExitConfirming] = useState(false);

  const modeSwitchingRef = useRef(false);
  const [modeSwitching, setModeSwitching] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [agentBin, setAgentBin] = useState("provider");

  const status = useStore((state) => state.status);
  const connectionStage = useStore((state) => state.connectionStage);
  const busy = useStore((state) => state.busy);
  const cancelling = useStore((state) => state.cancelling);
  const compacting = useStore((state) => state.compacting);
  const retryNotice = useStore((state) => state.retryNotice);
  const switching = useStore((state) => state.switching);
  const overlay = useStore((state) => state.overlay);
  const pending = useStore((state) => state.pending);
  const activeTools = useStore((state) => state.activeTools);
  const pendingToolGroup = useStore((state) => state.pendingToolGroup);
  const modelConfig = useStore((state) => state.modelConfig);
  const effortConfig = useStore((state) => state.effortConfig);
  const configOptions = useStore((state) => state.configOptions);
  const turnStartedAt = useStore((state) => state.turnStartedAt);
  const toolRound = useStore((state) => state.toolRound);
  const providerCommands = useStore((state) => state.providerCommands);
  const queuedInputs = useStore((state) => state.queuedInputs);
  const bashCard = useStore((state) => state.bashCard);
  const modes = useStore((state) => state.modes);
  const providerName = useStore((state) => state.providerName);
  const sessionId = useStore((state) => state.sessionId);
  const sessionTitle = useStore((state) => state.sessionTitle);
  const usage = useStore((state) => state.usage);
  // 状态栏的累计 token 项读 sessionTokens；最近一次读数（state.tokens）只服务于
  // 活动槽的思考行提示，由 ActivitySlot 自己订阅。
  const sessionTokens = useStore((state) => state.sessionTokens);
  // 成本项与退出摘要同源，读累计值；`usage.cost` 只记最近一次读数。
  const sessionCost = useStore((state) => state.sessionCost);
  const planProgress = useStore((state) => state.planProgress);
  const goal = useStore((state) => state.goal);
  const gitBranch = useStore((state) => state.gitBranch);
  // 只订阅「有没有在思考」这个派生布尔，而不是整个 thought 对象：后者每个
  // thought 批次（50ms 节流）都换新引用，等于让整棵 App 每秒重渲二十次，
  // 而 App 层真正的用途只有状态栏那一项。Object.is 比较下布尔不变就不重渲。
  const thinking = useStore((state) => state.thought != null);

  useEffect(() => {
    scheduleUiCheckpoint();
  }, [queuedInputs]);

  useEffect(() => {
    if (overlay != null) setHelpOpen(false);
  }, [overlay]);

  /**
   * 回合仍在跑，但真正在等的是用户按键（权限审批、以及同样占住输入的输入类
   * overlay）。这类状态下活动区不该继续跑 spinner 与计时：审批期间界面本就
   * 不会推进，每 100ms 一帧的重渲只会让对话框上下抖动、看起来在闪。
   *
   * 与 cancelling 是同一类判断（等外部输入、不该有动画），因此下面把它和
   * cancelling 一起交给 ActivitySlot / StatusVerb 短路。
   */
  const awaitingInput = isAwaitingInputOverlay(overlay?.kind);

  useEffect(() => {
    useStore.getState().setThoughtPaused(awaitingInput);
  }, [awaitingInput]);

  // 状态栏配置在启动时读取，确认面板后可在当前会话更新；非法项仅告警一次。
  const [statusLineConfig, setStatusLineConfig] = useState(() => {
    const { items, useColors } = readStatusLineSettings();
    return { items: items ?? DEFAULT_STATUS_LINE_ITEMS, useColors };
  });

  // thinking 呈现偏好与模型 effort 分离；raw ACP 记录只在启动时读取一次。
  const [initialThinkingSettings] = useState(() => readThinkingSettings());
  const [thinkingDisplay, setThinkingDisplay] = useState(initialThinkingSettings.display);

  useEffect(() => {
    useStore.getState().setThinkingDisplay(thinkingDisplay);
  }, [thinkingDisplay]);

  // 权限模式只对 Miro 内置 agent 有意义；客户端就绪后同步实际档位。
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  // 命令行权限模式是启动意图，但 /permissions 的运行时切换要能覆盖它，
  // 且切 provider / resume 时会重建 client——用 ref 记住当前档位再传给新 client，
  // 否则重连会把用户刚选的模式悄悄退回启动值。
  const permissionModeRef = useRef(startupPermissionMode);

  /** 同步当前客户端与 UI 的权限模式；命令和审批弹窗共用这一条路径。 */
  const applyPermissionModeToClient = async (client, value) => {
    const store = useStore.getState();
    const mode = normalizePermissionMode(value);
    await client?.setPermissionMode?.(mode);
    permissionModeRef.current = mode;
    setPermissionMode(mode);
    store.push("system", permissionModeMessage(mode));
    return mode;
  };

  // 内置工作流提示词语言：启动时读取，改动后立即用于本会话的相关命令。
  const [language, setLanguage] = useState(() => readLanguageSetting());
  const languageRef = useRef(language);
  languageRef.current = language;

  // /config 面板展示的选项 = ACP 报的选项 + 本地 language 项。
  const panelConfigOptions = useMemo(
    () => withLanguageOption(configOptions, language),
    [configOptions, language]
  );
  const statusLineParsed = parseStatusLineItems(statusLineConfig.items);
  const statusLineWarnedRef = useRef(false);

  useEffect(() => {
    if (status !== "ready" || statusLineWarnedRef.current) return;
    if (statusLineParsed.invalid.length === 0) return;
    statusLineWarnedRef.current = true;
    const label = statusLineParsed.invalid.length === 1 ? "item" : "items";
    useStore
      .getState()
      .push("system", `Ignored invalid status line ${label}: ${statusLineParsed.invalid.join(", ")}.`);
  }, [status]);

  // git-branch 只在被配置时才查询，结果按 cwd 缓存。
  const usesGitBranch = statusLineParsed.items.includes("git-branch");
  useEffect(() => {
    if (!usesGitBranch) return;
    let cancelled = false;
    void loadGitBranch(process.cwd()).then((branch) => {
      if (!cancelled) useStore.getState().setGitBranch(branch);
    });
    return () => {
      cancelled = true;
    };
  }, [usesGitBranch, sessionId]);

  /**
   * thinking 更新可能远密于终端刷新频率。保留原始 ACP 事件，动态 UI 只按固定
   * 间隔合并刷新，避免每个 chunk 都触发 App/Composer/Yoga 协调。
   */
  const flushQueuedThought = () => {
    if (thoughtTimerRef.current != null) {
      clearTimeout(thoughtTimerRef.current);
      thoughtTimerRef.current = null;
    }
    const text = thoughtQueueRef.current;
    thoughtQueueRef.current = "";
    if (!text) return;

    const store = useStore.getState();
    if (!store.busy || store.cancelling) return;
    store.noteThought(text);
  };

  const discardQueuedThought = () => {
    if (thoughtTimerRef.current != null) {
      clearTimeout(thoughtTimerRef.current);
      thoughtTimerRef.current = null;
    }
    thoughtQueueRef.current = "";
  };

  const queueThought = (text) => {
    const store = useStore.getState();
    if (!store.busy || store.cancelling) return;
    const chunk = String(text ?? "");
    if (!chunk) return;
    thoughtQueueRef.current += chunk;
    if (thoughtTimerRef.current == null) {
      thoughtTimerRef.current = setTimeout(() => {
        thoughtTimerRef.current = null;
        flushQueuedThought();
      }, THOUGHT_UI_FLUSH_MS);
    }
  };

  const [now, setNow] = useState(Date.now());
  const clockRunning = isClockRunning({
    activeTools,
    busy,
    awaitingInput,
    overlayKind: overlay?.kind,
    goalActive: goal?.status === "active",
  });
  useEffect(() => {
    if (!clockRunning) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      // 目标耗时存在快照里、读的时候才结算：只等状态机 emit，底栏的数字会在长思考
      // 与长工具调用期间僵住。跟着同一个秒表取一份新快照，渲染层只负责印数据。
      refreshActiveGoal(clientRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [clockRunning]);

  const attachClient = (client) => {
    const store = useStore.getState();

    const beginSession = ({
      modelConfig: config,
      sessionId,
      resumed,
    }) => {
      if (!sessionId || recorderRef.current?.sessionId === sessionId) return;
      let savedMeta = null;
      let savedUiState = null;
      let savedGoalState = null;
      if (resumed) {
        // 带 providerId：同一个 sessionId 可能同时存在 miro 与 ACP 两份 transcript，
        // 固定顺序会读到另一个 agent 的历史（并因此压掉本该回放的 session/load）。
        const saved = loadSessionBlocks(sessionId, process.cwd(), useStore.getState().providerId);
        if (saved) {
          if (saved.blocks.length > 0) {
            useStore.getState().hydrate(saved.blocks);
            client.suppressReplay = true;
          }
          useStore.getState().setSessionMeta(saved.meta);
          savedMeta = saved.meta;
          savedUiState = saved.uiState;
          savedGoalState = saved.goalState;
        }
        useStore.getState().push("system", `Resumed session: ${sessionId}`);
      }
      stageSessionUiState(`session:${pendingSessionKeyRef.current}:${sessionId}`, savedUiState);
      const recorder = new SessionRecorder({
        sessionId,
        providerId: useStore.getState().providerId,
        model: currentModelName(config),
      });
      if (savedMeta?.title != null) recorder.meta.title = savedMeta.title;
      recorderRef.current = recorder;
      setRecorder(recorder);
      if (savedGoalState != null && typeof client.restoreGoal === "function") {
        client.restoreGoal(savedGoalState);
      }
    };

    client.on("progress", (stage) => useStore.getState().setConnectionStage(stage));

    client.on("ready", ({ agentName, modelConfig: config, effortConfig: effort, configOptions: configs, modes, sessionId, resumed }) => {
      useStore.getState().connected({
        providerName: agentName,
        sessionId,
        modelConfig: config,
        effortConfig: effort,
        configOptions: configs,
        modes,
      });
      beginSession({ modelConfig: config, sessionId, resumed });
      // 还原出来的队列没有「回合结束」可挂靠，必须在这里主动接上排空链路，
      // 否则它会一直滞留，且被用户随后输入的新消息抢到前面（破坏 FIFO）。
      const resumeQueue = () => {
        if (useStore.getState().queuedInputs.length > 0) drainQueue();
      };
      // effort 依赖切模型和开启 thinking 后的选项；恢复会话只应用显式参数，
      // 不能因为传了 --effort 就把保存的 model 偏好覆盖到恢复的模型上。
      const applyStartupPreferences = async () => {
        if (startupInteractionMode != null && modes?.availableModes?.some((mode) => mode.id === startupInteractionMode)) {
          await client.setMode(startupInteractionMode);
        }
        if (startupModel != null || !resumed) await applyStartupModel(config);
        if (startupEffort != null || !resumed) await applyStartupEffort();
      };
      void applyStartupPreferences().finally(resumeQueue);
    });

    client.on("chunk", (text, messageId) => {
      flushQueuedThought();
      useStore.getState().appendChunk(text, messageId);
    });
    client.on("user_chunk", (text, messageId) => {
      flushQueuedThought();
      useStore.getState().appendUserChunk(text, messageId);
    });

    client.on("info", (text) => {
      flushQueuedThought();
      useStore.getState().push("system", text.trim());
    });

    client.on("tool", (payload) => {
      flushQueuedThought();
      useStore.getState().upsertTool(payload);
    });
    client.on("auto_review", (payload) => {
      useStore.getState().upsertTool({ toolCallId: payload.toolCallId, autoReview: payload });
    });

    client.on("thought", queueThought);
    client.on("plan", (entries) => {
      flushQueuedThought();
      useStore.getState().setPlan(entries);
    });
    client.on("commands", (commands) => useStore.getState().setProviderCommands(commands));
    // 目标快照：只有 miro client 会发，ACP 下这个订阅永不触发。
    client.on("goal", (snapshot) => {
      useStore.getState().setGoal(snapshot);
      recorderRef.current?.recordGoalState?.(snapshot);
    });
    client.on("plan_mode", (snapshot) => {
      recorderRef.current?.recordPlanModeState?.(snapshot);
    });

    client.on("usage", (payload) => useStore.getState().setUsage(payload));
    client.on("session_info", ({ title }) => useStore.getState().setSessionTitle(title));
    client.on("token_usage", (payload) => useStore.getState().setTokens(payload));
    client.on("compaction_state", (active) => {
      if (client === clientRef.current) useStore.getState().setCompacting(active);
    });
    client.on("context_checkpoint", (state) => {
      if (client === clientRef.current) useStore.getState().recordContextState(state);
    });

    // LLM 重试进度只落在状态行，不写进 transcript：重连是过程噪音，
    // 成功后不该在历史里留下痕迹。
    client.on("retry", (payload) => useStore.getState().setRetryNotice(payload));
    // 压缩对用户必须可见：状态栏水位骤降不是提示。ACP 不发这个事件，订阅是空操作。
    client.on("compacted", (payload) => {
      flushQueuedThought();
      const text = typeof payload?.notice === "string" && payload.notice.length > 0
        ? payload.notice
        : null;
      if (text) useStore.getState().push("system", text);
    });

    client.on("config", (configs) => useStore.getState().setConfigs(configs));
    client.on("mode", (modes) => {
      if (client !== clientRef.current) return;
      useStore.getState().setModes(modes);
      // Shift+Tab 与计划批准也会改模式，必须同步状态栏及重连时的档位。
      if (typeof client.setPermissionMode === "function") {
        const mode = normalizePermissionMode(client.permissionMode);
        permissionModeRef.current = mode;
        setPermissionMode(mode);
      }
    });
    client.on("stderr", (text) => useStore.getState().push("stderr", `${client.bin}\n${text}`));

    client.on("fatal", ({ error, message }) => {
      useStore.getState().setFatalError(error);
      useStore.getState().push("error", message);
    });

    client.onPermissionRequest = (params) =>
      new Promise((resolve) => {
        const options = params.options ?? [];
        const reject = options.find((option) => option.kind === "reject_once");
        const toolCall = {
          title: params.toolCall?.title ?? null,
          kind: params.toolCall?.kind ?? null,
          rawInput: params.toolCall?.rawInput ?? null,
          content: params.toolCall?.content ?? null,
          locations: params.toolCall?.locations ?? null,
          command:
            params.toolCall?.rawInput?.command ??
            params.toolCall?.rawInput?.sub_content ??
            null,
        };
        store.setOverlay({
          kind: "permission",
          toolCall,
          escapeValue: reject?.optionId ?? null,
          items: buildPermissionDialogItems(options),
          resolve: async (value) => {
            const optionId = permissionOptionIdForChoice(options, value);
            const chosen = options.find((option) => option.optionId === optionId);
            let verdict = "Cancelled";
            if (chosen) verdict = chosen.kind?.startsWith("allow") ? "Allowed" : "Denied";
            store.push(
              "system",
              `${verdict}: ${toolCall.command ?? toolCall.title ?? "tool call"}`
            );
            store.setOverlay(null);
            resolve(optionId);
          },
        });
      });
    client.onPlanEntryRequest = () =>
      new Promise((resolve) => {
        store.setOverlay({
          kind: "permission",
          toolCall: { kind: "mode", title: "Enter Plan Mode", rawInput: null },
          escapeValue: "decline",
          items: [
            { value: "approve", label: "Enter Plan Mode" },
            { value: "decline", label: "Continue normally" },
          ],
          resolve: (value) => {
            store.setOverlay(null);
            resolve(value === "approve");
          },
        });
      });
    client.onPlanReviewRequest = ({ plan, path }) =>
      new Promise((resolve) => {
        store.setOverlay({
          kind: "plan-review",
          plan,
          path,
          resolve: (value) => {
            store.setOverlay(null);
            resolve(value ?? { action: "dismiss" });
          },
        });
      });
    client.onUserInputRequest = (questions) =>
      new Promise((resolve) => {
        store.setOverlay({
          kind: "user-question",
          questions,
          resolve: (value) => {
            store.setOverlay(null);
            resolve(value);
          },
        });
      });
  };

  const startClient = (provider, sessionId = null) => {
    goalTakeoverRef.current = null;
    goalAfterStopNoticeRef.current = null;
    recorderRef.current = null;
    setRecorder(null);
    stageSessionUiState(`pending:${++pendingSessionKeyRef.current}`);
    const settings = readHomeSettings();
    const { contextText, files } = loadStartupContext({
      cwd: process.cwd(),
      settings,
      resumed: sessionId != null,
    });
    const common = {
      contextText,
      continueSessionId: sessionId,
    };
    // Miro 内置 agent 不 spawn 二进制，也不需要 bin/args。
    const client = isMiroProvider(provider)
      ? new MiroAgentClient({ ...common, settings, permissionMode: permissionModeRef.current })
      : new AcpClient({
        bin: provider.bin,
        args: provider.args,
        sessionMeta: provider.sessionMeta,
        recordRawThinking: initialThinkingSettings.recordRaw,
        ...common,
      });
    client.agentsFiles = files;
    clientRef.current = client;
    providerRef.current = provider;
    setPermissionMode(isMiroProvider(provider) ? normalizePermissionMode(client.permissionMode) : null);
    setAgentBin(isMiroProvider(provider) ? provider.id : provider.bin);
    useStore.getState().setProviderId(provider.id);
    attachClient(client);

    void client
      .run()
      .then((error) => {
        if (error) useStore.getState().setFatalError(error);
      })
      .finally(() => {
        if (client !== clientRef.current) return;
        requestExit();
      });
  };

  useEffect(() => {
    const provider = startupAcp == null
      ? { id: "miro", name: "Miro", kind: "miro" }
      : detectProviders().find((item) => !isMiroProvider(item) && item.id === startupAcp);
    if (!provider) {
      const available = detectProviders().filter((item) => !isMiroProvider(item)).map((item) => item.id).join(", ") || "none";
      useStore.getState().setFatalError(new Error(
        `ACP provider "${startupAcp}" is not available; available ACP providers: ${available}`
      ));
      requestExit();
    } else {
      startClient(provider, continueSessionId);
    }
    return () => {
      if (exitConfirmTimerRef.current) clearTimeout(exitConfirmTimerRef.current);
      checkpointUiState();
      discardQueuedThought();
      clientRef.current?.close();
    };
  }, []);

  const shutdown = () => {
    checkpointUiState();
    clientRef.current?.close();
  };

  /** 清屏，不改变 ACP 会话。 */
  const clearScreen = () => {
    write(CLEAR_TERMINAL);
    useStore.getState().clearTranscript();
  };

  const interrupt = () => {
    const store = useStore.getState();
    if (bashTaskRef.current) {
      bashTaskRef.current.interrupt();
      return true;
    }
    if (!store.busy || store.cancelling) return false;
    discardQueuedThought();
    store.setCancelling(true);
    clientRef.current?.cancel();
    return true;
  };

  /**
   * 丢弃草稿意味着用户又回到「编辑」而不是「退出」，所以要撤销待定的退出确认：
   * 否则「有草稿时连按两次 Ctrl+C」会先清空再直接退出，正是这次改动要防的误退。
   */
  const cancelExitConfirm = () => {
    if (exitConfirmTimerRef.current) clearTimeout(exitConfirmTimerRef.current);
    exitConfirmTimerRef.current = null;
    exitConfirmUntilRef.current = 0;
    setExitConfirming(false);
  };

  /**
   * 唯一的退出路径：Ctrl+C 连按、`/exit`、裸 `exit` / `quit` 都走这里。
   *
   * 不能只靠 shutdown() 关客户端等 `run()` 自己收尾：连接已经结束的会话（比如启动失败
   * 后停在 provider 选择框）再 close() 不会有任何回调，TUI 会一直挂着退不出去。像 Ctrl+C
   * 一样先交出光标再退出，退出摘要也才能在任何一条路径上打印。
   */
  const exitSession = () => {
    cancelExitConfirm();
    shutdown();
    requestExit();
  };

  /** 首次 Ctrl+C 仅提示，2 秒内再次按下才关闭 TUI。 */
  const confirmExit = () => {
    const now = Date.now();
    if (now < exitConfirmUntilRef.current) {
      exitSession();
      return;
    }

    exitConfirmUntilRef.current = now + 2000;
    setExitConfirming(true);
    if (exitConfirmTimerRef.current) clearTimeout(exitConfirmTimerRef.current);
    exitConfirmTimerRef.current = setTimeout(() => {
      exitConfirmUntilRef.current = 0;
      exitConfirmTimerRef.current = null;
      setExitConfirming(false);
    }, 2000);
  };

  /**
   * 启动参数优先于已保存的 model 偏好，并支持按 value / name 匹配。
   * 偏好按 provider 分别记忆（miro 在 settings 顶层，ACP 在
   * providers.<id> 下），切换 provider 时读回各自的记录；匹配不到时静默跳过。
   */
  const applyStartupModel = async (config) => {
    const store = useStore.getState();
    const saved =
      startupModel == null
        ? readModelPreference(readHomeSettings(), useStore.getState().providerId)
        : null;
    const { value: desired, unavailable } = resolveStartupModel(config, startupModel, saved);
    if (unavailable) {
      store.push("error", `Model "${startupModel}" is not available.`);
      return;
    }
    if (desired == null) return;
    if (desired === config.currentValue) return;

    store.setSwitching("Applying model preference…");
    try {
      await clientRef.current.setModel(desired);
    } catch (error) {
      store.push("error", `Failed to apply model preference: ${errorMessage(error)}`);
    } finally {
      store.setSwitching(null);
    }
  };

  /** 先打开 thinking 以刷新可选档位；启动参数只改 client，不走会保存偏好的 applyEffort。 */
  const applyStartupEffort = async () => {
    const store = useStore.getState();
    try {
      await clientRef.current.enableThinking();
    } catch (error) {
      store.push("error", `Failed to enable thinking: ${errorMessage(error)}`);
    }

    const config = useStore.getState().effortConfig;
    const saved =
      startupEffort == null
        ? readEffortPreference(readHomeSettings(), useStore.getState().providerId)
        : null;
    const { value: desired, unavailable } = resolveStartupEffort(config, startupEffort, saved);
    if (unavailable) {
      store.push("error", `Effort "${startupEffort}" is not available.`);
      return;
    }
    if (desired == null || desired === config?.currentValue) return;

    store.setSwitching("Applying effort preference…");
    try {
      await clientRef.current.setEffort(desired);
    } catch (error) {
      store.push("error", `Failed to apply effort preference: ${errorMessage(error)}`);
    } finally {
      store.setSwitching(null);
    }
  };

  /**
   * 切换模型。chainEffort 为真时（/model 直接指定模型名的路径）沿用旧行为，
   * 成功后再弹 effort；走 /model 多步流程时由流程自己收集 effort，
   * 因此传 false，避免弹出第二个面板。
   *
   * 返回值表示模型是否真的切换成功，调用方据此决定是否继续后续动作
   * （例如应用 effort）——切换失败时不应把 effort 写到旧模型上。
   */
  const applyModel = async (value, { chainEffort = false } = {}) => {
    const store = useStore.getState();
    const config = store.modelConfig;
    if (value == null || value === config?.currentValue) return false;

    const next = modelChoices(config).find((choice) => choice.value === value);
    store.setSwitching(`Switching to ${next?.name ?? value}…`);
    let switched = false;
    try {
      const name = await clientRef.current.setModel(value);
      switched = true;
      recorderRef.current?.recordModel(name);
      try {
        await saveModel(value, useStore.getState().providerId);
      } catch (error) {
        store.push("system", `Failed to save model preference: ${errorMessage(error)}`);
      }
    } catch (error) {
      store.push("error", `Failed to switch model: ${errorMessage(error)}`);
    } finally {
      store.setSwitching(null);
    }

    if (
      chainEffort &&
      switched &&
      effortChoices(useStore.getState().effortConfig).length > 0 &&
      useStore.getState().overlay?.kind !== "config"
    ) {
      openEffortPicker();
    }

    return switched;
  };

  /** miro 的 /model 每次打开都重读 ~/.miro/models.json。 */
  const refreshMiroCatalog = () => {
    const client = clientRef.current;
    if (typeof client?.reloadSessionOptions === "function") client.reloadSessionOptions();
  };

  /** 模型操作前置保护。 */
  const guardModelChoices = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return null;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before switching models.");
      return null;
    }

    const choices = modelChoices(store.modelConfig);
    if (!store.modelConfig || choices.length === 0) {
      store.push("system", "The current ACP session does not offer switchable models.");
      return null;
    }
    return choices;
  };

  /**
   * /model 只负责选模型；effort 在模型切换成功后再询问。
   *
   * effort 的可选项是 provider 针对「当前模型」报的，setModel() 会用 ACP 响应
   * 刷新 configOptions。若在这里用旧模型的快照预先算出第二步，就会出现
   * 「旧模型无 effort、新模型有」被跳过，或把旧模型的取值提交给新模型的问题，
   * 因此这里退回单步 picker，成功后复用 chainEffort 的既有链路。
   */
  const openModelPicker = () => {
    refreshMiroCatalog();
    const store = useStore.getState();
    const choices = guardModelChoices();
    if (!choices) return;

    const sorted = [...choices.filter((c) => c.current), ...choices.filter((c) => !c.current)];

    store.setOverlay({
      kind: "model",
      title: "Select model",
      emptyText: "No matching models",
      escapeValue: null,
      items: sorted.map((choice) => ({
        value: choice.value,
        label: choice.name,
        groupName: choice.groupName || "",
        current: Boolean(choice.current),
      })),
      resolve: (value) => {
        useStore.getState().setOverlay(null);
        if (value == null) return;
        void applyModel(value, { chainEffort: true });
      },
    });
  };

  /** 将 pi-ai 的认证交互映射到现有的 picker / 输入框。 */
  const startLogin = (providerId) => {
    const store = useStore.getState();
    const client = clientRef.current;
    if (!isMiroProvider(providerRef.current) || typeof client?.login !== "function") {
      store.push("system", "/login is available only with Miro's built-in agent.");
      return;
    }
    if (store.busy || store.overlay || store.switching) {
      store.push("system", "Please wait for the current activity to finish before logging in.");
      return;
    }
    // 用户取消与 pi-ai 收尾的区分见 login-interaction.js：它只负责把请求翻成
    // overlay，并单独报出「用户改主意」；真实登录失败仍按原始错误上报。
    const signIn = createLoginInteraction({
      setOverlay: (overlay) => useStore.getState().setOverlay(overlay),
      currentOverlay: () => useStore.getState().overlay,
    });
    const interaction = {
      signal: signIn.signal,
      prompt: signIn.prompt,
      notify: (event) => {
        if (event.type === "auth_url") {
          // 打不开浏览器（无桌面环境、缺 xdg-open）只是提示问题：URL 照样打出来，
          // 用户手动打开或粘贴授权码都能走完登录，不能因为起不了进程就中断。
          const opened = openUrl(event.url);
          const hint = event.instructions ?? "Open this URL to sign in:";
          store.push("system", `${opened ? "" : "Could not open a browser automatically.\n"}${hint}\n${event.url}`);
        } else if (event.type === "device_code") {
          store.push("system", `Open ${event.verificationUri} and enter code: ${event.userCode}`);
        } else if (event.type === "info" || event.type === "progress") store.push("system", event.message);
      },
    };
    store.setSwitching("Signing in…");
    void client.login(providerId, interaction).then(async () => {
      store.setSwitching(null);
      store.push("system", `Signed in to ${OAUTH_PROVIDERS.find((item) => item.id === providerId)?.name ?? providerId}.`);
      if (providerId === "openai-codex") {
        await applyModel(catalogKey("openai-codex", "gpt-5.6-sol"), { chainEffort: false });
        return;
      }
      const choices = await client.oauthProviderModels(providerId);
      useStore.getState().setOverlay({ kind: "oauth", title: "Select model", items: choices.map((item) => ({ value: item.value, label: item.name })), escapeValue: null, resolve: (value) => { useStore.getState().setOverlay(null); if (value) void applyModel(value, { chainEffort: true }); } });
    }).catch((error) => {
      store.setSwitching(null);
      if (signIn.cancelled()) store.push("system", "Login cancelled.");
      else store.push("error", `Login failed: ${errorMessage(error)}`);
    });
  };

  const openLoginPicker = () => {
    const store = useStore.getState();
    if (store.busy || store.overlay || store.switching) return;
    store.setOverlay({ kind: "oauth", title: "Sign in", items: OAUTH_PROVIDERS.map((item) => ({ value: item.id, label: item.name, right: item.description })), escapeValue: null, resolve: (value) => { useStore.getState().setOverlay(null); if (value) startLogin(value); } });
  };

  /** /model 按 value（provider/id）、裸 id、name 匹配。 */
  const setModelByName = (args) => {
    refreshMiroCatalog();
    const store = useStore.getState();
    const choices = guardModelChoices();
    if (!choices) return;

    const hit = matchConfigChoice(store.modelConfig, args);

    if (!hit) {
      const names = choices
        .map((choice) => (choice.groupName ? `${choice.groupName} / ${choice.name}` : choice.name))
        .join(", ");
      store.push("error", `Model "${args}" not found. Available models: ${names}`);
      return;
    }

    void applyModel(hit.value, { chainEffort: true });
  };

  const applyEffort = async (value) => {
    const store = useStore.getState();
    const config = store.effortConfig;
    if (value == null || value === config?.currentValue) return;

    const next = effortChoices(config).find((choice) => choice.value === value);
    store.setSwitching(`Setting effort level ${next?.name ?? value}…`);
    try {
      await clientRef.current.setEffort(value);
      try {
        await saveEffort(value, useStore.getState().providerId);
      } catch (error) {
        store.push("system", `Failed to save effort preference: ${errorMessage(error)}`);
      }
    } catch (error) {
      store.push("error", `Failed to set effort level: ${errorMessage(error)}`);
    } finally {
      store.setSwitching(null);
    }
  };

  /** effort 操作前置保护。 */
  const guardEffortChoices = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return null;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before setting effort level.");
      return null;
    }

    const choices = effortChoices(store.effortConfig);
    if (!store.effortConfig || choices.length === 0) {
      store.push("system", "The current model does not support effort selection.");
      return null;
    }
    return choices;
  };

  const openEffortPicker = () => {
    const store = useStore.getState();
    const choices = guardEffortChoices();
    if (!choices) return;

    store.setOverlay({
      kind: "effort",
      title: "Select effort level",
      emptyText: "No matching effort levels",
      escapeValue: null,
      items: choices.map((choice) => ({
        value: choice.value,
        label: choice.name ?? choice.value,
        current: Boolean(choice.current),
      })),
      resolve: (value) => {
        store.setOverlay(null);
        void applyEffort(value);
      },
    });
  };

  /** 打开权限模式选择器；ACP 不支持，直接说明。 */
  const openPermissionPicker = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return;
    if (!isMiroProvider({ id: store.providerId })) {
      store.push(
        "system",
        "Permission mode is only available in Miro; ACP providers control their own approvals."
      );
      return;
    }
    const current = normalizePermissionMode(clientRef.current?.permissionMode);

    store.setOverlay({
      kind: "permissions",
      title: "Select permission mode",
      emptyText: "No matching permission modes",
      escapeValue: null,
      // right 是行内说明列；footerHint 是底部提示条（单个字符串），不是每行字段。
      footerHint: "Enter to apply · Esc to cancel",
      items: PERMISSION_MODE_CHOICES.map((choice) => ({
        value: choice.value,
        label: choice.name,
        right: choice.description,
        current: choice.value === current,
      })),
      resolve: (value) => {
        store.setOverlay(null);
        if (value) void applyPermissionMode(value);
      },
    });
  };

  /** 应用权限模式：更新 client，并把结果回显到 transcript。 */
  const applyPermissionMode = (value) => applyPermissionModeToClient(clientRef.current, value);

  /** /permissions 按 value / name 匹配。 */
  const setPermissionModeByName = (args) => {
    const store = useStore.getState();
    if (!isMiroProvider({ id: store.providerId })) {
      store.push(
        "system",
        "Permission mode is only available in Miro; ACP providers control their own approvals."
      );
      return;
    }
    const hit = matchPermissionMode(args);
    if (!hit) {
      const names = PERMISSION_MODE_CHOICES.map((choice) => choice.value).join(", ");
      store.push("error", `Invalid permission mode "${args}". Available modes: ${names}`);
      return;
    }
    void applyPermissionMode(hit.value);
  };

  /** thinking display 是本地呈现偏好，不改变 provider 的 thinking effort。 */
  const applyThinkingDisplay = async (value) => {
    const mode = normalizeThinkingDisplayMode(value);
    const store = useStore.getState();
    setThinkingDisplay(mode);
    store.setThinkingDisplay(mode);
    try {
      await saveThinkingDisplay(mode);
      if (!useStore.getState().busy) store.push("system", `Thinking display: ${mode}.`);
    } catch (error) {
      if (!useStore.getState().busy) {
        store.push(
          "system",
          `Thinking display set to ${mode} for this session, but failed to save: ${errorMessage(error)}`
        );
      }
    }
  };

  const openThinkingPicker = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return;
    if (store.busy) {
      store.push("system", "Use /thinking compact|full|hidden while a response is running.");
      return;
    }
    store.setOverlay({
      kind: "thinking",
      title: "Thinking display",
      emptyText: "No matching display modes",
      escapeValue: null,
      footerHint: "Enter to apply · Esc to cancel",
      items: THINKING_DISPLAY_CHOICES.map((choice) => ({
        value: choice.value,
        label: choice.name,
        right: choice.description,
        current: choice.value === thinkingDisplay,
      })),
      resolve: (value) => {
        store.setOverlay(null);
        if (value) void applyThinkingDisplay(value);
      },
    });
  };

  const setThinkingDisplayByName = (args) => {
    const hit = matchThinkingDisplayMode(args);
    if (!hit) {
      const names = THINKING_DISPLAY_CHOICES.map((choice) => choice.value).join(", ");
      useStore.getState().push(
        "error",
        `Invalid thinking display "${args}". Available modes: ${names}`
      );
      return;
    }
    void applyThinkingDisplay(hit.value);
  };

  /** /effort 按 value / name 匹配。 */
  const setEffortByName = (args) => {
    const store = useStore.getState();
    const choices = guardEffortChoices();
    if (!choices) return;

    const lower = args.toLowerCase();
    const hit =
      choices.find((choice) => String(choice.value).toLowerCase() === lower) ??
      choices.find((choice) => String(choice.name ?? "").toLowerCase() === lower);

    if (!hit) {
      const names = choices.map((choice) => choice.name ?? choice.value).join(", ");
      store.push("error", `Invalid effort level "${args}". Available levels: ${names}`);
      return;
    }

    void applyEffort(hit.value);
  };

  const applyMode = async (modeId) => {
    const store = useStore.getState();
    const modes = store.modes;
    if (modeSwitchingRef.current || modeId == null || modeId === modes?.currentModeId) return;

    modeSwitchingRef.current = true;
    setModeSwitching(true);
    try {
      await clientRef.current.setMode(modeId);
    } catch (error) {
      store.push("error", `Failed to switch mode: ${errorMessage(error)}`);
    } finally {
      modeSwitchingRef.current = false;
      setModeSwitching(false);
    }
  };

  const handlePlanCommand = (args) => {
    const store = useStore.getState();
    const modes = store.modes;
    const available = modes?.availableModes?.map((mode) => mode.id) ?? [];
    if (!available.includes("plan")) {
      store.push("system", "Plan Mode is not available for this provider.");
      return;
    }
    const value = String(args ?? "").trim().toLowerCase();
    if (value === "status") {
      store.push("system", `${modes.currentModeId === "plan" ? "Plan" : "Default"} Mode is active.`);
      return;
    }
    if (value && !["on", "off"].includes(value)) {
      store.push("error", "Usage: /plan [on|off|status]");
      return;
    }
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before switching Plan Mode.");
      return;
    }
    const target = () => {
      if (value === "on") return "plan";
      if (value === "off") return "default";
      return modes.currentModeId === "plan" ? "default" : "plan";
    };
    void applyMode(target());
  };

  const applyConfigOptionValue = async (option, value) => {
    if (option == null || value == null || value === option.currentValue) return;
    const store = useStore.getState();
    // language 是 miro 本地偏好，不走 ACP set_config。
    if (isLanguageOption(option)) {
      await applyLanguage(value);
      return;
    }
    if (store.modelConfig && option.id === store.modelConfig.id) {
      await applyModel(value);
      return;
    }
    if (store.effortConfig && option.id === store.effortConfig.id) {
      await applyEffort(value);
      return;
    }
    if (option.id === "mode" || option.category === "mode") {
      await applyMode(value);
      return;
    }

    store.setSwitching(`Setting ${option.name ?? option.id}…`);
    try {
      await clientRef.current.setConfigOption(option.id, value);
    } catch (error) {
      store.push("error", `Failed to set ${option.name ?? option.id}: ${errorMessage(error)}`);
    } finally {
      store.setSwitching(null);
    }
  };

  /** language 只写 ~/.miro/settings.json，写失败仍保留本会话的选择。 */
  const applyLanguage = async (value) => {
    const store = useStore.getState();
    if (value == null || value === languageRef.current) return;
    setLanguage(value);
    languageRef.current = value;
    const label = languageDisplayName(value);
    try {
      await saveLanguage(value);
      store.push("system", `Prompt language set to ${label}.`);
    } catch (error) {
      store.push(
        "system",
        `Prompt language set to ${label} for this session, but failed to save: ${errorMessage(error)}`
      );
    }
  };

  const openConfigPanel = (focusId = null) => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before changing config.");
      return;
    }
    store.setOverlay({
      kind: "config",
      focusId,
      escapeValue: null,
      resolve: () => useStore.getState().setOverlay(null),
    });
  };

  const openStatusLineSetup = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before changing the status line.");
      return;
    }
    store.setOverlay({
      kind: "statusline",
      escapeValue: null,
      configuredIds: statusLineConfig.items,
      useColors: statusLineConfig.useColors,
      snapshot: {
        modelName: modelConfig ? currentModelName(modelConfig) : null,
        effortName: currentEffortName(effortConfig),
        modeName: modes?.availableModes?.find((mode) => mode.id === modes?.currentModeId)?.name ?? modes?.currentModeId ?? null,
        cwd: process.cwd(), projectName: projectNameFor(process.cwd()), hostname: hostname(), gitBranch,
        providerName, sessionId, sessionTitle, version: APP_VERSION, usage, sessionTokens, sessionCost, plan: planProgress,
        busy, cancelling, thinking, goal,
      },
      resolve: (value) => {
        useStore.getState().setOverlay(null);
        if (!value) return;
        const next = {
          items: (value.items ?? [])
            .filter((item) => item.enabled && item.id !== "use-colors")
            .map((item) => item.id),
          useColors: Boolean(value.useColors),
        };
        setStatusLineConfig(next);
        try {
          writeStatusLineSettings({ items: next.items, useColors: next.useColors });
          useStore.getState().push("system", "Status line updated.");
        } catch (error) {
          useStore.getState().push("system", `Status line updated for this session, but failed to save: ${errorMessage(error)}`);
        }
      },
    });
  };

  const resetStatusLine = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching || store.busy) return;
    const next = { items: DEFAULT_STATUS_LINE_ITEMS, useColors: true };
    setStatusLineConfig(next);
    try {
      writeStatusLineSettings({ items: next.items, useColors: next.useColors });
      store.push("system", "Status line reset.");
    } catch (error) {
      store.push("system", `Status line reset for this session, but failed to save: ${errorMessage(error)}`);
    }
  };

  /** /config [id] [value] */
  const handleConfigCommand = (args) => {
    const store = useStore.getState();
    if (!args) {
      openConfigPanel();
      return;
    }

    if (store.overlay || store.switching) return;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before changing config.");
      return;
    }

    // 匹配范围包含本地 language 项，与面板保持一致。
    const listed = withLanguageOption(store.configOptions, languageRef.current);
    const space = args.search(/\s/);
    const head = space === -1 ? args : args.slice(0, space);
    const rest = space === -1 ? "" : args.slice(space).trim();
    const option = matchConfigOption(listed, head);
    if (!option) {
      const names = listed
        .filter((item) => item?.id)
        .map((item) => item.name ?? item.id)
        .join(", ");
      store.push("error", `Config option "${head}" not found.${names ? ` Available: ${names}` : ""}`);
      return;
    }

    if (!rest) {
      openConfigPanel(option.id);
      return;
    }

    const choices = configChoices(option);
    if (choices.length === 0) {
      store.push("system", `${option.name ?? option.id} has no selectable values.`);
      return;
    }
    const hit = matchConfigChoice(option, rest);
    if (!hit) {
      const names = choices.map((choice) => choice.name ?? choice.value).join(", ");
      store.push("error", `Invalid value "${rest}" for ${option.name ?? option.id}. Available: ${names}`);
      return;
    }
    void applyConfigOptionValue(option, hit.value);
  };

  /** Shift+Tab 循环切换模式。 */
  const cycleMode = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching || store.busy || modeSwitchingRef.current) return;
    const nextId = getNextModeId(store.modes);
    if (nextId == null) return;
    void applyMode(nextId);
  };

  /** 会话操作前置保护。 */
  const guardSessions = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return null;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before switching sessions.");
      return null;
    }
    return listSessions(process.cwd(), store.providerId);
  };

  /** 关停当前连接并以 sessionId 在当前固定 provider 下重启。 */
  const resumeSession = (sessionId) => {
    const store = useStore.getState();
    const provider = providerRef.current;
    if (!provider) return;
    store.setSwitching("Resuming session…");
    try {
      checkpointUiState();
      clientRef.current?.close();
      store.clearTranscript();
      store.reconnecting();
      startClient(provider, sessionId);
    } finally {
      store.setSwitching(null);
    }
  };

  /** /resume <id> 按前缀匹配。 */
  const resumeById = (args) => {
    const sessions = guardSessions();
    if (!sessions) return;
    const store = useStore.getState();
    if (sessions.length === 0) {
      store.push("system", "No saved sessions for this project yet.");
      return;
    }
    const hit =
      sessions.find((s) => s.sessionId === args) ??
      sessions.find((s) => s.sessionId.startsWith(args));
    if (!hit) {
      store.push("error", `Session "${args}" not found. Use /sessions to list saved sessions.`);
      return;
    }
    resumeSession(hit.sessionId);
  };

  /** /resume 无参数时弹出列表。 */
  const openSessionPicker = () => {
    const sessions = guardSessions();
    if (!sessions) return;
    const store = useStore.getState();
    if (sessions.length === 0) {
      store.push("system", "No saved sessions for this project yet.");
      return;
    }
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    store.setOverlay({
      kind: "session",
      title: "Resume session",
      emptyText: "No matching sessions",
      escapeValue: null,
      items: sessions.map((s) => ({
        value: s.sessionId,
        label: `${formatSessionAge(s.updatedAt)}  ${s.title}  ·  ${s.messages} msgs`,
        right: "",
      })),
      resolve: (value) => {
        store.setOverlay(null);
        const hit = byId.get(value);
        if (hit) resumeSession(hit.sessionId);
      },
    });
  };

  /** 以全新 session 重启；clearTerminal 时顺带清屏。 */
  const startNewSession = ({ clearTerminal = false } = {}) => {
    const store = useStore.getState();
    if (store.busy || store.overlay || store.switching) {
      store.push("system", "Please wait for the current action to finish before starting a new session.");
      return;
    }
    const provider = providerRef.current;
    if (!provider) return;
    if (clearTerminal) write(CLEAR_TERMINAL);
    checkpointUiState();
    clientRef.current?.close();
    store.clearTranscript();
    store.setSessionMeta(null);
    store.reconnecting();
    startClient(provider, null);
  };

  /** 列出已保存会话。 */
  const listSessionsSummary = () => {
    const sessions = guardSessions();
    if (!sessions) return;
    const store = useStore.getState();
    if (sessions.length === 0) {
      store.push("system", "No saved sessions for this project yet.");
      return;
    }
    const lines = sessions
      .slice(0, 20)
      .map(
        (s) =>
          `  ${s.sessionId.slice(0, 8)}  ${s.providerId ?? "?"}  ${formatSessionAge(s.updatedAt)}  ${s.messages} msgs  ${s.title}`
      )
      .join("\n");
    store.push("system", `Saved sessions (${sessions.length}):\n${lines}\n\nUse /resume <id> to resume one.`);
  };

  /** 把当前 transcript 写成文件。 */
  const exportToFile = (filename, content = renderTranscript(useStore.getState().blocks, useStore.getState().pending)) => {
    const store = useStore.getState();
    if (!content) {
      store.push("system", "Nothing to export yet.");
      return;
    }
    const path = join(process.cwd(), ensureTxtExtension(filename));
    try {
      writeFileSync(path, content, "utf8");
      store.push("system", `Conversation exported to: ${path}`);
    } catch (error) {
      store.push("error", `Failed to export conversation: ${errorMessage(error)}`);
    }
  };

  /** 导出选项列表与文件名输入。 */
  const openExportDialog = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before exporting.");
      return;
    }
    const content = renderTranscript(store.blocks, store.pending);
    if (!content) {
      store.push("system", "Nothing to export yet.");
      return;
    }
    const defaultFilename = buildDefaultFilename(store.blocks);
    const showChoices = () => {
      useStore.getState().setOverlay({
        kind: "export",
        title: "Export conversation",
        searchable: false,
        escapeValue: null,
        items: [
          { value: "clipboard", label: "Copy to clipboard" },
          { value: "file", label: "Save to file" },
        ],
        resolve: (value) => {
          const current = useStore.getState();
          if (value === "clipboard") {
            const sequence = osc52Copy(content);
            current.setOverlay(null);
            if (!sequence) {
              current.push("system", "Conversation is too large for the clipboard; please export to a file instead.");
              return;
            }
            write(sequence);
            current.push("system", "Conversation copied to clipboard");
            return;
          }
          if (value === "file") {
            current.setOverlay({
              kind: "export-input",
              title: "Save conversation",
              value: defaultFilename,
              hint: "Enter to save · Esc to go back",
              onSubmit: (name) => {
                current.setOverlay(null);
                exportToFile(name, content);
              },
              onCancel: showChoices,
            });
            return;
          }
          current.setOverlay(null);
          current.push("system", "Export cancelled");
        },
      });
    };
    showChoices();
  };

  /**
   * 提交一次审查。reviewer 用独立的 rubric 提示，与目标提示合并成一条发送。
   *
   * isolated: true 让 miro 把这一轮放进独立上下文（见 MiroAgentClient
   * .promptIsolated）：审查要读几十个文件，过程留在主会话里只会挤占上下文。
   * ACP 的对话历史在 provider 进程里，那里退回普通回合。
   *
   * raw: true 只是不带排队的 bash 上下文；injectContext 仍显式打开，
   * 因为项目约定（AGENTS.md）本身就是审查依据，缺了它容易报出与项目规范
   * 相悖的问题。注入位置在 rubric 之前，所以 rubric 的优先级措辞写成不依赖
   * 前后顺序（见 src/prompts/<language>/review.js 与 review.test.js 的对应断言）。
   */
  const runReview = async (target) => {
    const store = useStore.getState();
    const hint = userFacingHint(target);
    let prompt;
    try {
      prompt = await reviewPrompt(target, process.cwd(), languageRef.current);
    } catch (error) {
      store.push("error", `Failed to start review: ${errorMessage(error)}`);
      return;
    }
    store.push("system", `Reviewing ${hint}…`);
    await sendPrompt(buildReviewRequest(prompt, languageRef.current), `/review ${hint}`, {
      raw: true,
      injectContext: true,
      isolated: true,
    });
  };

  /** 审查前置保护：需要空闲状态与 git 仓库。 */
  const guardReview = async () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return false;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before starting a review.");
      return false;
    }
    if (store.status !== "ready") {
      store.push("system", "Not connected to an ACP provider. Restart with --acp <provider-id>.");
      return false;
    }
    if (!(await isGitRepo(process.cwd()))) {
      store.push("system", "/review needs a git repository in the current directory.");
      return false;
    }
    return true;
  };

  const openReviewBranchPicker = async () => {
    const store = useStore.getState();
    const [branches, current] = await Promise.all([
      localBranches(process.cwd()),
      currentBranch(process.cwd()),
    ]);
    if (branches.length === 0) {
      store.push("system", "No other local branches to compare against.");
      return;
    }
    const head = current ?? "(detached HEAD)";
    store.setOverlay({
      kind: "review-branch",
      title: "Select a base branch",
      emptyText: "No matching branches",
      escapeValue: null,
      items: branches.map((branch) => ({ value: branch, label: `${head} → ${branch}` })),
      resolve: (value) => {
        useStore.getState().setOverlay(null);
        if (value != null) void runReview({ kind: "base-branch", branch: value });
      },
    });
  };

  const openReviewCommitPicker = async () => {
    const store = useStore.getState();
    const commits = await recentCommits(process.cwd());
    if (commits.length === 0) {
      store.push("system", "No commits found in this repository.");
      return;
    }
    store.setOverlay({
      kind: "review-commit",
      title: "Select a commit to review",
      emptyText: "No matching commits",
      escapeValue: null,
      items: commits.map((commit) => ({
        value: commit.sha,
        label: `${commit.sha.slice(0, 7)}  ${commit.subject}`,
      })),
      resolve: (value) => {
        useStore.getState().setOverlay(null);
        if (value == null) return;
        const hit = commits.find((commit) => commit.sha === value);
        void runReview({ kind: "commit", sha: value, title: hit?.subject ?? null });
      },
    });
  };

  const openReviewCustomPrompt = (showPresets) => {
    useStore.getState().setOverlay({
      kind: "review-input",
      title: "Custom review instructions",
      value: "",
      hint: "Enter to start review · Esc to go back",
      onSubmit: (text) => {
        const instructions = String(text ?? "").trim();
        useStore.getState().setOverlay(null);
        if (instructions.length === 0) {
          useStore.getState().push("system", "Review cancelled: no instructions given.");
          return;
        }
        void runReview({ kind: "custom", instructions });
      },
      onCancel: showPresets,
    });
  };

  /** /review 无参数时的预设选择。 */
  const openReviewPicker = async () => {
    if (!(await guardReview())) return;

    const dirty = await hasUncommittedChanges(process.cwd());
    const showPresets = () => {
      useStore.getState().setOverlay({
        kind: "review",
        title: "Select a review preset",
        searchable: false,
        escapeValue: null,
        items: [
          { value: "base-branch", label: "Review against a base branch  (PR style)" },
          {
            value: "uncommitted",
            label: dirty
              ? "Review uncommitted changes"
              : "Review uncommitted changes  (working tree is clean)",
          },
          { value: "commit", label: "Review a commit" },
          { value: "custom", label: "Custom review instructions" },
        ],
        resolve: (value) => {
          const current = useStore.getState();
          if (value === "custom") {
            openReviewCustomPrompt(showPresets);
            return;
          }
          current.setOverlay(null);
          if (value == null) return;
          if (value === "uncommitted") {
            if (!dirty) {
              current.push("system", "No uncommitted changes to review.");
              return;
            }
            void runReview({ kind: "uncommitted" });
            return;
          }
          if (value === "base-branch") void openReviewBranchPicker();
          if (value === "commit") void openReviewCommitPicker();
        },
      });
    };
    showPresets();
  };

  /** /review <instructions> 直接跑自定义审查。 */
  const reviewWithInstructions = async (instructions) => {
    if (!(await guardReview())) return;
    await runReview({ kind: "custom", instructions });
  };

  /**
   * 提交一次简化。与 /review 同构：rubric 与目标提示合并成一条，miro 下同样
   * 交给隔离回合执行。
   *
   * injectContext 同样显式打开——rubric 第 2 条要求「遵守项目既有规范」，
   * 缺了 AGENTS.md 这条约束就无从执行，模型会按自己的口味重写代码。
   */
  const runSimplify = async (target) => {
    const store = useStore.getState();
    const hint = simplifyHint(target);
    let prompt;
    try {
      prompt = await simplifyPrompt(target, process.cwd(), languageRef.current);
    } catch (error) {
      store.push("error", `Failed to start simplify: ${errorMessage(error)}`);
      return;
    }
    store.push("system", `Simplifying ${hint}…`);
    await sendPrompt(buildSimplifyRequest(prompt, languageRef.current), `/simplify ${hint}`, {
      raw: true,
      injectContext: true,
      isolated: true,
    });
  };

  /**
   * 简化前置保护：只要求空闲与已连接。
   * 与 guardReview 不同，这里不强制 git 仓库：paths / custom 目标不依赖 git，
   * 需要 git 的预设各自在选中时再校验。
   */
  const guardSimplify = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return false;
    if (store.busy) {
      store.push("system", "Please wait for the current response to finish before starting a simplify.");
      return false;
    }
    if (store.status !== "ready") {
      store.push("system", "Not connected to an ACP provider. Restart with --acp <provider-id>.");
      return false;
    }
    return true;
  };

  const openSimplifyBranchPicker = async () => {
    const store = useStore.getState();
    const [branches, current] = await Promise.all([
      localBranches(process.cwd()),
      currentBranch(process.cwd()),
    ]);
    if (branches.length === 0) {
      store.push("system", "No other local branches to compare against.");
      return;
    }
    const head = current ?? "(detached HEAD)";
    store.setOverlay({
      kind: "simplify-branch",
      title: "Select a base branch",
      emptyText: "No matching branches",
      escapeValue: null,
      items: branches.map((branch) => ({ value: branch, label: `${head} → ${branch}` })),
      resolve: (value) => {
        useStore.getState().setOverlay(null);
        if (value != null) void runSimplify({ kind: "base-branch", branch: value });
      },
    });
  };

  const openSimplifyCommitPicker = async () => {
    const store = useStore.getState();
    const commits = await recentCommits(process.cwd());
    if (commits.length === 0) {
      store.push("system", "No commits found in this repository.");
      return;
    }
    store.setOverlay({
      kind: "simplify-commit",
      title: "Select a commit to simplify",
      emptyText: "No matching commits",
      escapeValue: null,
      items: commits.map((commit) => ({
        value: commit.sha,
        label: `${commit.sha.slice(0, 7)}  ${commit.subject}`,
      })),
      resolve: (value) => {
        useStore.getState().setOverlay(null);
        if (value == null) return;
        const hit = commits.find((commit) => commit.sha === value);
        void runSimplify({ kind: "commit", sha: value, title: hit?.subject ?? null });
      },
    });
  };

  /** paths / custom 共用输入框，只有标题、空值文案和目标构造不同。 */
  const openSimplifyInput = ({ title, emptyMessage, buildTarget, showPresets }) => {
    useStore.getState().setOverlay({
      kind: "simplify-input",
      title,
      value: "",
      hint: "Enter to start simplify · Esc to go back",
      onSubmit: (text) => {
        const entered = String(text ?? "").trim();
        useStore.getState().setOverlay(null);
        if (entered.length === 0) {
          useStore.getState().push("system", emptyMessage);
          return;
        }
        void runSimplify(buildTarget(entered));
      },
      onCancel: showPresets,
    });
  };

  /** /simplify 无参数时的预设选择，层级与 /review 一致。 */
  const openSimplifyPicker = async () => {
    if (!guardSimplify()) return;

    const inRepo = await isGitRepo(process.cwd());
    const dirty = inRepo && (await hasUncommittedChanges(process.cwd()));
    // 三态标签：可简化 / 仓库干净 / 压根不是仓库。嵌套三元读起来太绕，摊平成变量。
    let uncommittedSuffix = "";
    if (!inRepo) uncommittedSuffix = "  (not a git repository)";
    else if (!dirty) uncommittedSuffix = "  (working tree is clean)";
    const showPresets = () => {
      useStore.getState().setOverlay({
        kind: "simplify",
        title: "Select a simplify preset",
        searchable: false,
        escapeValue: null,
        items: [
          {
            value: "uncommitted",
            label: `Simplify uncommitted changes${uncommittedSuffix}`,
          },
          { value: "base-branch", label: "Simplify changes against a base branch  (PR style)" },
          { value: "commit", label: "Simplify code from a commit" },
          { value: "paths", label: "Simplify specific files or directories" },
          { value: "custom", label: "Custom simplify instructions" },
        ],
        resolve: (value) => {
          const current = useStore.getState();
          if (value === "paths") {
            openSimplifyInput({
              title: "Files or directories to simplify",
              emptyMessage: "Simplify cancelled: no paths given.",
              buildTarget: (paths) => ({ kind: "paths", paths }),
              showPresets,
            });
            return;
          }
          if (value === "custom") {
            openSimplifyInput({
              title: "Custom simplify instructions",
              emptyMessage: "Simplify cancelled: no instructions given.",
              buildTarget: (instructions) => ({ kind: "custom", instructions }),
              showPresets,
            });
            return;
          }
          current.setOverlay(null);
          if (value == null) return;
          // 下面三个预设都靠 git 定位范围，非仓库时直接说明而不是让模型空跑。
          if (!inRepo) {
            current.push("system", "/simplify needs a git repository for this preset.");
            return;
          }
          switch (value) {
            case "uncommitted":
              if (!dirty) {
                current.push("system", "No uncommitted changes to simplify.");
                return;
              }
              void runSimplify({ kind: "uncommitted" });
              return;
            case "base-branch":
              void openSimplifyBranchPicker();
              return;
            case "commit":
              void openSimplifyCommitPicker();
              return;
          }
        },
      });
    };
    showPresets();
  };

  /** /simplify <args>：全是路径就按 paths 处理，否则当自由指令。 */
  const simplifyWithArgs = async (args) => {
    if (!guardSimplify()) return;
    await runSimplify(
      looksLikePaths(args) ? { kind: "paths", paths: args } : { kind: "custom", instructions: args }
    );
  };

  /**
   * 提交一次 commit。与 /review、/simplify 同构：rubric 与目标提示合并成一条，
   * miro 下同样交给隔离回合执行。
   *
   * injectContext 打开的理由和 /simplify 一样，但落点不同：rubric 要求 commit
   * message 跟随仓库既有风格，而风格约定（前缀、语气、是否带 issue 号）通常
   * 就写在 AGENTS.md 里。缺了它模型只能从 git log 反推，附带说明性约定会丢。
   */
  const runCommit = async (target) => {
    const store = useStore.getState();
    const hint = commitHint(target);
    let prompt;
    try {
      prompt = await commitPrompt(target, process.cwd(), languageRef.current);
    } catch (error) {
      store.push("error", `Failed to start commit: ${errorMessage(error)}`);
      return;
    }
    store.push("system", `Committing ${hint}…`);
    await sendPrompt(buildCommitRequest(prompt, languageRef.current), `/commit ${hint}`, {
      raw: true,
      injectContext: true,
      isolated: true,
    });
  };

  /**
   * 提交前置保护。比 guardSimplify 多一条 git 仓库校验：/commit 的每一种目标都
   * 要跑 git，没有仓库时无论如何都不该把提示词发出去。
   */
  const guardCommit = async ({ command = "/commit", action = "starting a commit" } = {}) => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return false;
    if (store.busy) {
      store.push("system", `Please wait for the current response to finish before ${action}.`);
      return false;
    }
    if (store.status !== "ready") {
      store.push("system", "Not connected to an ACP provider. Restart with --acp <provider-id>.");
      return false;
    }
    if (!(await isGitRepo(process.cwd()))) {
      store.push("system", `${command} needs a git repository.`);
      return false;
    }
    return true;
  };

  /**
   * 目标可行性校验，放在发 prompt 之前。
   * 上游 rubric 里「无改动就不要建空提交」「不要随便 --amend」是写给模型的约束，
   * 但能在本地用一次 git 查询确定的事情，不该浪费一个回合让模型去发现。
   */
  const commitTargetBlocker = async (target) => {
    const cwd = process.cwd();
    if (target.kind === "staged" && !(await hasStagedChanges(cwd))) {
      return "Nothing staged to commit. Stage changes first, or use /commit without arguments.";
    }
    if (target.kind === "amend" && !(await hasCommits(cwd))) {
      return "No existing commit to amend.";
    }
    if ((target.kind === "default" || target.kind === "message") && !(await hasUncommittedChanges(cwd))) {
      return "No changes to commit.";
    }
    return null;
  };

  /** 校验目标后再跑，被拦下时只提示原因。 */
  const startCommit = async (target) => {
    const blocker = await commitTargetBlocker(target);
    if (blocker) {
      useStore.getState().push("system", blocker);
      return;
    }
    await runCommit(target);
  };

  /** message / paths 共用输入框，只有标题、空值文案和目标构造不同。 */
  const openCommitInput = ({ title, emptyMessage, buildTarget, showPresets }) => {
    useStore.getState().setOverlay({
      kind: "commit-input",
      title,
      value: "",
      hint: "Enter to start commit · Esc to go back",
      onSubmit: (text) => {
        const entered = String(text ?? "").trim();
        useStore.getState().setOverlay(null);
        if (entered.length === 0) {
          useStore.getState().push("system", emptyMessage);
          return;
        }
        void startCommit(buildTarget(entered));
      },
      onCancel: showPresets,
    });
  };

  /** /commit 无参数时的预设选择，层级与 /review、/simplify 一致。 */
  const openCommitPicker = async () => {
    if (!(await guardCommit())) return;

    const cwd = process.cwd();
    const [dirty, staged, committed] = await Promise.all([
      hasUncommittedChanges(cwd),
      hasStagedChanges(cwd),
      hasCommits(cwd),
    ]);
    // 每个预设都把「现在能不能用」写进标签，避免选中后才被拦下来。
    const dirtySuffix = dirty ? "" : "  (working tree is clean)";
    const stagedSuffix = staged ? "" : "  (nothing staged)";
    const amendSuffix = committed ? "" : "  (no commit to amend)";
    const showPresets = () => {
      useStore.getState().setOverlay({
        kind: "commit",
        title: "Select a commit preset",
        searchable: false,
        escapeValue: null,
        items: [
          { value: "default", label: `Commit all changes${dirtySuffix}` },
          { value: "staged", label: `Commit staged changes only${stagedSuffix}` },
          { value: "paths", label: "Commit specific files or directories" },
          { value: "message", label: "Commit with a message you provide" },
          { value: "amend", label: `Amend the last commit${amendSuffix}` },
        ],
        resolve: (value) => {
          const current = useStore.getState();
          if (value === "paths") {
            openCommitInput({
              title: "Files or directories to commit",
              emptyMessage: "Commit cancelled: no paths given.",
              buildTarget: (paths) => ({ kind: "paths", paths }),
              showPresets,
            });
            return;
          }
          if (value === "message") {
            openCommitInput({
              title: "Commit message",
              emptyMessage: "Commit cancelled: no message given.",
              buildTarget: (message) => ({ kind: "message", message }),
              showPresets,
            });
            return;
          }
          current.setOverlay(null);
          if (value == null) return;
          void startCommit({ kind: value });
        },
      });
    };
    showPresets();
  };

  /** /commit <args>：staged / amend 关键词、路径、message 三分流。 */
  const commitWithArgs = async (args) => {
    if (!(await guardCommit())) return;
    await startCommit(parseCommitArgs(args));
  };

  /**
   * /commit-push-pr 不复用 commitTargetBlocker：commit 或 push 已成功后的重试
   * 可能面对干净工作区，但仍需继续推送或建 PR。模型会按当前 git 状态续跑。
   */
  const commitPushPr = async () => {
    if (!(await guardCommit({ command: "/commit-push-pr", action: "publishing changes" }))) return;
    const store = useStore.getState();
    let prompt;
    try {
      prompt = await commitPushPrPrompt(process.cwd(), languageRef.current);
    } catch (error) {
      store.push("error", `Failed to start commit-push-pr: ${errorMessage(error)}`);
      return;
    }
    store.push("system", "Committing, pushing, and creating a pull request…");
    await sendPrompt(
      buildCommitPushPrRequest(prompt, languageRef.current),
      "/commit-push-pr",
      { raw: true, injectContext: true, isolated: true }
    );
  };

  /** 本地执行 `!` 命令。 */
  const runBashCommand = async (command) => {
    const store = useStore.getState();
    if (!command) {
      store.push("system", "Please enter a command to run, e.g. !ls -la");
      return;
    }

    store.startBashCard(command);
    store.startTurn("bash");
    const task = startBash(command);
    bashTaskRef.current = task;
    try {
      const { stdout, stderr, outcome } = await task.result;

      store.finishBashCard({ stdout, stderr, outcome });
      store.pushBashContext(formatBashContext({ command, stdout, stderr, outcome }));
    } finally {
      bashTaskRef.current = null;
      store.endTurn();
    }
  };

  /**
   * 目标前置保护。
   *
   * 目标是 miro 专属：状态机与续跑循环都在 MiroAgentClient 里，ACP 的对话
   * 历史在 provider 进程里，没有可挂载的地方。这里显式说明而不是静默无视，
   * 否则用户只会看到命令被吞掉（沿用 openPermissionPicker 的做法）。
   */
  const guardGoal = () => {
    const store = useStore.getState();
    if (store.overlay || store.switching) return null;
    if (store.status !== "ready") {
      store.push("system", "Not connected to an ACP provider. Restart with --acp <provider-id>.");
      return null;
    }
    if (!isMiroProvider({ id: store.providerId })) {
      store.push("system", "Goals are only available in Miro.");
      return null;
    }
    const client = clientRef.current;
    // 再补一层能力探测：会话中途换 provider 时 providerId 与 client 可能短暂不一致。
    if (typeof client?.promptGoal !== "function") {
      store.push("system", "This provider does not support goals.");
      return null;
    }
    return client;
  };

  /** 目标状态摘要；纯本地，不发模型。 */
  const showGoalStatus = () => {
    const client = guardGoal();
    if (!client) return;
    const store = useStore.getState();
    const goal = client.goalSnapshot();
    if (goal == null) {
      store.push("system", "No goal yet. Use /goal <objective> to start one.");
      return;
    }
    const lines = [
      `Objective: ${goal.objective}`,
      goal.completionCriterion ? `Done when: ${goal.completionCriterion}` : null,
      `Status: ${goal.status}${goal.terminalReason ? ` (${goal.terminalReason})` : ""}`,
      `Progress: ${goal.turnsUsed} turns, ${goal.tokensUsed} tokens, ${formatElapsed(goal.wallClockMs)} elapsed`,
    ].filter((line) => line != null);
    const budgets = [
      goal.budget.turnBudget != null ? `${goal.budget.remainingTurns} turns` : null,
      goal.budget.tokenBudget != null ? `${goal.budget.remainingTokens} tokens` : null,
      goal.budget.wallClockBudgetMs != null
        ? formatElapsed(goal.budget.remainingWallClockMs ?? 0)
        : null,
    ].filter((part) => part != null);
    if (budgets.length > 0) lines.push(`Remaining budget: ${budgets.join(", ")}`);
    if (goal.status === "paused" || goal.status === "blocked") {
      lines.push("Use /goal resume to continue it.");
    }
    store.push("system", lines.join("\n"));
  };

  /**
   * 跑一个目标：新建或恢复。
   *
   * 整个多回合循环只包一次 startTurn/endTurn。目标在用户眼里是一件事，
   * 逐回合翻转 busy 会让输入框在续跑间隙短暂可用，把新输入插进循环中间；
   * 而 store 的 endTurn 只认单回合语义（它要打印一次「Done in Xs」）。
   * 中断由 client 侧的 goalRunId 版本号负责，不靠这里的 busy 标志。
   */
  const runGoal = async (start, displayText, { recordUser = true } = {}) => {
    const store = useStore.getState();
    if (recordUser) store.push("user", displayText);
    store.startTurn("prompt");
    let result;
    try {
      result = await start();
    } catch (error) {
      // promptGoal 在失败时已经把目标置为 paused 并重抛，这里只负责告知用户。
      if (useStore.getState().cancelling) result = { stopReason: "cancelled" };
      else store.push("error", `Goal failed: ${errorMessage(error)}`);
    } finally {
      flushQueuedThought();
      store.endTurn(result);
      drainQueue();
    }
    const goal = clientRef.current?.goalSnapshot?.();
    if (goal != null && ["paused", "blocked", "complete"].includes(goal.status)) {
      const reason = goal.terminalReason ? ` — ${goal.terminalReason}` : "";
      useStore
        .getState()
        .push("system", `Goal ${goal.status} after ${goal.turnsUsed} turns${reason}`);
    }
  };

  /** /goal <objective>：已有目标时替换（旧目标的进度已随状态摘要打印过）。 */
  const startGoal = (objective) => {
    const client = guardGoal();
    if (!client) return;
    const store = useStore.getState();
    if (store.busy) {
      if (typeof client.createPendingGoal !== "function" || typeof client.activatePendingGoal !== "function") {
        store.push("system", "This provider cannot safely start a goal while a response is running.");
        return;
      }
      try {
        client.createPendingGoal(objective, { replace: true });
        goalTakeoverRef.current = { client, displayText: `/goal ${objective}` };
        client.cancel();
      } catch (error) {
        store.push("error", `Could not queue goal: ${errorMessage(error)}`);
      }
      return;
    }
    void runGoal(
      () => client.promptGoal(objective, { replace: true }),
      `/goal ${objective}`
    );
  };

  const resumeGoal = () => {
    const client = guardGoal();
    if (!client) return;
    const store = useStore.getState();
    const goal = client.goalSnapshot();
    if (goal == null) {
      store.push("system", "No goal to resume. Use /goal <objective> to start one.");
      return;
    }
    if (goal.status === "active") {
      store.push("system", "The goal is already running.");
      return;
    }
    if (goal.status === "complete") {
      store.push("system", "That goal is already complete. Use /goal <objective> to start a new one.");
      return;
    }
    if (store.busy) {
      if (typeof client.queueResumeGoal !== "function" || typeof client.activatePendingGoal !== "function") {
        store.push("system", "This provider cannot safely resume a goal while a response is running.");
        return;
      }
      try {
        client.queueResumeGoal();
        goalTakeoverRef.current = { client, displayText: "/goal resume" };
        client.cancel();
      } catch (error) {
        store.push("error", `Could not queue goal resume: ${errorMessage(error)}`);
      }
      return;
    }
    void runGoal(() => client.resumeGoal(), "/goal resume");
  };

  const pauseGoal = () => {
    const client = guardGoal();
    if (!client) return;
    const store = useStore.getState();
    const goal = client.goalSnapshot();
    if (goal == null || goal.status !== "active") {
      store.push("system", "No running goal to pause.");
      return;
    }
    if (store.busy) {
      goalTakeoverRef.current = null;
      if (typeof client.requestPauseGoal !== "function") {
        store.push("system", "This provider cannot safely pause a running goal.");
        return;
      }
      client.requestPauseGoal("Paused by user");
      client.cancel();
      return;
    }
    client.pauseGoal("Paused by user");
    store.push("system", "Goal paused. Use /goal resume to continue it.");
  };

  const cancelGoal = () => {
    const client = guardGoal();
    if (!client) return;
    const store = useStore.getState();
    if (client.goalSnapshot() == null) {
      store.push("system", "No goal to cancel.");
      return;
    }
    goalTakeoverRef.current = null;
    client.cancelGoal();
    if (store.busy) {
      goalAfterStopNoticeRef.current = "Goal cancelled.";
      client.cancel();
      return;
    }
    store.push("system", "Goal cancelled.");
  };

  /** /goal 的子命令分派；不认识的词一律当目标正文，避免吞掉真实目标。 */
  const handleGoalCommand = (args) => {
    if (useStore.getState().modes?.currentModeId === "plan") {
      useStore.getState().push("system", "Exit Plan Mode before starting or changing a goal.");
      return;
    }
    const text = (args ?? "").trim();
    if (text.startsWith("replace ")) {
      const objective = text.slice("replace ".length).trim();
      if (objective.length === 0) {
        useStore.getState().push("error", "Usage: /goal replace <objective>");
      } else {
        startGoal(objective);
      }
      return;
    }
    switch (text) {
      case "":
      case "status":
        showGoalStatus();
        break;
      case "resume":
      case "continue":
        resumeGoal();
        break;
      case "pause":
      case "stop":
        pauseGoal();
        break;
      case "cancel":
      case "clear":
        cancelGoal();
        break;
      default:
        startGoal(text);
    }
  };

  // raw 控制「是否原样转发」（不带排队的 bash 上下文），injectContext 单独控制
  // 首轮 AGENTS.md 注入：/review 需要前者而不需要后者，两者不能共用一个开关。
  //
  // isolated：/review、/commit、/init 这类命令型任务在独立上下文里执行，过程不
  // 进主会话历史（见 MiroAgentClient.promptIsolated）。只有 miro 支持这个，
  // ACP 的对话历史在 provider 进程里，那里静默回退成普通回合。
  const sendPrompt = async (content, displayText, { raw = false, injectContext = !raw, isolated = false } = {}) => {
    const store = useStore.getState();
    if (store.busy) {
      store.push("system", "Please wait for the current operation to finish.");
      return;
    }
    if (store.status !== "ready") {
      store.push("system", "Not connected to an ACP provider. Restart with --acp <provider-id>.");
      return;
    }
    store.push("user", displayText);
    store.startTurn("prompt");
    const bashContext = raw ? [] : store.takeBashContext();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const payload =
      bashContext.length > 0
        ? [...bashContext.map((item) => ({ type: "text", text: item })), ...blocks]
        : blocks;
    const client = clientRef.current;
    const detach = isolated && typeof client.promptIsolated === "function";
    let result;
    try {
      result = detach
        ? await client.promptIsolated(payload, { displayText, injectContext })
        : await client.prompt(payload, { injectContext });
    } catch (error) {
      if (bashContext.length > 0) store.restoreBashContext(bashContext);
      if (useStore.getState().cancelling) result = { stopReason: "cancelled" };
      else store.push("error", `Request failed: ${errorMessage(error)}`);
    } finally {
      flushQueuedThought();
      store.endTurn(result);
      const transition = result?.transition;
      if (transition?.type === "plan_entered") {
        store.queueInput(
          "Continue the current request in Plan Mode. Inspect the workspace, resolve material uncertainties, and write the implementation plan.",
          "Continue in Plan Mode",
        );
      } else if (transition?.type === "plan_approved") {
        store.pushProposedPlan(transition.plan, transition.path);
        store.queueInput(approvedPlanPrompt(transition.plan), "Implement approved plan");
      }
      drainQueue();
    }
  };

  /** 不创建用户消息或普通模型回合；ACP 只转发其明确声明的 compact 命令。 */
  const compactConversation = async (instructions, commandText) => {
    const store = useStore.getState();
    const client = clientRef.current;
    if (store.overlay || store.switching) return;
    if (store.status !== "ready" || !client) {
      store.push("system", "Wait for the session to be ready before compacting context.");
      return;
    }
    if (store.busy) {
      store.push("system", "Wait for the current operation to finish, or press Esc before using /compact.");
      return;
    }
    if (typeof client.compact !== "function") {
      if (matchProviderCommand(commandText, store.providerCommands)) await sendPrompt(commandText, commandText, { raw: true });
      else store.push("system", "This provider does not support /compact.");
      return;
    }
    store.startTurn("compact");
    let result;
    try {
      result = await client.compact({ instructions });
      if (result.reason === "nothing_to_compact") store.push("system", "Not enough history to compact.");
    } catch (error) {
      if (useStore.getState().cancelling) result = { stopReason: "cancelled" };
      else store.push("error", `Compaction failed: ${errorMessage(error)}`);
    } finally {
      store.endTurn(result);
      drainQueue();
    }
  };

  /** 按序发送排队输入。 */
  const drainQueue = () => {
    const client = clientRef.current;
    if (client?.goalSnapshot?.()?.status === "pausing" && typeof client.finishPauseGoal === "function") {
      client.finishPauseGoal();
      useStore.getState().push("system", "Goal paused. Use /goal resume to continue it.");
    }
    const afterStopNotice = goalAfterStopNoticeRef.current;
    if (afterStopNotice != null) {
      goalAfterStopNoticeRef.current = null;
      useStore.getState().push("system", afterStopNotice);
    }
    const takeover = goalTakeoverRef.current;
    if (takeover != null) {
      goalTakeoverRef.current = null;
      // 旧回合刚刚 endTurn；接管必须优先于普通输入队列，避免用户以为目标已启用
      // 却先跑了一条过时的普通消息。
      if (takeover.client === clientRef.current && typeof takeover.client.activatePendingGoal === "function") {
        void runGoal(() => takeover.client.activatePendingGoal(), takeover.displayText);
        return;
      }
    }
    const queued = useStore.getState().takeQueuedInput();
    if (queued != null) void handleSubmit(queued.text, queued.display);
  };

  const handleSubmit = async (raw, display) => {
    const store = useStore.getState();
    const submitted = prepareSubmittedInput(raw, display);
    if (!submitted) return;
    const { content, commandText: text, display: shown, transcriptText } = submitted;

    if (store.busy) {
      if (isBashInput(text)) {
        store.push("system", "Please wait for the current response to finish before running shell commands.");
        return;
      }
      // 退出指令不能排队：`exit` / `quit` 与 `/exit` 一样立即生效，否则用户看到的
      // 只是「输入被吞掉」，而它下一轮还会作为普通 prompt 发给模型。
      if (!parseCommandInput(text) && !bareExitCommand(text)) {
        store.queueInput(content, shown);
        return;
      }
    }

    if (isBashInput(text)) {
      await runBashCommand(getBashCommand(text));
      return;
    }

    const commandHandlers = {
      login: (args) => args ? store.push("system", "Usage: /login") : openLoginPicker(),
      init: (args) =>
        void sendPrompt(
          [{ type: "text", text: buildInitPrompt(args, languageRef.current) }],
          args ? `/init ${args}` : "/init",
          { isolated: true }
        ),
      model: (args) => (args ? setModelByName(args) : openModelPicker()),
      effort: (args) => (args ? setEffortByName(args) : openEffortPicker()),
      config: handleConfigCommand,
      statusline: (args) => (args.trim() === "reset" ? resetStatusLine() : openStatusLineSetup()),
      thinking: (args) => (args ? setThinkingDisplayByName(args) : openThinkingPicker()),
      permissions: (args) => (args ? setPermissionModeByName(args) : openPermissionPicker()),
      plan: handlePlanCommand,
      resume: (args) => (args ? resumeById(args) : openSessionPicker()),
      new: startNewSession,
      sessions: listSessionsSummary,
      compact: (args) => void compactConversation(args, text),
      export: (args) => (args ? exportToFile(args) : openExportDialog()),
      review: (args) => void (args ? reviewWithInstructions(args) : openReviewPicker()),
      goal: handleGoalCommand,
      simplify: (args) => void (args ? simplifyWithArgs(args) : openSimplifyPicker()),
      commit: (args) => void (args ? commitWithArgs(args) : openCommitPicker()),
      "commit-push-pr": () => void commitPushPr(),
      clear: () => startNewSession({ clearTerminal: true }),
      help: () => store.push("system", HELP.trimEnd()),
      exit: exitSession,
    };

    const parsed = parseCommandInput(text) ?? bareExitCommand(text);
    if (parsed) {
      commandHandlers[parsed.key]?.(parsed.args);
      return;
    }

    if (matchProviderCommand(text, store.providerCommands)) {
      await sendPrompt(text, shown ?? text, { raw: true });
      return;
    }

    await sendPrompt(content, transcriptText);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (helpOpen) {
        setHelpOpen(false);
        return;
      }
      const store = useStore.getState();
      if (!store.overlay && (store.busy || bashTaskRef.current)) interrupt();
      return;
    }
    if (!key.ctrl) return;
    // Ctrl+M 与 Enter 在传统编码下都是 CR，只有在 kitty 键盘协议下才会以
    // CSI u 单独到达（tui.jsx 已开启 kittyKeyboard）。收不到就说明终端不支持。
    if (input === "m") {
      openModelPicker();
      return;
    }
    if (input === "c") {
      const store = useStore.getState();
      const controls = composerControlsRef.current;
      switch (ctrlCIntent({
        hasOverlay: Boolean(store.overlay),
        hasDraft: controls?.hasDraft() ?? false,
      })) {
        case "overlay":
          cancelOverlay(store.overlay);
          return;
        case "draft":
          controls.clearDraft();
          cancelExitConfirm();
          return;
        default:
          interrupt();
          confirmExit();
          return;
      }
    }
    if (input === "l") clearScreen();
    if (input === "o") {
      const store = useStore.getState();
      const target = findReviewTarget(store);
      if (!target) return;
      switch (target.kind) {
        case "close":
          store.setOverlay(null);
          return;
        case "review":
          store.setOverlay({
            kind: "review-browser",
            entries: target.entries,
            initialIndex: target.index,
            escapeValue: null,
            resolve: () => useStore.getState().setOverlay(null),
          });
          return;
      }
    }
    if (input === "q") {
      const store = useStore.getState();
      if (store.overlay?.kind === "queue-review") {
        store.setOverlay(null);
      } else if (!store.overlay && store.queuedInputs.length > 0) {
        store.setOverlay({
          kind: "queue-review",
          escapeValue: null,
          resolve: () => useStore.getState().setOverlay(null),
        });
      }
    }
  });

  const connecting = status === "connecting";

  return (
    <Box flexDirection="column">
      <Transcript />
      {overlay?.kind === "review-browser" ? (
        <ReviewBrowser
          entries={overlay.entries}
          initialIndex={overlay.initialIndex}
          onClose={() => useStore.getState().setOverlay(null)}
        />
      ) : overlay?.kind === "queue-review" ? (
        <QueueEditor onClose={() => useStore.getState().setOverlay(null)} />
      ) : (
        <>
      {bashCard ? <BashCard card={bashCard} /> : null}
      {pending ? <Message block={pending} /> : null}
      <ActivitySlot
        now={now}
        busy={busy}
        cancelling={cancelling}
        activeTools={activeTools}
        pendingToolGroup={pendingToolGroup}
        hasBashActivity={Boolean(bashCard)}
        awaitingInput={awaitingInput}
      />
      <StatusVerb
        now={now}
        busy={busy}
        cancelling={cancelling}
        compacting={compacting}
        turnStartedAt={turnStartedAt}
        toolRound={toolRound}
        hasBashActivity={Boolean(bashCard)}
        awaitingInput={awaitingInput}
        retryNotice={retryNotice}
      />

      <Box flexDirection="column" marginTop={1}>
        {overlay?.kind === "permission" ? (
          <PermissionDialog
            toolCall={overlay.toolCall}
            items={overlay.items}
            escapeValue={overlay.escapeValue}
            onResolve={(value) => overlay.resolve(value)}
          />
        ) : overlay?.kind === "plan-review" ? (
          <PlanReviewDialog
            plan={overlay.plan}
            path={overlay.path}
            onResolve={(value) => overlay.resolve(value)}
          />
        ) : overlay?.kind === "user-question" ? (
          <UserQuestionDialog
            questions={overlay.questions}
            onResolve={(value) => overlay.resolve(value)}
          />
        ) : overlay?.kind === "export-input" || overlay?.kind === "oauth-input" ||
          overlay?.kind === "review-input" ||
          overlay?.kind === "simplify-input" ||
          overlay?.kind === "commit-input" ? (
          <InputPrompt
            title={overlay.title}
            value={overlay.value}
            secret={overlay.secret}
            hint={overlay.hint}
            onSubmit={overlay.onSubmit}
            onCancel={overlay.onCancel}
          />
      ) : overlay?.kind === "config" ? (
          <ConfigPanel
            options={panelConfigOptions}
            focusId={overlay.focusId}
            switching={switching}
            onChange={(option, value) => void applyConfigOptionValue(option, value)}
            onCancel={() => overlay.resolve(overlay.escapeValue)}
          />
        ) : overlay?.kind === "statusline" ? (
          <StatusLineSetup
            configuredIds={overlay.configuredIds}
            useColors={overlay.useColors}
            snapshot={overlay.snapshot}
            onConfirm={(value) => overlay.resolve(value)}
            onCancel={() => overlay.resolve(overlay.escapeValue)}
          />
        ) : overlay?.steps ? (
          <PickerFlow
            steps={overlay.steps}
            initialContext={overlay.initialContext}
            color="cyan"
            onComplete={(context) => overlay.resolve(context)}
            onCancel={() => overlay.resolve(overlay.escapeValue)}
          />
        ) : overlay ? (
          <Picker
            title={overlay.title}
            subtitle={overlay.subtitle}
            items={overlay.items}
            selected={overlay.selected}
            color="cyan"
            searchable={overlay.searchable ?? true}
            emptyText={overlay.emptyText}
            footerHint={overlay.footerHint}
            onSelect={(item) => overlay.resolve(item?.value ?? overlay.escapeValue)}
            onCancel={() => overlay.resolve(overlay.escapeValue)}
          />
        ) : null}

        {/* display:none 只隐藏布局，不卸载 Composer；光标、paste 和历史游标因此都能原样恢复。 */}
        <ComposerSurface
          hidden={composerIsHidden(connecting, overlay?.kind)}
          disabled={overlay != null || switching != null}
          locked={modeSwitching || exiting}
          onSubmit={handleSubmit}
          onCycleMode={cycleMode}
          providerCommands={providerCommands}
          helpOpen={helpOpen}
          onHelpOpenChange={setHelpOpen}
          onCompletionOpenChange={setCompletionOpen}
          sessionKey={composerSession.key}
          initialSnapshot={composerSession.snapshot}
          onSnapshotChange={handleComposerSnapshotChange}
          controlsRef={composerControlsRef}
        />

        {queuedInputs.length > 0 ? (
          <Box paddingX={1}>
            <Text dimColor>
              {queuedInputs.length} message{queuedInputs.length > 1 ? "s" : ""} queued · Ctrl+Q to review
            </Text>
          </Box>
        ) : null}

        <StatusBar
          status={status}
          connectionStage={connectionStage}
          agentBin={agentBin}
          busy={busy}
          cancelling={cancelling}
          switching={switching}
          exitConfirming={exitConfirming}
          statusLineItems={statusLineConfig.items}
          statusLineUseColors={statusLineConfig.useColors}
          goal={goal}
          statusLineSnapshot={{
            modelName: modelConfig ? currentModelName(modelConfig) : null,
            effortName: currentEffortName(effortConfig),
            modeName:
              modes?.availableModes?.find((mode) => mode.id === modes?.currentModeId)?.name ??
              modes?.currentModeId ??
              null,
            cwd: process.cwd(),
            projectName: projectNameFor(process.cwd()),
            hostname: hostname(),
            permissionMode,
            gitBranch,
            providerName,
            sessionId,
            sessionTitle,
            version: APP_VERSION,
            usage,
            sessionTokens,
            sessionCost,
            plan: planProgress,
            goal,
            busy,
            cancelling,
            thinking,
          }}
          hidden={statusLineIsHidden({ helpOpen, completionOpen, overlay })}
        />
      </Box>
        </>
      )}
    </Box>
  );
}
