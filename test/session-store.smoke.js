import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const tmpHome = mkdtempSync(path.join(os.tmpdir(), "miro-home-"));
process.env.HOME = tmpHome;
os.homedir = () => tmpHome;

const { SessionRecorder, listSessions, loadSessionBlocks, latestSessionId } = await import(
  "../src/session-store.js"
);

const cwd = process.cwd();
let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ✅ ${msg}`);
  else {
    console.log(`  ❌ ${msg}`);
    failures++;
  }
};

console.log("1) an empty project has no sessions");
assert(listSessions(cwd).length === 0, "listSessions starts empty");
assert(latestSessionId(cwd) === null, "latestSessionId starts as null");

console.log("2) record one session");
const rec = new SessionRecorder({ sessionId: "sess-A", providerId: "demo", model: "gpt-x" });
rec.recordBlock({ role: "user", text: "第一条：帮我算 1+1" });
rec.recordBlock({ role: "assistant", text: "等于 2。" });
rec.recordBlock({ role: "tool", text: "Read(a.js)", tool: { label: {} } });
rec.recordBlock({
  role: "thought",
  text: "Thought: 检查状态 · 2s",
  thought: {
    durationMs: 2000,
    hasContent: true,
    title: "检查状态",
    displayMode: "compact",
    text: "不应写入可见会话",
  },
});
rec.recordBlock({ role: "banner", text: "" });

const list = listSessions(cwd);
assert(list.length === 1, "listSessions returns one session after the write");
assert(list[0].sessionId === "sess-A", "sessionId is correct");
assert(list[0].title === "第一条：帮我算 1+1", "the title comes from the first user message");
assert(list[0].messages === 2, "messages counts user/assistant only (=2)");
assert(latestSessionId(cwd) === "sess-A", "latestSessionId returns the most recent session");

console.log("3) load session blocks for local replay");
const loaded = loadSessionBlocks("sess-A", cwd);
assert(loaded != null, "loadSessionBlocks returns a non-null result");
assert(loaded.blocks.length === 4, "replayed blocks contain user/assistant/tool/thought (banner filtered, =4)");
assert(loaded.blocks[0].text.includes("1+1"), "the first block content is correct");
assert(loaded.meta.model === "gpt-x", "meta.model is correct");
const thought = loaded.blocks.find((block) => block.role === "thought");
assert(thought?.thought?.hasContent === true, "the thinking summary keeps hasContent");
assert(thought?.thought?.title === "检查状态", "the thinking summary keeps the semantic title");
assert(thought?.thought?.displayMode === "compact", "the thinking summary keeps the display mode");
assert(thought?.thought?.durationMs === 2000, "the thinking summary keeps the duration");
assert(thought?.thought?.text == null, "the thinking body is not written to the visible session");

console.log("4) append and load the last valid ui_state v1");
const firstUiState = {
  composer: {
    value: "draft [Pasted text #2 +1 lines]",
    cursor: 5,
    pastes: new Map([[2, "secret\nbody"]]),
    nextPasteId: 3,
    ignored: true,
  },
  queuedInputs: [{ text: "queued body", display: "queued preview", ignored: true }],
  ignored: true,
};
rec.recordUiState(firstUiState);
const normalizedFirstState = loadSessionBlocks("sess-A", cwd).uiState;
assert(
  JSON.stringify(normalizedFirstState) === JSON.stringify({
    composer: {
      value: "draft [Pasted text #2 +1 lines]",
      cursor: 5,
      pastes: [[2, "secret\nbody"]],
      nextPasteId: 3,
    },
    queuedInputs: [{ text: "queued body", display: "queued preview" }],
  }),
  "composer snapshot and queuedInputs keep valid fields only"
);
const afterFirstState = readFileSync(rec.file, "utf8");
rec.recordUiState({ composer: { value: "bad" }, queuedInputs: [] });
assert(readFileSync(rec.file, "utf8") === afterFirstState, "an invalid ui_state appends no record");
rec.recordUiState({
  composer: { value: "最终草稿", cursor: 2, pastes: [], nextPasteId: 1 },
  queuedInputs: [{ text: "first", display: null }, { text: "second", display: "shown" }],
});
appendFileSync(
  rec.file,
  `${JSON.stringify({
    type: "ui_state",
    version: 2,
    state: {
      composer: { value: "unknown", cursor: 0, pastes: [], nextPasteId: 1 },
      queuedInputs: [],
    },
  })}\n`,
  "utf8"
);
appendFileSync(
  rec.file,
  `${JSON.stringify({
    type: "ui_state",
    version: 1,
    state: {
      composer: { value: "invalid", cursor: 99, pastes: [], nextPasteId: 1 },
      queuedInputs: [],
    },
  })}\n{bad json\n`,
  "utf8"
);
const withUiState = loadSessionBlocks("sess-A", cwd);
assert(withUiState.uiState?.composer?.value === "最终草稿", "returns the last valid ui_state");
assert(withUiState.uiState?.composer?.cursor === 2, "composer cursor keeps its code point position");
assert(Array.isArray(withUiState.uiState?.composer?.pastes), "composer pastes are normalized to a JSON array");
assert(
  JSON.stringify(withUiState.uiState?.queuedInputs) === JSON.stringify([
    { text: "first", display: null },
    { text: "second", display: "shown" },
  ]),
  "queuedInputs is strictly normalized"
);
assert(withUiState.uiState?.ignored == null, "unknown ui_state fields are dropped");

console.log("5) continue the same session (resume and keep writing)");
const rec2 = new SessionRecorder({ sessionId: "sess-A", providerId: "demo" });
rec2.recordBlock({ role: "user", text: "再算 2+2" });
rec2.recordBlock({ role: "assistant", text: "等于 4。" });
const reloaded = loadSessionBlocks("sess-A", cwd);
assert(reloaded.blocks.length === 6, "6 blocks after continuing (append succeeded)");
assert(listSessions(cwd).length === 1, "continuing creates no new session file");
assert(reloaded.uiState?.composer?.value === "最终草稿", "continuing leaves the latest UI state intact");

console.log("6) a second session and ordering");
const recB = new SessionRecorder({ sessionId: "sess-B", providerId: "demo" });
recB.recordBlock({ role: "user", text: "另一个会话" });
const two = listSessions(cwd);
assert(two.length === 2, "there are now 2 sessions");
assert(two[0].updatedAt >= two[1].updatedAt, "sorted by most recently updated");

console.log("7) the same sessionId under two providers");
const recC = new SessionRecorder({ sessionId: "sess-A", providerId: "miro" });
recC.recordBlock({ role: "user", text: "miro 接管" });
assert(recC.file !== rec.file, "the two transcripts live in different provider directories");
assert(loadSessionBlocks("sess-A", cwd, "miro").blocks[0].text === "miro 接管", "reading with providerId returns the miro copy");
assert(loadSessionBlocks("sess-A", cwd, "demo").blocks.length === 6, "reading with providerId returns the demo copy");
const sharedRows = listSessions(cwd).filter((s) => s.sessionId === "sess-A");
assert(sharedRows.length === 2, "each provider of the same id gets its own row (no overwriting)");
assert(
  sharedRows.map((s) => s.providerId).sort().join(",") === "demo,miro",
  "each row carries its own providerId"
);

console.log("8) an empty session is not persisted until the first conversation block arrives");
const beforeDraft = listSessions(cwd).length;
const recD = new SessionRecorder({ sessionId: "sess-draft", providerId: "demo", model: "gpt-x" });
recD.recordUiState({
  composer: { value: "半截草稿", cursor: 4, pastes: [], nextPasteId: 1 },
  queuedInputs: [],
});
recD.recordModel("gpt-y");
recD.recordBlock({ role: "system", text: "provider banner" });
assert(!existsSync(recD.file), "no session file exists while there are no messages");
assert(listSessions(cwd).length === beforeDraft, "an empty session is not listed");
assert(loadSessionBlocks("sess-draft", cwd) === null, "an empty session has no history to load");
recD.recordBlock({ role: "user", text: "草稿转正" });
assert(existsSync(recD.file), "the first conversation block creates the session file");
const draftSession = loadSessionBlocks("sess-draft", cwd);
assert(draftSession?.blocks.length === 2, "the buffered system and user blocks are both backfilled (=2)");
assert(draftSession?.uiState?.composer?.value === "半截草稿", "the buffered draft ui_state is readable after the backfill");
assert(listSessions(cwd).length === beforeDraft + 1, "it reappears in the list only once it has content");

console.log(failures === 0 ? "\n✅ all checks passed" : `\n❌ ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
