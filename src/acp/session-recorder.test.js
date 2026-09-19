import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finished } from "node:stream/promises";

import {
  AcpSessionRecorder,
  createRecordingTransform,
  projectDirectoryName,
  sessionLogPath,
} from "./session-recorder.js";

test("buffers handshake messages and stores one JSONL file per session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const recorder = new AcpSessionRecorder({
    cwd: "/work/example",
    root,
    now: () => `time-${tick++}`,
  });

  recorder.record("client", { jsonrpc: "2.0", id: 1, method: "initialize" });
  recorder.record("agent", { jsonrpc: "2.0", id: 1, result: {} });
  await recorder.start("session/one");
  recorder.record("client", { jsonrpc: "2.0", method: "session/prompt" });
  await recorder.close();

  const file = sessionLogPath("/work/example", "session/one", root);
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(path.basename(file), "session%2Fone.jsonl");
  assert.equal(path.relative(root, file), path.join("-work-example", "acp", "raw", "session%2Fone.jsonl"));
  assert.deepEqual(rows.map((row) => row.sequence), [0, 1, 2]);
  assert.deepEqual(rows.map((row) => row.direction), ["client", "agent", "client"]);
  assert.equal(rows[2].message.method, "session/prompt");

  const continued = new AcpSessionRecorder({ cwd: "/work/example", root });
  continued.record("client", { jsonrpc: "2.0", method: "session/load" });
  await continued.start("session/one");
  await continued.close();
  const continuedRows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(continuedRows.map((row) => row.sequence), [0, 1, 2, 3]);
});

test("recording transform handles chunk boundaries and preserves malformed lines", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({ cwd: "/work/example", root });
  const transform = createRecordingTransform(recorder, "agent");
  transform.resume();
  const unicodeMessage = Buffer.from('{"jsonrpc":"2.0","text":"你好"}\n');
  const split = unicodeMessage.indexOf(Buffer.from("你")) + 1;
  transform.write(unicodeMessage.subarray(0, split));
  transform.write(unicodeMessage.subarray(split));
  transform.write("not-json");
  transform.end();
  await finished(transform);
  await recorder.start("abc");
  await recorder.close();

  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows[0].message.text, "你好");
  assert.deepEqual(rows[1].message, { raw: "not-json" });
});

test("merges consecutive ACP message chunks into one JSONL record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({ cwd: "/work/example", root });
  const transform = createRecordingTransform(recorder, "agent");
  transform.resume();
  const update = (text, messageId = "msg-1") =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
      },
    });
  transform.write(`${update("你")}\n${update("好")}`);
  transform.write(`\n${update("!")}\n${update("另一个", "msg-2")}`);
  transform.end();
  await finished(transform);
  await recorder.start("abc");
  await recorder.close();

  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message.params.update.content.text, "你好!");
  assert.equal(rows[1].message.params.update.content.text, "另一个");
});

test("raw thinking is omitted by default", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({ cwd: "/work/example", root });
  recorder.record("agent", {
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "private detail" },
      },
    },
  });
  recorder.record("agent", { method: "session/update", params: { sessionId: "session-1" } });
  await recorder.start("abc");
  await recorder.close();

  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message.params.update, undefined);
});

test("merges consecutive ACP thought chunks when raw recording is enabled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({
    cwd: "/work/example",
    root,
    recordRawThinking: true,
  });
  const transform = createRecordingTransform(recorder, "agent");
  transform.resume();
  const update = (text, messageId) =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          ...(messageId == null ? {} : { messageId }),
          content: { type: "text", text },
        },
      },
    });
  transform.write(`${update("先")}\n${update("思", "thought-1")}\n`);
  transform.end(`${update("考", "thought-1")}\n`);
  await finished(transform);
  await recorder.start("abc");
  await recorder.close();

  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message.params.update.content.text, "先");
  assert.equal(rows[1].message.params.update.content.text, "思考");
  assert.equal(rows[1].message.params.update.messageId, "thought-1");
});

test("keeps only the latest consecutive in-progress tool snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({ cwd: "/work/example", root });
  const transform = createRecordingTransform(recorder, "agent");
  transform.resume();
  const update = (status, explanation) =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "write-1",
          status,
          rawInput: { explanation },
        },
      },
    });
  transform.end(`${update("in_progress", "writing")}\n${update("in_progress", "writing hello.js")}\n${update("completed", "done")}\n`);
  await finished(transform);
  await recorder.start("abc");
  await recorder.close();

  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message.params.update.rawInput.explanation, "writing hello.js");
  assert.equal(rows[1].message.params.update.status, "completed");
});

test("omits configOptions from buffered and active logs without mutating messages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({ cwd: "/work/example", root, now: () => "time" });
  const configOptions = [{ id: "model", currentValue: "example", options: [] }];
  const messages = [
    { jsonrpc: "2.0", id: 1, result: { sessionId: "abc", modes: { currentModeId: "agent" }, configOptions } },
    { jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "abc", update: { sessionUpdate: "config_option_update", configOptions },
    } },
    { jsonrpc: "2.0", id: 2, result: { configOptions } },
    { jsonrpc: "2.0", id: 3, result: { configOptions: null } },
    { jsonrpc: "2.0", id: 4, result: { configOptions: [] } },
    { jsonrpc: "2.0", id: 5, method: "session/set_config_option", params: {
      sessionId: "abc", configId: "model", value: "example",
    } },
    { jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "abc", update: { sessionUpdate: "tool_call", toolCallId: "read-1", rawInput: { configOptions } },
    } },
  ];
  const original = structuredClone(messages);
  const directions = messages.map((_, i) => i === 5 ? "client" : "agent");
  recorder.record(directions[0], messages[0]);
  await recorder.start("abc");
  for (let i = 1; i < messages.length; i += 1) recorder.record(directions[i], messages[i]);
  await recorder.close();

  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const expected = structuredClone(original);
  delete expected[0].result.configOptions;
  delete expected[1].params.update.configOptions;
  for (const i of [2, 3, 4]) delete expected[i].result.configOptions;
  assert.deepEqual(rows, expected.map((message, sequence) => ({
    timestamp: "time", direction: directions[sequence], message, sequence,
  })));
  assert.deepEqual(messages, original);
});

test("omitting configOptions from logs leaves ACP transport bytes intact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = new AcpSessionRecorder({ cwd: "/work/example", root });
  const transform = createRecordingTransform(recorder, "agent");
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk));
  const configOptions = [{ id: "model", currentValue: "example", options: [] }];
  const source = Buffer.from([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "abc", configOptions } }),
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "abc", update: { sessionUpdate: "config_option_update", configOptions },
    } }),
    "",
  ].join("\n"));
  transform.end(source);
  await finished(transform);
  await recorder.start("abc");
  await recorder.close();

  assert.deepEqual(Buffer.concat(chunks), source);
  const rows = (await readFile(sessionLogPath("/work/example", "abc", root), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].message.result, { sessionId: "abc" });
  assert.deepEqual(rows[1].message.params.update, { sessionUpdate: "config_option_update" });
});

test("project directory flattens non-alphanumeric characters to hyphens", () => {
  assert.equal(projectDirectoryName("/home/user/project"), "-home-user-project");
  assert.equal(projectDirectoryName("/root"), "-root");
  // 分隔符之外的标点也要折掉，否则 `.`/`_` 会原样留在目录名里。
  assert.equal(projectDirectoryName("/home/u/my_app.v2"), "-home-u-my-app-v2");
  // 长路径不截断、不掺哈希，保持可读。
  const long = `/data/workspace/${"x".repeat(120)}`;
  assert.equal(projectDirectoryName(long), `-data-workspace-${"x".repeat(120)}`);
});
