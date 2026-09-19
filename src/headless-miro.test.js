import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runHeadless } from "./headless.js";
import { MiroAgentClient } from "./miro/agent-client.js";
import { AUTO_WARNING } from "./miro/permission-mode.js";

function capture() {
  let value = "";
  return {
    stream: new PassThrough(),
    value: () => value,
    collect: (stream) => {
      stream.on("data", (chunk) => {
        value += chunk.toString();
      });
      return stream;
    },
  };
}

/** 不连网络：注入一个直接产出文本的流。 */
function miroStream(...rounds) {
  let index = 0;
  return async function* stream() {
    const round = rounds[Math.min(index, rounds.length - 1)];
    index += 1;
    for (const event of round) yield event;
  };
}

function dependencies({ stdout, stderr, records, stream, settings = {} }) {
  return {
    stdout,
    stderr,
    settings,
    providers: [{ id: "miro", name: "Miro", kind: "miro" }],
    loadContext: () => ({ contextText: "rules" }),
    createRecorder: (meta) => ({
      recordBlock: (block) => records.push({ meta, block }),
      recordModel: (model) => records.push({ meta, model }),
    }),
    signalTarget: new EventEmitter(),
    Client: class UnusedACPClient {
      constructor() {
        throw new Error("the miro provider must not instantiate an ACP client");
      }
    },
    MiroAgentClient: class TestMiroAgentClient extends MiroAgentClient {
      constructor(options) {
        super({
          ...options,
          cwd: process.cwd(),
          settings: { miro: { models: ["m1"], model: "m1" }, ...settings },
          dependencies: {
            // 不注入就会去读真实的 ~/.miro/models.json / auth.json，本机目录和登录态会盖掉用例的模型表。
            modelsFile: null,
            oauthModels: { getModels: () => [] },
            startBash: () => ({
              result: Promise.resolve({ stdout: "", stderr: "", outcome: { type: "exited", code: 0 } }),
              interrupt: () => true,
            }),
            streamCompletion: stream,
          },
        });
      }
    },
  };
}

test("headless prints the answer and records a transcript under the miro provider", async () => {
  const out = capture();
  const err = capture();
  const records = [];
  const code = await runHeadless({
    prompt: "question",
    outputFormat: "json",
    continueSessionId: null,
    acp: null,
    model: null,
    effort: null,
  }, dependencies({
    stdout: out.collect(new PassThrough()),
    stderr: err.collect(new PassThrough()),
    records,
    stream: miroStream([{ type: "text", text: "hello " }, { type: "text", text: "world" }]),
  }));

  assert.equal(code, 0);
  const result = JSON.parse(out.value());
  assert.equal(result.result, "hello world");
  assert.equal(result.provider, "miro");
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.is_error, false);
  assert.equal(err.value(), `${AUTO_WARNING}\n`);
  assert.deepEqual(records.filter((item) => item.block).map((item) => item.block), [
    { role: "user", text: "question" },
    { role: "assistant", text: "hello world" },
  ]);
});

test("AGENTS.md is injected only on the first turn under the miro provider", async () => {
  const out = capture();
  const err = capture();
  const seen = [];
  const deps = dependencies({
    stdout: out.collect(new PassThrough()),
    stderr: err.collect(new PassThrough()),
    records: [],
    stream: miroStream([{ type: "text", text: "ok" }]),
    settings: { providers: {} },
  });

  // 直接驱动 client，验证注入语义而非 headless 输出。
  const client = new deps.MiroAgentClient({ contextText: "AGENTS.md rules" });
  const running = client.run();
  await new Promise((resolve) => client.once("ready", resolve));
  await client.prompt("first");
  await client.prompt("second");

  for (const message of client.messages) {
    if (message.role === "user") seen.push(message.content);
  }
  assert.match(seen[0], /AGENTS\.md rules/);
  assert.match(seen[0], /first/);
  assert.equal(seen[1], "second");

  client.close();
  await running;
});

test("the miro provider also applies the shared model / effort preferences from settings", async () => {
  const out = capture();
  const err = capture();
  const records = [];
  // 顶层 model/effort 优先于 miro 对象里的默认选择；-m / --effort 仍更优先。
  const code = await runHeadless({
    prompt: "hi",
    outputFormat: "json",
    continueSessionId: null,
    acp: null,
    model: null,
    effort: null,
  }, dependencies({
    stdout: out.collect(new PassThrough()),
    stderr: err.collect(new PassThrough()),
    records,
    stream: miroStream([{ type: "text", text: "ok" }]),
    settings: {
      model: "m2",
      effort: "low",
      miro: { models: ["m1", "m2"], model: "m1" },
    },
  }));

  assert.equal(code, 0);
  assert.equal(err.value(), `${AUTO_WARNING}\n`);
  assert.equal(records.find((item) => item.model != null).model, "m2");
});

test("the CLI -m wins over the shared model preference under the miro provider", async () => {
  const out = capture();
  const err = capture();
  const records = [];
  const code = await runHeadless({
    prompt: "hi",
    outputFormat: "json",
    continueSessionId: null,
    acp: null,
    model: "m1",
    effort: null,
  }, dependencies({
    stdout: out.collect(new PassThrough()),
    stderr: err.collect(new PassThrough()),
    records,
    stream: miroStream([{ type: "text", text: "ok" }]),
    settings: {
      model: "m2",
      miro: { models: ["m1", "m2"], model: "m1" },
    },
  }));

  assert.equal(code, 0);
  assert.equal(err.value(), `${AUTO_WARNING}\n`);
  assert.equal(records.find((item) => item.model != null).model, "m1");
});
