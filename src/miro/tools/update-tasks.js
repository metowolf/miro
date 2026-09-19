import { textContent } from "./shared.js";

const TASK_STATUSES = ["pending", "in_progress", "completed"];

export const UPDATE_TASKS_DEFINITION = {
  name: "update_tasks",
  kind: "tasks",
  title: "Update tasks",
  description:
    "Update the in-turn task checklist. This does not request approval — " +
    "use it on long, multi-step work so you do not lose the goal after many tool rounds. " +
    "Send the full current list each time (replace, do not patch). At most one step can be in_progress.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "The full current task list, in order.",
        items: {
          type: "object",
          properties: {
            step: { type: "string", description: "What this step does." },
            status: {
              type: "string",
              enum: TASK_STATUSES,
              description: "pending, in_progress, or completed. At most one step may be in_progress.",
            },
          },
          required: ["step", "status"],
        },
      },
    },
    required: ["tasks"],
  },
};

/**
 * 归一化成 store.setPlan / ACP plan 事件认的 { content, status }。
 * 同时收 step（本工具 schema）和 content（ACP 同构），避免模型换个字段名就整表作废。
 */
export function normalizeTasks(input) {
  if (!Array.isArray(input)) {
    return { error: "update_tasks: missing required parameter 'tasks' (an array of {step, status})" };
  }
  const tasks = [];
  for (const [index, item] of input.entries()) {
    if (item == null || typeof item !== "object") {
      return { error: `update_tasks: tasks[${index}] must be an object with step and status` };
    }
    const raw = typeof item.step === "string" ? item.step : item.content;
    const step = typeof raw === "string" ? raw.trim() : "";
    if (!step) return { error: `update_tasks: tasks[${index}] is missing a non-empty step` };
    const status = TASK_STATUSES.includes(item.status) ? item.status : "pending";
    tasks.push({ content: step, status });
  }
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  if (inProgress > 1) {
    return { error: "update_tasks: at most one step can be in_progress at a time" };
  }
  return { tasks };
}

/**
 * 回合内进度清单独立于权限模式和工具审批。
 */
export function updateTasksTool({ onUpdate } = {}) {
  return async (input) => {
    const parsed = normalizeTasks(input?.tasks);
    if (parsed.error) return { error: parsed.error };
    if (typeof onUpdate === "function") onUpdate(parsed.tasks);
    if (parsed.tasks.length === 0) {
      const output = "Task list cleared.";
      return { output, content: textContent(output) };
    }
    const lines = parsed.tasks.map((task) => `- [${task.status}] ${task.content}`);
    const noun = parsed.tasks.length === 1 ? "task" : "tasks";
    const output = `Updated ${parsed.tasks.length} ${noun}.\n${lines.join("\n")}`;
    return { output, content: textContent(output) };
  };
}
