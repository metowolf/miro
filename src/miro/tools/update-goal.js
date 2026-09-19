/**
 * 目标的两个模型侧工具：update_goal（唯一的退出通道）与 set_goal_budget。
 *
 * 两者都不碰文件、不起子进程，所以不进审批流程——语义上同 update_tasks：
 * 它们改的是运行时状态，不是工作区。
 *
 * description 里的行为约束（3 轮 blocked 门槛、完成审计、「多数回合都不该
 * 调用本工具」）是这套机制真正起作用的部分，不是可有可无的说明文字。
 */

import { budgetLimitsFromInput, formatBudget, BUDGET_UNITS } from "../goal.js";
import { textContent } from "./shared.js";

/** 模型可写的状态：complete/blocked 是终态，active 用于显式恢复。 */
const WRITABLE_STATUSES = ["active", "complete", "blocked"];

export const UPDATE_GOAL_DEFINITION = {
  name: "update_goal",
  kind: "goal",
  title: "Update goal",
  description:
    "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal. " +
    "It does not request approval.\n\n" +
    "- `active` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\n" +
    "- `complete` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use `complete` merely because a budget is nearly exhausted or you want to stop.\n" +
    "- `blocked` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use `blocked` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call `blocked`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call `blocked` in the same turn instead of running more goal turns. Do not use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns.\n\n" +
    "Most active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling update_goal; the runtime will prompt you to continue in the next goal turn. " +
    "Call `complete` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call `complete` after only producing a plan, summary, first pass, or partial result. " +
    "Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: WRITABLE_STATUSES,
        description: "The new goal status: active, complete, or blocked.",
      },
      reason: {
        type: "string",
        description:
          "Short reason for the change, shown to the user. Required in spirit for `blocked`: say what is actually blocking progress.",
      },
    },
    required: ["status"],
  },
};

export const SET_GOAL_BUDGET_DEFINITION = {
  name: "set_goal_budget",
  kind: "goal",
  title: "Set goal budget",
  description:
    "Set a hard budget limit for the current goal. It does not request approval.\n\n" +
    'Use this only when the user clearly gives a runtime limit, such as "stop after 20 turns", ' +
    '"use no more than 500k tokens", or "finish within 30 minutes". ' +
    'Do not invent limits. Do not call this for vague wording such as "spend some time" or "try to be quick".\n\n' +
    'If the user gives a compound time, convert it to one supported unit first: "2 hours and 3 minutes" becomes value 123, unit "minutes".\n\n' +
    "A time budget must be at least 1 second. There is no upper duration limit. Turn and token budgets must be positive and are rounded to the nearest whole number (minimum 1). " +
    "When a budget is reached the goal is blocked rather than completed, and the user can resume it.",
  parameters: {
    type: "object",
    properties: {
      value: {
        type: "number",
        description: "The budget amount, a positive number.",
      },
      unit: {
        type: "string",
        enum: BUDGET_UNITS,
        description: "The unit for value.",
      },
    },
    required: ["value", "unit"],
  },
};

/** 落到 transcript 的一行状态摘要。 */
function describeGoal(snapshot) {
  if (snapshot == null) return "No current goal.";
  const bits = [`status ${snapshot.status}`, `${snapshot.turnsUsed} turns`, `${snapshot.tokensUsed} tokens`];
  if (snapshot.terminalReason) bits.push(snapshot.terminalReason);
  return bits.join(", ");
}

function toolOutput(output, extra = {}) {
  return { output, content: textContent(output), ...extra };
}

/**
 * update_goal 执行器。
 *
 * `goal` 是 createGoalState() 的实例，由 createToolRunners 注入而不是模块级
 * 单例：同一个进程里可以有多个会话，共享一份目标状态会让它们互相覆盖。
 *
 * 终态返回 stopTurn，让循环层在本轮内停下——目标已经结束，再让模型继续调
 * 工具只会产出与结论矛盾的动作。
 */
export function updateGoalTool({ goal } = {}) {
  return async (input) => {
    if (goal == null) return { error: "update_goal: goal mode is not available in this context" };

    const status = input?.status;
    if (!WRITABLE_STATUSES.includes(status)) {
      return {
        error: `update_goal: invalid status ${JSON.stringify(status ?? null)}; use one of ${WRITABLE_STATUSES.join(", ")}`,
      };
    }
    const reason = typeof input?.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim()
      : null;

    const current = goal.get();
    if (current == null) {
      // 目标可能在本轮进行中被用户取消：如实告知，而不是静默新建一个。
      return toolOutput("Goal not updated: no current goal.");
    }

    if (status === "active") {
      if (current.status === "active") {
        return toolOutput("Goal already active.");
      }
      if (current.status === "complete") {
        return toolOutput("Goal not resumed: the goal is already complete.");
      }
      const next = goal.resume();
      return toolOutput(`Goal resumed. ${describeGoal(next)}`);
    }

    if (current.status !== "active") {
      return toolOutput(`Goal not updated: the goal is ${current.status}, not active.`);
    }

    if (status === "complete") {
      const next = goal.markComplete(reason);
      const output = [
        "Goal marked complete.",
        describeGoal(next),
        "Write a brief completion summary for the user in your next message: what was achieved and how it was validated.",
      ].join(" ");
      return toolOutput(output, { stopTurn: true });
    }

    const next = goal.markBlocked(reason);
    const output = [
      "Goal marked blocked.",
      describeGoal(next),
      "Explain the blocker to the user in your next message: what is blocking progress and what you need to continue.",
    ].join(" ");
    return toolOutput(output, { stopTurn: true });
  };
}

/**
 * set_goal_budget 执行器。
 *
 * 设完就已经超预算是合法结局（例如「20 轮内完成」但已经跑了 25 轮）：此时
 * 立刻置 blocked 并 stopTurn，比让模型继续跑到下一次预算检查更诚实。
 */
export function setGoalBudgetTool({ goal } = {}) {
  return async (input) => {
    if (goal == null) return { error: "set_goal_budget: goal mode is not available in this context" };
    if (goal.get() == null) {
      return toolOutput("Goal budget not set: no current goal.");
    }

    const parsed = budgetLimitsFromInput(input);
    if (parsed.error) return { error: parsed.error };

    goal.setBudgetLimits(parsed.limits);
    const label = formatBudget(input.value, input.unit);
    const blocked = goal.blockIfOverBudget();
    if (blocked != null) {
      const output = `Goal budget set: ${label}. The goal has already reached this budget and stops now.`;
      return toolOutput(output, { stopTurn: true });
    }
    return toolOutput(`Goal budget set: ${label}.`);
  };
}
