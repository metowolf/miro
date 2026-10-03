import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const MAX_INPUT_HISTORY = 100;
const MAX_RECORD_BYTES = 256 * 1024;
export const INPUT_HISTORY_FILE = path.join(os.homedir(), ".miro", "history.jsonl");

function clonePastes(pastes) {
  return new Map(pastes instanceof Map ? pastes : pastes ?? []);
}

export function cloneInputSnapshot(snapshot, cursor = snapshot.cursor) {
  const value = String(snapshot.value ?? "");
  const chars = [...value];
  const pastes = clonePastes(snapshot.pastes);
  const highestPasteId = Math.max(0, ...pastes.keys());
  const requestedNextPasteId = Number.isSafeInteger(snapshot.nextPasteId) && snapshot.nextPasteId > 0
    ? snapshot.nextPasteId
    : 1;
  return {
    value,
    cursor: Math.max(0, Math.min(chars.length, Number.isInteger(cursor) ? cursor : chars.length)),
    pastes,
    nextPasteId: Math.max(highestPasteId + 1, requestedNextPasteId),
  };
}

function snapshotsEqual(left, right) {
  if (left.value !== right.value || left.pastes.size !== right.pastes.size) return false;
  for (const [id, text] of left.pastes) {
    if (right.pastes.get(id) !== text) return false;
  }
  return true;
}

/** 输入历史状态机。entries 按旧到新排列。 */
export class InputHistory {
  constructor(entries = [], { maxEntries = MAX_INPUT_HISTORY, onRecord = null } = {}) {
    this.maxEntries = maxEntries;
    this.onRecord = onRecord;
    this.entries = entries.slice(-maxEntries).map((entry) => cloneInputSnapshot(entry));
    this.index = null;
    this.draft = null;
    this.lastRecalled = null;
  }

  record(snapshot) {
    const entry = cloneInputSnapshot(snapshot);
    this.resetNavigation();
    if (!entry.value.trim()) return false;
    const latest = this.entries[this.entries.length - 1];
    if (latest && snapshotsEqual(latest, entry)) return false;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    try {
      this.onRecord?.(cloneInputSnapshot(entry));
    } catch {
      // 历史持久化失败不能影响输入提交。
    }
    return true;
  }

  previous(active) {
    if (this.entries.length === 0) return null;
    if (this.index == null) {
      this.draft = cloneInputSnapshot(active);
      this.index = this.entries.length - 1;
    } else {
      this.index = Math.max(0, this.index - 1);
    }
    const recalled = cloneInputSnapshot(this.entries[this.index], 0);
    this.lastRecalled = recalled.value;
    return recalled;
  }

  next() {
    if (this.index == null) return null;
    if (this.index < this.entries.length - 1) {
      this.index += 1;
      const entry = this.entries[this.index];
      const recalled = cloneInputSnapshot(entry, [...entry.value].length);
      this.lastRecalled = recalled.value;
      return recalled;
    }
    const draft = this.draft ? cloneInputSnapshot(this.draft) : cloneInputSnapshot({ value: "" });
    this.resetNavigation();
    return draft;
  }

  /**
   * 是否仍停留在刚回填的历史条目上。
   * 判据：文本需与上次回填的历史完全一致，且光标停在行首或行尾（previous 落在
   * 行首、next 落在行尾）。用户一旦改动文本或把光标移到中间，判定自动失效，
   * 无需在各编辑路径上手动重置。
   */
  isBrowsing(value, cursor) {
    if (this.lastRecalled == null || value !== this.lastRecalled) return false;
    return cursor === 0 || cursor === [...value].length;
  }

  resetNavigation() {
    this.index = null;
    this.draft = null;
    this.lastRecalled = null;
  }
}

function deserializeEntry(line, cwd) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record?.version !== 1 || record.cwd !== cwd || typeof record.value !== "string") return null;
  if (!Array.isArray(record.pastes)) return null;
  const pastes = new Map();
  for (const item of record.pastes) {
    if (
      !Array.isArray(item) ||
      !Number.isSafeInteger(item[0]) ||
      item[0] <= 0 ||
      typeof item[1] !== "string"
    ) return null;
    pastes.set(item[0], item[1]);
  }
  return cloneInputSnapshot({ value: record.value, pastes });
}

export function loadInputHistory({ cwd = process.cwd(), file = INPUT_HISTORY_FILE } = {}) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const entry = deserializeEntry(line, cwd);
    if (entry) entries.push(entry);
  }
  return entries.slice(-MAX_INPUT_HISTORY);
}

export function appendInputHistory(snapshot, { cwd = process.cwd(), file = INPUT_HISTORY_FILE } = {}) {
  const entry = cloneInputSnapshot(snapshot);
  const line = `${JSON.stringify({
    version: 1,
    at: Date.now(),
    cwd,
    value: entry.value,
    pastes: [...entry.pastes],
  })}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return false;
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

const histories = new Map();

export function getInputHistory(cwd = process.cwd()) {
  if (!histories.has(cwd)) {
    histories.set(
      cwd,
      new InputHistory(loadInputHistory({ cwd }), {
        onRecord: (entry) => appendInputHistory(entry, { cwd }),
      })
    );
  }
  return histories.get(cwd);
}
