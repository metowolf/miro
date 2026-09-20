import { PLAN_MAX_BYTES } from "../plan-mode.js";
import { textContent } from "./shared.js";

export const ENTER_PLAN_MODE_DEFINITION = {
  name: "enter_plan_mode",
  kind: "plan",
  title: "Enter Plan Mode",
  description:
    "Ask the user to enter Plan Mode for explicit implementation planning or a genuinely ambiguous implementation. Do not use for routine multi-file work or pure research.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const REQUEST_USER_INPUT_DEFINITION = {
  name: "request_user_input",
  kind: "input",
  title: "Question",
  description:
    "Ask the user one to four material questions and wait for the answers. Inspect available context first; use this only when missing information or a preference would materially change the result. The UI provides Other automatically on questions without previews. Use multiSelect only for non-exclusive choices, and preview only for single-select options where Markdown helps compare alternatives.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            header: { type: "string", maxLength: 12 },
            question: { type: "string" },
            multiSelect: { type: "boolean", default: false },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                  preview: {
                    type: "string",
                    description: "Optional Markdown preview shown when this single-select option is focused.",
                  },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const EXIT_PLAN_MODE_DEFINITION = {
  name: "exit_plan_mode",
  kind: "plan",
  title: "Review Plan",
  description:
    "Submit the completed canonical plan file for user review. Call only in Plan Mode after writing a non-empty implementation-ready plan.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export function enterPlanModeTool(requestEntry) {
  return async () => {
    const approved = await requestEntry?.();
    if (!approved) return { output: "The user declined Plan Mode. Continue in Default Mode without repeating the request." };
    return {
      output: "Plan Mode was approved. End this turn; planning will continue in a fresh turn.",
      stopTurn: true,
      transition: { type: "plan_entered" },
    };
  };
}

function normalizedOption(option) {
  return {
    label: typeof option?.label === "string" ? option.label.trim() : "",
    description: typeof option?.description === "string" ? option.description.trim() : "",
    ...(typeof option?.preview === "string" && option.preview.trim()
      ? { preview: option.preview.trim() }
      : {}),
  };
}

function normalizedQuestions(input) {
  if (!Array.isArray(input?.questions) || input.questions.length < 1 || input.questions.length > 4) return null;
  const ids = new Set();
  const questions = [];
  for (const item of input.questions) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const header = typeof item?.header === "string" ? item.header.trim() : "";
    const question = typeof item?.question === "string" ? item.question.trim() : "";
    const multiSelect = item?.multiSelect === true;
    const rawOptions = Array.isArray(item?.options) ? item.options : [];
    if (!id || ids.has(id)) return null;
    if (!header || header.length > 12 || !question) return null;
    if (rawOptions.length < 2 || rawOptions.length > 4) return null;

    const options = rawOptions.map(normalizedOption);
    const labels = options.map((option) => option.label);
    if (options.some((option) => !option.label || !option.description)) return null;
    if (new Set(labels).size !== labels.length) return null;
    // preview 只在单选里有意义：多选没有「当前聚焦项」可供对照。
    if (multiSelect && options.some((option) => option.preview)) return null;

    ids.add(id);
    questions.push({ id, header, question, options, multiSelect });
  }
  return questions;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizedAnnotations(raw, allowed) {
  const annotations = {};
  if (!isPlainObject(raw)) return annotations;
  for (const [id, annotation] of Object.entries(raw)) {
    if (!allowed.has(id) || !isPlainObject(annotation)) continue;
    const preview = typeof annotation.preview === "string" ? annotation.preview.trim() : "";
    const notes = typeof annotation.notes === "string" ? annotation.notes.trim() : "";
    if (preview || notes) annotations[id] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) };
  }
  return annotations;
}

function normalizedUserInputResult(value, questions) {
  if (!isPlainObject(value)) return null;
  // 兼容最初的内部 handler：它直接返回 id → answer；新 UI 返回
  // { answers, annotations }，这样 preview 与备注能和答案一起回灌。
  const rawAnswers = isPlainObject(value.answers) ? value.answers : value;
  const allowed = new Set(questions.map((question) => question.id));
  const answers = Object.fromEntries(
    Object.entries(rawAnswers).filter(([id, answer]) => allowed.has(id) && typeof answer === "string" && answer.trim()),
  );
  const annotations = normalizedAnnotations(value.annotations, allowed);
  return { answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) };
}

export function requestUserInputTool(requestUserInput) {
  return async (input) => {
    const questions = normalizedQuestions(input);
    if (!questions) return { error: "request_user_input: questions must contain 1-4 valid questions with 2-4 unique options each; previews are single-select only" };
    const response = await requestUserInput?.(questions);
    if (response == null) return { output: "The user cancelled the questions. Continue using the best supported assumptions." };
    const result = normalizedUserInputResult(response, questions) ?? { answers: {} };
    const output = JSON.stringify(result, null, 2);
    return { output, content: textContent(output) };
  };
}

export function exitPlanModeTool({ plan, requestReview }) {
  return async () => {
    if (!plan?.path) return { error: "exit_plan_mode: Plan Mode has no canonical plan file" };
    let bytes;
    try {
      bytes = new Uint8Array(await Bun.file(plan.path).arrayBuffer());
    } catch (error) {
      return { error: `exit_plan_mode: cannot read ${plan.path}: ${error.message}` };
    }
    if (bytes.byteLength > PLAN_MAX_BYTES) return { error: `exit_plan_mode: plan exceeds ${PLAN_MAX_BYTES} bytes` };
    let markdown;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { error: "exit_plan_mode: plan must be valid UTF-8" };
    }
    if (!markdown.trim()) return { error: `exit_plan_mode: write the plan to ${plan.path} before submitting it` };

    const result = await requestReview?.({ plan: markdown, path: plan.path });
    switch (result?.action) {
      case "approve":
        return {
          output: "The user approved the frozen plan. A fresh implementation turn will start next.",
          stopTurn: true,
          transition: { type: "plan_approved", plan: markdown, path: plan.path },
        };
      case "revise": {
        const feedback = String(result.feedback ?? "").trim();
        return { output: feedback ? `The user requested revisions:\n\n${feedback}` : "The user requested revisions. Plan Mode remains active." };
      }
      case "reject":
        return {
          output: "The user rejected the plan and exited Plan Mode. Do not implement it.",
          stopTurn: true,
          transition: { type: "plan_rejected" },
        };
      default:
        return {
          output: "Plan review was dismissed. Plan Mode remains active.",
          stopTurn: true,
          transition: { type: "plan_review_dismissed" },
        };
    }
  };
}
