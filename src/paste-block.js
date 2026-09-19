/**
 * 大段粘贴折叠为占位块。Composer 是单行输入，任何换行都会丢失，
 * 因此超过阈值时只插入 `[Pasted text #N]`，原文存 registry，提交前再展开。
 */

import { stringWidth } from "./markdown-width.js";

export const PASTE_MAX_CHARS = 800;
export const PASTE_MAX_LINES = 0;

const MARKER_SOURCE = String.raw`\[Pasted text #(\d+)(?: \+(\d+) lines| (\d+) chars)?\]`;

export const PASTE_MARKER_REGEX = new RegExp(MARKER_SOURCE, "g");
export const PASTE_MARKER_SINGLE = new RegExp(`^${MARKER_SOURCE}$`);

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

/** 去 ANSI、统一换行、展开 Tab、丢掉控制字符。 */
export function normalizePastedText(text) {
  const cleaned = String(text ?? "")
    .replace(ANSI_REGEX, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ");
  return [...cleaned]
    .filter((ch) => ch === "\n" || (ch.codePointAt(0) >= 32 && ch !== "\u007F"))
    .join("");
}

/** 数换行符个数（"a\\nb" 记 1）。 */
export function countPastedLines(text) {
  return (String(text ?? "").match(/\n/g) ?? []).length;
}

export function shouldCollapsePaste(
  text,
  { maxLines = PASTE_MAX_LINES, maxChars = PASTE_MAX_CHARS } = {}
) {
  const value = String(text ?? "");
  return countPastedLines(value) > maxLines || value.length > maxChars;
}

export function formatPasteMarker(id, text) {
  const lines = countPastedLines(text);
  if (lines > 0) return `[Pasted text #${id} +${lines} lines]`;
  return `[Pasted text #${id} ${String(text ?? "").length} chars]`;
}

function toPasteMap(pastes) {
  if (pastes instanceof Map) return pastes;
  const map = new Map();
  for (const [id, text] of Object.entries(pastes ?? {})) map.set(Number(id), text);
  return map;
}

/** 只认 registry 里已有的标记；返回 code-unit 与码点两套索引。 */
export function findPasteMarkers(text, pastes) {
  const source = String(text ?? "");
  const registry = toPasteMap(pastes);
  if (registry.size === 0 || !source.includes("[Pasted text #")) return [];

  const raw = [];
  for (const match of source.matchAll(PASTE_MARKER_REGEX)) {
    const id = Number(match[1]);
    if (!registry.has(id)) continue;
    raw.push({ id, text: match[0], index: match.index, length: match[0].length });
  }
  if (raw.length === 0) return [];

  const points = [...source];
  const unitToPoint = new Map();
  let unit = 0;
  points.forEach((ch, pointIndex) => {
    unitToPoint.set(unit, pointIndex);
    unit += ch.length;
  });
  unitToPoint.set(unit, points.length);

  return raw.map((marker) => ({
    ...marker,
    start: unitToPoint.get(marker.index),
    end: unitToPoint.get(marker.index + marker.length),
  }));
}

/** 从后往前展开标记，避免原文里的同类字符串被二次替换。 */
export function expandPasteMarkers(text, pastes) {
  const source = String(text ?? "");
  const registry = toPasteMap(pastes);
  const markers = findPasteMarkers(source, registry);
  let result = source;
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    result =
      result.slice(0, marker.index) +
      registry.get(marker.id) +
      result.slice(marker.index + marker.length);
  }
  return result;
}

/** 回收文本中已不存在的 registry 项。 */
export function pruneOrphanPastes(text, pastes) {
  const registry = toPasteMap(pastes);
  if (registry.size === 0) return registry;
  const alive = new Set(findPasteMarkers(text, registry).map((marker) => marker.id));
  if (alive.size === registry.size) return registry;
  const next = new Map();
  for (const [id, content] of registry) if (alive.has(id)) next.set(id, content);
  return next;
}

/** 够大则折叠为标记，否则内联。 */
export function insertPastedText({ chars, cursor, pastes, nextId, text, options }) {
  const clean = normalizePastedText(text);
  if (!clean) return null;
  const registry = toPasteMap(pastes);
  const at = Math.max(0, Math.min(chars.length, cursor));

  const collapsed = shouldCollapsePaste(clean, options);
  const inserted = collapsed ? [...formatPasteMarker(nextId, clean)] : [...clean];
  const nextPastes = collapsed ? new Map(registry).set(nextId, clean) : registry;

  return {
    chars: [...chars.slice(0, at), ...inserted, ...chars.slice(at)],
    cursor: at + inserted.length,
    pastes: nextPastes,
    id: collapsed ? nextId : null,
  };
}

/** 左右移动时把标记当作一个原子单位。 */
export function stepCursor(chars, cursor, delta, pastes) {
  const target = cursor + delta;
  const clamped = Math.max(0, Math.min(chars.length, target));
  const marker = findPasteMarkers(chars.join(""), pastes).find(
    (item) => clamped > item.start && clamped < item.end
  );
  if (!marker) return clamped;
  return delta < 0 ? marker.start : marker.end;
}

/** 退格：紧跟标记时整块删除。 */
export function deleteBeforeCursor(chars, cursor, pastes) {
  if (cursor <= 0) return null;
  const marker = findPasteMarkers(chars.join(""), pastes).find((item) => item.end === cursor);
  const from = marker ? marker.start : cursor - 1;
  return { chars: [...chars.slice(0, from), ...chars.slice(cursor)], cursor: from };
}

/** Delete：光标在标记起点时整块删除。 */
export function deleteAfterCursor(chars, cursor, pastes) {
  if (cursor >= chars.length) return null;
  const marker = findPasteMarkers(chars.join(""), pastes).find((item) => item.start === cursor);
  const to = marker ? marker.end : cursor + 1;
  return { chars: [...chars.slice(0, cursor), ...chars.slice(to)], cursor };
}

/** 切成渲染片段：标记整体高亮，光标落在标记内时整块反显。 */
export function segmentInput(chars, cursor, pastes) {
  const clampedCursor = Math.max(0, Math.min(chars.length, cursor));
  const markers = findPasteMarkers(chars.join(""), pastes);
  const cursorMarker = markers.find(
    (item) => clampedCursor >= item.start && clampedCursor < item.end
  );
  const cursorStart = cursorMarker ? cursorMarker.start : clampedCursor;
  const cursorEnd = cursorMarker ? cursorMarker.end : clampedCursor + 1;

  const bounds = new Set([0, chars.length, cursorStart, Math.min(cursorEnd, chars.length)]);
  for (const marker of markers) {
    bounds.add(marker.start);
    bounds.add(marker.end);
  }
  const points = [...bounds].filter((n) => n >= 0 && n <= chars.length).sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    segments.push({
      text: chars.slice(from, to).join(""),
      marker: markers.some((marker) => from >= marker.start && to <= marker.end),
      cursor: from >= cursorStart && to <= cursorEnd,
    });
  }
  if (cursorStart >= chars.length) segments.push({ text: " ", marker: false, cursor: true });
  return segments;
}

/**
 * 光标在渲染片段里的列偏移，直接喂给真实终端光标的 x。
 *
 * 不能用字符串长度算：CJK 与 emoji 占两格，用 `.length` 会让输入法候选框
 * 每打一个中文就往右漂一格。也不能另写一套「光标是否落在折叠块里」的判定，
 * 那会与 segmentInput 分叉——落在块内时光标画在整块之后，与反显高亮一致
 * （这个块是整体删除的，光标停在它后面才与实际语义相符）。
 */
export function cursorColumn(segments) {
  return stringWidth(cursorText(segments));
}

/** 返回光标前实际显示的文本；折行定位需要保留每个字素，而不只是总列数。 */
export function cursorText(segments) {
  let text = "";
  for (const segment of segments) {
    if (segment.cursor) {
      if (segment.marker) text += segment.text;
      break;
    }
    text += segment.text;
  }
  return text;
}
