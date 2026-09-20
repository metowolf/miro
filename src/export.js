/** 把 transcript 渲染成纯文本；App 只负责 IO。 */

import { BLACK_CIRCLE_PLAIN, TREE_LAST_PLAIN } from "./figures.js";
import { splitThinkingText } from "./thinking.js";

export const EXPORT_CLIPBOARD_MAX = 74_000;

const ROLE_MARKERS = {
  user: ">",
  assistant: BLACK_CIRCLE_PLAIN,
  system: "✻",
  thought: "∴",
  error: "✗",
  stderr: "⚠",
};

function renderMarkedBlock(block) {
  if (!block || block.role === "banner") return [];
  if (block.role === "thought") {
    if (block.thought?.displayMode === "hidden") return [];
    const detailsMissing = block.thought?.hasContent && !block.thought?.text;
    const summary = `${String(block.text ?? "")}${detailsMissing ? " · details not retained" : ""}`;
    const lines = [`${ROLE_MARKERS.thought} ${summary}`];
    if (block.thought?.displayMode === "full" && block.thought.text) {
      const body = splitThinkingText(block.thought.text).body;
      if (body) lines.push(...body.split("\n").map((line) => `  ${line}`));
    }
    return lines;
  }
  if (block.role === "plan" || block.role === "proposedPlan" || block.role === "bashCard") {
    return String(block.text ?? "").split("\n");
  }
  if (block.role === "tool") {
    const lines = [`${BLACK_CIRCLE_PLAIN} ${String(block.text ?? "")}`];
    if (block.tool?.hint) lines.push(`  ${TREE_LAST_PLAIN} ${block.tool.hint}`);
    const diff = block.tool?.diff;
    if (diff) {
      const path = diff.path ? ` ${diff.path}` : "";
      lines.push(`    diff${path} (+${diff.additions ?? 0} -${diff.deletions ?? 0})`);
      for (const hunk of diff.hunks ?? []) {
        lines.push(
          `    @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
        );
        for (const line of hunk.lines ?? []) lines.push(`    ${line}`);
      }
    }
    for (const line of block.tool?.preview?.lines ?? []) lines.push(`    ${line}`);
    return lines;
  }

  const marker = ROLE_MARKERS[block.role];
  const text = String(block.text ?? "");
  if (!marker) return text.split("\n");
  const [first, ...rest] = text.split("\n");
  return [`${marker} ${first}`, ...rest.map((line) => `  ${line}`)];
}

export function renderTranscript(blocks = [], pending = null) {
  const entries = [...(blocks ?? [])];
  if (pending?.text) entries.push(pending);
  const rendered = [];
  for (const block of entries) {
    if (block?.role === "banner") continue;
    const lines = renderMarkedBlock(block);
    if (lines.length === 0) continue;
    if (rendered.length > 0 && (block.head || block.gap)) rendered.push("");
    rendered.push(...lines);
  }
  return rendered.join("\n");
}

export function extractFirstPrompt(blocks = []) {
  const block = (blocks ?? []).find((item) => item?.role === "user");
  if (!block) return "";
  const firstLine = String(block.text ?? "").split("\n")[0];
  return firstLine.length > 50 ? `${firstLine.slice(0, 49)}…` : firstLine;
}

export function sanitizeFilename(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function buildDefaultFilename(blocks = [], date = new Date()) {
  const timestamp = formatExportTimestamp(date);
  const prompt = sanitizeFilename(extractFirstPrompt(blocks));
  return `${prompt ? `${timestamp}-${prompt}` : `conversation-${timestamp}`}.txt`;
}

export function ensureTxtExtension(name) {
  const value = String(name ?? "");
  return value.endsWith(".txt") ? value : `${value.replace(/\.[^.]+$/, "")}.txt`;
}

export function osc52Copy(text) {
  const value = String(text ?? "");
  if (value.length > EXPORT_CLIPBOARD_MAX) return null;
  return `\u001b]52;c;${Buffer.from(value).toString("base64")}\u0007`;
}
