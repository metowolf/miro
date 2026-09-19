import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { readPrompt, runHeadless } from "./headless.js";

function capture() {
  let value = "";
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { value += chunk; callback(); } }),
    value: () => value,
  };
}

function config(id, category, currentValue, options) {
  return { id, category, type: "select", currentValue, options };
}

class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bin = options.bin;
    this.modelConfig = config("model", "model", "m1", [
      { value: "m1", name: "Model One" },
      { value: "m2", name: "Model Two" },
    ]);
    this.effortConfig = config("effort", "thought_level", "low", [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ]);
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    FakeClient.instances.push(this);
  }

  async run() {
    queueMicrotask(() => this.emit("ready", {
      sessionId: this.options.continueSessionId ?? "session-1",
      resumed: this.options.continueSessionId != null,
    }));
    await this.closedPromise;
    return null;
  }

  async setModel(value) {
    this.modelConfig.currentValue = value;
    return value;
  }

  async setEffort(value) {
    this.effortConfig.currentValue = value;
    return value;
  }

  async enableThinking() {
    this.thinkingEnabled = true;
  }

  async prompt(prompt) {
    this.sentPrompt = prompt;
    this.emit("chunk", "hello ");
    this.emit("chunk", "world");
    if (FakeClient.permission) {
      await this.onPermissionRequest({
        options: [{ kind: "reject_once", optionId: "reject" }],
        toolCall: { toolCallId: "tool-1", title: "Run command", rawInput: { command: "rm example" } },
      });
    }
    return { stopReason: FakeClient.stopReason };
  }

  cancel() {}
  close() { this.resolveClosed(); }
}
FakeClient.instances = [];
FakeClient.stopReason = "end_turn";
FakeClient.permission = false;

function dependencies(stdout, stderr, records) {
  return {
    Client: FakeClient,
    stdout,
    stderr,
    settings: {},
    providers: [{ id: "fake", name: "Fake", bin: "fake-acp", args: [] }],
    loadContext: () => ({ contextText: "rules" }),
    createRecorder: (meta) => ({
      recordBlock: (block) => records.push({ meta, block }),
      recordModel: (model) => records.push({ meta, model }),
    }),
    signalTarget: new EventEmitter(),
  };
}

test.beforeEach(() => {
  FakeClient.instances = [];
  FakeClient.stopReason = "end_turn";
  FakeClient.permission = false;
});

test("text mode prints the final answer and records a resumable transcript", async () => {
  const out = capture();
  const err = capture();
  const records = [];
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "text",
    continueSessionId: null,
    acp: "fake",
    model: "Model Two",
    effort: "high",
  }, dependencies(out.stream, err.stream, records));

  assert.equal(code, 0);
  assert.equal(out.value(), "hello world\n");
  assert.equal(err.value(), "");
  assert.equal(FakeClient.instances[0].sentPrompt, "question");
  assert.equal(FakeClient.instances[0].modelConfig.currentValue, "m2");
  assert.equal(FakeClient.instances[0].thinkingEnabled, true);
  assert.equal(FakeClient.instances[0].effortConfig.currentValue, "high");
  assert.deepEqual(records.filter((item) => item.block).map((item) => item.block), [
    { role: "user", text: "question" },
    { role: "assistant", text: "hello world" },
  ]);
});

// ACP provider 的 model / effort 偏好存在 providers.<id> 下，顶层字段只属于
// miro：两者一旦互相借用，就会把上一个 provider 的模型名带到另一个身上。
test("ACP provider applies the model / effort preferences under its own providers.<id>", async () => {
  const out = capture();
  const err = capture();
  const records = [];
  const deps = dependencies(out.stream, err.stream, records);
  deps.settings = {
    model: "m1",
    effort: "low",
    providers: { fake: { model: "m2", effort: "high" } },
  };
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "text",
    continueSessionId: null,
    acp: "fake",
    model: null,
    effort: null,
  }, deps);

  assert.equal(code, 0);
  assert.equal(FakeClient.instances[0].modelConfig.currentValue, "m2");
  assert.equal(FakeClient.instances[0].effortConfig.currentValue, "high");
});

test("ACP provider does not borrow top-level settings model / effort preferences", async () => {
  const out = capture();
  const err = capture();
  const records = [];
  const deps = dependencies(out.stream, err.stream, records);
  deps.settings = { model: "m2", effort: "high", providers: {} };
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "text",
    continueSessionId: null,
    acp: "fake",
    model: null,
    effort: null,
  }, deps);

  assert.equal(code, 0);
  assert.equal(FakeClient.instances[0].modelConfig.currentValue, "m1", "the top-level model does not leak onto the ACP provider");
  assert.equal(FakeClient.instances[0].effortConfig.currentValue, "low", "the provider keeps its own default effort");
});

test("JSON mode keeps stdout a single machine-readable result", async () => {
  const out = capture();
  const err = capture();
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "json",
    continueSessionId: "resumed-session",
    acp: "fake",
    model: null,
    effort: null,
  }, dependencies(out.stream, err.stream, []));

  assert.equal(code, 0);
  const result = JSON.parse(out.value());
  assert.equal(result.result, "hello world");
  assert.equal(result.session_id, "resumed-session");
  assert.equal(result.provider, "fake");
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.is_error, false);
});

test("permission requests are denied by default and land in the JSON result", async () => {
  FakeClient.permission = true;
  const out = capture();
  const err = capture();
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "json",
    continueSessionId: null,
    acp: "fake",
    model: null,
    effort: null,
  }, dependencies(out.stream, err.stream, []));

  assert.equal(code, 0);
  assert.match(err.value(), /denied permission request: rm example/);
  assert.deepEqual(JSON.parse(out.value()).permission_denials, [
    { tool_call_id: "tool-1", description: "rm example" },
  ]);
});

test("an abnormal stop reason returns failure", async () => {
  FakeClient.stopReason = "cancelled";
  const out = capture();
  const err = capture();
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "text",
    continueSessionId: null,
    acp: "fake",
    model: null,
    effort: null,
  }, dependencies(out.stream, err.stream, []));

  assert.equal(code, 1);
  assert.equal(out.value(), "hello world\n");
  assert.match(err.value(), /request stopped: cancelled/);
});

test("reads and trims stdin when no prompt argument is given", async () => {
  const input = Readable.from(["  from ", "stdin\n"]);
  Object.defineProperty(input, "isTTY", { value: false });
  assert.equal(await readPrompt(input), "from stdin");
});

test("TTY stdin and oversized input raise explicit errors", async () => {
  const tty = Readable.from([]);
  Object.defineProperty(tty, "isTTY", { value: true });
  await assert.rejects(() => readPrompt(tty), /no prompt provided/);

  const large = Readable.from(["12345"]);
  Object.defineProperty(large, "isTTY", { value: false });
  await assert.rejects(() => readPrompt(large, 4), /exceeds 4 bytes/);
});

test("SIGINT cancels the ACP request and returns 130", async () => {
  class HangingClient extends FakeClient {
    async prompt(prompt) {
      this.sentPrompt = prompt;
      return new Promise(() => {});
    }

    cancel() { this.cancelled = true; }
  }

  const out = capture();
  const err = capture();
  const records = [];
  const deps = dependencies(out.stream, err.stream, records);
  deps.Client = HangingClient;
  const running = runHeadless({
    prompt: "question",
    outputFormat: "text",
    continueSessionId: null,
    acp: "fake",
    model: null,
    effort: null,
  }, deps);
  await new Promise((resolve) => setTimeout(resolve, 0));
  deps.signalTarget.emit("SIGINT");

  assert.equal(await running, 130);
  assert.equal(FakeClient.instances[0].cancelled, true);
  assert.equal(out.value(), "");
});

test("provider.sessionMeta is passed to the ACP client constructor arguments", async () => {
  const out = capture();
  const err = capture();
  const deps = dependencies(out.stream, err.stream, []);
  deps.providers = [{
    id: "routed",
    name: "Routed",
    bin: "routed-cli",
    args: ["acp"],
    sessionMeta: { agentId: "agent-id" },
  }];
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "text",
    continueSessionId: null,
    acp: "routed",
    model: null,
    effort: null,
  }, deps);

  assert.equal(code, 0);
  assert.deepEqual(FakeClient.instances[0].options.sessionMeta, { agentId: "agent-id" });
});
