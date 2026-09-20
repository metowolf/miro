import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const INTERACTION_MODES = ["default", "plan"];
export const PLAN_MAX_BYTES = 256 * 1024;

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function projectName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

export function planFilePath({ cwd, sessionId, planId, home = os.homedir() }) {
  return path.join(
    home,
    ".miro",
    "sessions",
    projectName(cwd),
    "miro",
    "plans",
    safeName(sessionId),
    `${safeName(planId)}.md`,
  );
}

export async function createPlanFile(options) {
  const file = planFilePath(options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "", { encoding: "utf8", flag: "wx" });
  return file;
}

export function normalizePlanModeState(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.mode !== "default" && value.mode !== "plan") return null;
  if (value.mode === "default") return { mode: "default", planId: null, planPath: null };
  if (typeof value.planId !== "string" || value.planId.length === 0) return null;
  if (typeof value.planPath !== "string" || value.planPath.length === 0) return null;
  return { mode: "plan", planId: value.planId, planPath: value.planPath };
}

export function planModePrompt(planPath, interactive = true) {
  const lines = [
    "## Plan Mode",
    "Plan Mode is active. Investigate and produce an implementation-ready plan; do not implement it.",
    "Use the available tools as needed to investigate. Plan Mode does not impose a read-only runtime restriction, but your objective is still to design the change rather than implement it.",
    `Canonical plan file: ${planPath}`,
    "Resolve repository facts by inspection before asking the user. Use request_user_input only for material preferences or trade-offs that cannot be discovered.",
    interactive
      ? "Work through: understand the request, inspect the current implementation, settle the design, re-read critical files, write the final plan, then call exit_plan_mode."
      : "Work through: understand the request, inspect the current implementation, settle the design, re-read critical files, and write the final plan.",
    "The plan must state the goal, important implementation/interface changes, tests and acceptance criteria, and explicit assumptions. Prefer one recommended approach.",
    interactive
      ? "Do not ask for plan approval in prose; exit_plan_mode presents the plan for review."
      : "This is a non-interactive Plan run. After writing the plan file, return the complete plan as your visible final response. Do not implement it or ask for approval.",
  ];
  return lines.join("\n");
}

export const PLAN_ENTRY_GUIDANCE =
    "When the user explicitly asks for an implementation plan, or a non-trivial implementation has genuine architectural ambiguity where approval would prevent substantial rework, call enter_plan_mode before implementing the change. Do not enter merely because several files may change.";

export function approvedPlanPrompt(markdown) {
  return [
    "Implement the approved plan below.",
    "Treat this frozen snapshot as authoritative. Do not redesign it or replace it by rereading the mutable plan file.",
    "If a material premise is false or implementation is fundamentally riskier than planned, stop and report the mismatch instead of making a new design decision.",
    "",
    "<approved_plan>",
    markdown,
    "</approved_plan>",
  ].join("\n");
}
