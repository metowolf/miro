/**
 * miro harness 内置工具的统一入口。
 *
 * 每个工具模块同时维护自己的 schema 与执行器；本文件只负责注册、按上下文
 * 装配执行器，以及与具体工具无关的参数解析和并发分批。
 */

import { EDIT_FILE_DEFINITION, editFileTool } from "./edit-file.js";
import { GLOB_DEFINITION, globTool } from "./glob.js";
import { GREP_DEFINITION, grepTool } from "./grep.js";
import { READ_FILE_DEFINITION, readTool } from "./read-file.js";
import {
  TERMINAL_DEFINITION,
  hostTerminalTool,
  readOnlyHostTerminalTool,
  sandboxedTerminalTool,
  terminalDefinition,
} from "./terminal.js";
import { SPAWN_AGENT_DEFINITION, spawnAgentTool } from "./spawn-agent.js";
import {
  ENTER_PLAN_MODE_DEFINITION,
  EXIT_PLAN_MODE_DEFINITION,
  REQUEST_USER_INPUT_DEFINITION,
  enterPlanModeTool,
  exitPlanModeTool,
  requestUserInputTool,
} from "./plan-mode.js";
import {
  SET_GOAL_BUDGET_DEFINITION,
  UPDATE_GOAL_DEFINITION,
  setGoalBudgetTool,
  updateGoalTool,
} from "./update-goal.js";
import { UPDATE_TASKS_DEFINITION, updateTasksTool } from "./update-tasks.js";
import { WRITE_FILE_DEFINITION, editTool, writeFileTool } from "./write-file.js";

/** 需要用户确认的工具：写与执行。 */
export const CONFIRM_KINDS = new Set(["edit", "execute", "delete", "move"]);

/** 可并行的工具 kind：只包含不产生独立 agent 生命周期的只读或状态更新调用。 */
export const CONCURRENCY_SAFE_KINDS = new Set(["read", "search", "tasks", "goal"]);

/** 同一批并行执行的上限：防止大量只读工具同时耗尽资源。 */
export const MAX_PARALLEL_TOOL_CALLS = 8;

/**
 * 不允许「边收流边执行」的 kind。
 *
 * spawn_agent 起的是拥有共享审批通道的子智能体，循环层无法预判它会不会弹窗，
 * 因此一律留给流结束后的批处理阶段。
 */
export const EAGER_BLOCKED_KINDS = new Set(["spawn", "input", "plan"]);

/**
 * 这条调用能否在流里一出现就开跑。
 *
 * 只做「静态可判」的那一半：kind 已知、参数解析得出对象、kind 不在屏蔽表里。
 * 「会不会弹审批框」需要权限模式与两个记忆集合，由 agent-loop 补上——本函数
 * 刻意不碰那些状态，好让 tools 这一层保持无状态、可单测。
 */
export function isStreamingEagerCall(name, rawInput) {
  const definition = toolDefinition(name);
  if (definition == null) return false;
  if (EAGER_BLOCKED_KINDS.has(definition.kind)) return false;
  return rawInput != null && typeof rawInput === "object";
}

/**
 * 只有主智能体能碰的工具。
 *
 * 目标是整个会话的状态，子智能体只负责一个被切出来的子任务，让它宣布
 * 「目标完成」或改预算等于让局部结论覆盖全局状态。这与 kimi 侧把目标工具
 * 限定为主 agent 是同一条约束。
 */
export const MAIN_AGENT_ONLY_TOOLS = new Set(["update_goal", "set_goal_budget"]);

/** 工具定义表：顺序同时决定发给模型的 schema 顺序。 */
export const TOOL_DEFINITIONS = [
  READ_FILE_DEFINITION,
  WRITE_FILE_DEFINITION,
  EDIT_FILE_DEFINITION,
  TERMINAL_DEFINITION,
  GREP_DEFINITION,
  GLOB_DEFINITION,
  SPAWN_AGENT_DEFINITION,
  UPDATE_TASKS_DEFINITION,
  UPDATE_GOAL_DEFINITION,
  SET_GOAL_BUDGET_DEFINITION,
  ENTER_PLAN_MODE_DEFINITION,
  REQUEST_USER_INPUT_DEFINITION,
  EXIT_PLAN_MODE_DEFINITION,
];

/**
 * 当前模式下发给模型的工具定义。
 *
 * 命令工具始终叫 terminal，沙箱开关只决定它是否多出 allowedDomains / sandbox
 * 两个参数，不会换成另一个名字。
 */
export function activeToolDefinitions(sandboxEnabled = false) {
  const command = terminalDefinition(sandboxEnabled);
  return TOOL_DEFINITIONS.map((definition) => (definition.name === "terminal" ? command : definition));
}

const BY_NAME = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

export function toolDefinition(name) {
  return BY_NAME.get(name) ?? null;
}

/** OpenAI 兼容的 tools 数组。 */
export function toolSchemas(sandboxEnabled = false) {
  return activeToolDefinitions(sandboxEnabled).map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));
}

/** 单个工具调用是否可与同批其它调用并行。 */
export function isConcurrencySafeCall(name, rawInput) {
  const definition = toolDefinition(name);
  if (definition == null) return false;
  if (!CONCURRENCY_SAFE_KINDS.has(definition.kind)) return false;
  return rawInput != null && typeof rawInput === "object";
}

/** 保持模型调用顺序，把连续的可并行调用合并成批。 */
export function partitionToolCalls(calls) {
  const batches = [];
  for (const call of calls) {
    const safe = isConcurrencySafeCall(call.name, call.rawInput);
    const last = batches.at(-1);
    if (safe && last?.parallel && last.calls.length < MAX_PARALLEL_TOOL_CALLS) {
      last.calls.push(call);
    } else {
      batches.push({ parallel: safe, calls: [call] });
    }
  }
  return batches;
}

/**
 * 构造执行器；spawn 工具依赖父循环上下文，缺少上下文时不装配。
 * 普通工具授权由 agent-loop 统一完成，写入执行器不可二次拦截已批准的路径。
 */
export function createToolRunners({
  cwd,
  startBash,
  tools = TOOL_DEFINITIONS.map((definition) => definition.name),
  subagent = null,
  readOnlyShell = false,
  onTasksUpdate = null,
  goal = null,
  sandboxManager = null,
  sandboxEnabled = false,
  plan = null,
  requestPlanEntry = null,
  requestUserInput = null,
  requestPlanReview = null,
}) {
  const available = new Set(tools);
  const runners = {};

  if (available.has("read_file")) runners.read_file = readTool(cwd);
  if (available.has("write_file")) runners.write_file = writeFileTool(cwd);
  if (available.has("edit_file")) runners.edit_file = editFileTool(cwd);
  if (available.has("terminal")) {
    // 三条分支共用同一份参数解析与输出格式，差别只在只读校验与是否套 sandbox-runtime。
    const selectTerminalTool = () => {
      if (readOnlyShell) return readOnlyHostTerminalTool(cwd, { startBash });
      if (sandboxEnabled) {
        return sandboxedTerminalTool(cwd, { startBash, ...(sandboxManager ? { sandboxManager } : {}) });
      }
      return hostTerminalTool(cwd, { startBash });
    };
    runners.terminal = selectTerminalTool();
  }
  if (available.has("grep")) runners.grep = grepTool(cwd);
  if (available.has("glob")) runners.glob = globTool(cwd);
  if (available.has("spawn_agent") && subagent != null) {
    // 目标工具不进子智能体的白名单：schemas 与 runners 都按这份名单装配，
    // 少了这一步子智能体会看到 update_goal 却调不动，变成「Unknown tool」。
    runners.spawn_agent = spawnAgentTool({
      ...subagent,
      parentTools: [...available].filter((name) => !MAIN_AGENT_ONLY_TOOLS.has(name)),
    });
  }
  if (available.has("update_tasks")) {
    runners.update_tasks = updateTasksTool({ onUpdate: onTasksUpdate });
  }
  // 没有目标状态就不装配：schemas 过滤掉没有 runner 的工具，于是无目标的
  // 会话根本看不到这两个工具，模型不会去调一个必然失败的东西。
  if (available.has("update_goal") && goal != null) {
    runners.update_goal = updateGoalTool({ goal });
  }
  if (available.has("set_goal_budget") && goal != null) {
    runners.set_goal_budget = setGoalBudgetTool({ goal });
  }
  if (available.has("enter_plan_mode")) runners.enter_plan_mode = enterPlanModeTool(requestPlanEntry);
  if (available.has("request_user_input")) runners.request_user_input = requestUserInputTool(requestUserInput);
  if (available.has("exit_plan_mode")) {
    runners.exit_plan_mode = exitPlanModeTool({ plan, requestReview: requestPlanReview });
  }

  return runners;
}

/** 解析模型给出的 arguments；非法 JSON 按原始字符串处理，供错误信息回显。 */
export function parseToolArguments(raw) {
  if (raw == null || raw === "") return { ok: true, value: {} };
  if (typeof raw === "object") return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, value: {}, error: error.message };
  }
}

export {
  editFileTool,
  editTool,
  hostTerminalTool,
  readOnlyHostTerminalTool,
  sandboxedTerminalTool,
  terminalDefinition,
  globTool,
  grepTool,
  readTool,
  setGoalBudgetTool,
  spawnAgentTool,
  updateGoalTool,
  updateTasksTool,
  writeFileTool,
};
export {
  resolveToolPath,
  stringifyResult,
  textContent,
  truncate,
} from "./shared.js";
