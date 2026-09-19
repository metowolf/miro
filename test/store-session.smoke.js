import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const tmpHome = mkdtempSync(path.join(os.tmpdir(), "miro-store-"));
process.env.HOME = tmpHome;
os.homedir = () => tmpHome;

const { useStore, setRecorder } = await import("../src/store.js");
const { SessionRecorder, loadSessionBlocks } = await import("../src/session-store.js");

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ✅ ${msg}`);
  else { console.log(`  ❌ ${msg}`); failures++; }
};

const store = useStore.getState();

console.log("1) connected receives sessionId and providerCapabilities");
store.setProviderId("demo");
store.connected({
  providerName: "Demo",
  sessionId: "sess-X",
  providerCapabilities: { loadSession: true },
  modelConfig: null,
  effortConfig: null,
  modes: null,
});
let s = useStore.getState();
assert(s.sessionId === "sess-X", "sessionId is stored");
assert(s.providerCapabilities?.loadSession === true, "providerCapabilities.loadSession is stored");
assert(s.status === "ready", "the status becomes ready");

console.log("2) recorder persists: pushed prose blocks land in the session file");
const rec = new SessionRecorder({ sessionId: "sess-X", providerId: "demo" });
setRecorder(rec);
useStore.getState().push("user", "你好");
useStore.getState().push("assistant", "你好，有什么可以帮你？");
const loaded = loadSessionBlocks("sess-X");
assert(loaded != null && loaded.blocks.length === 2, "both pushes are persisted (=2)");
assert(loaded.blocks[0].role === "user" && loaded.blocks[0].text === "你好", "the first block content is correct");

console.log("3) hydrate replays locally without re-persisting");
setRecorder(null);
useStore.getState().hydrate([
  { role: "user", text: "历史问题" },
  { role: "assistant", text: "历史回答" },
  { role: "banner", text: "" },
]);
s = useStore.getState();
const userBlocks = s.blocks.filter((b) => b.role === "user");
assert(userBlocks.some((b) => b.text === "历史问题"), "hydrated history blocks enter the in-memory transcript");
const after = loadSessionBlocks("sess-X");
assert(after.blocks.length === 2, "hydrate did not write the history back to disk (still 2)");

console.log("4) setSessionMeta");
useStore.getState().setSessionMeta({ title: "t", messages: 3 });
assert(useStore.getState().sessionMeta?.title === "t", "sessionMeta is set");

console.log(failures === 0 ? "\n✅ all checks passed" : `\n❌ ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
