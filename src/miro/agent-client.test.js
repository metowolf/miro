/**
 * 隔离回合（promptIsolated）的语义测试。
 *
 * 这里守的是「上下文边界」而不是模型行为：命令的提示词与中间过程必须留在
 * 隔离历史里，主历史只多出一对「输入记录 + 结论」。所以断言的是 messages
 * 的形状与发出去的请求历史，不涉及真实网络。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MiroAgentClient } from "./agent-client.js";

/** 按顺序回放的假流；请求数超出脚本时复用最后一段。 */
function scriptedStream(rounds, seen = []) {
  let index = 0;
  return async function* stream(requestOptions) {
    seen.push((requestOptions?.messages ?? []).map((message) => ({ ...message })));
    const round = rounds[Math.min(index, rounds.length - 1)] ?? [];
    index += 1;
    for (const event of round) yield event;
  };
}

function makeClient({ rounds = [], contextText = null, seen = [] } = {}) {
  return new MiroAgentClient({
    cwd: "/tmp/agent-client-test",
    contextText,
    settings: { miro: { models: ["m1"], model: "m1" } },
    dependencies: {
      // 不注入就会读真实的 ~/.miro/models.json 与 auth.json，本机目录/登录态会盖掉用例的模型表。
      modelsFile: null,
      oauthModels: { getModels: () => [] },
      loadSkills: () => ({ skills: [], diagnostics: [] }),
      loadSessionBlocks: () => null,
      streamCompletion: scriptedStream(rounds, seen),
      startBash: () => ({
        result: Promise.resolve({ stdout: "", stderr: "", outcome: { type: "exited", code: 0 } }),
        interrupt: () => true,
      }),
    },
  });
}

const ANSWER = [{ type: "text", text: "finding one" }, { type: "done" }];

test("an isolated turn keeps the command prompt out of the session history", async () => {
  const client = makeClient({ rounds: [ANSWER] });
  const chunks = [];
  client.on("chunk", (delta) => chunks.push(delta));

  const result = await client.promptIsolated("REVIEW RUBRIC\n---\ntarget", {
    displayText: "/review current changes",
  });

  assert.equal(result.stopReason, "end_turn");
  // 事件照常流给界面：隔离的是历史，不是显示。
  assert.deepEqual(chunks, ["finding one"]);
  assert.deepEqual(
    client.messages.map((message) => [message.role, message.content]),
    [
      ["user", "/review current changes"],
      ["assistant", "finding one"],
    ]
  );
});

test("an isolated turn runs on a fresh history carrying the injected context", async () => {
  const seen = [];
  const client = makeClient({ rounds: [ANSWER], contextText: "<memory>project rules</memory>", seen });

  await client.promptIsolated("do the task", { displayText: "/review x", injectContext: true });

  const history = seen[0];
  assert.equal(history[0].role, "system");
  assert.equal(history[0].content, client.systemPrompt());
  assert.equal(history[1].role, "user");
  assert.ok(history[1].content.startsWith("<memory>project rules</memory>"));
  assert.match(history[1].content, /do the task$/);
  // 上下文只进隔离历史：回灌的记录与结论里都没有它。
  assert.ok(!client.messages.some((message) => String(message.content).includes("project rules")));
});

test("an isolated turn does not consume the one-time context injection", async () => {
  const seen = [];
  const client = makeClient({ rounds: [ANSWER], contextText: "<memory>rules</memory>", seen });

  await client.promptIsolated("task", { displayText: "/review x", injectContext: true });
  assert.equal(client.contextSent, false);

  await client.prompt("hello");
  const history = seen.at(-1);
  assert.ok(String(history.at(-1).content).includes("<memory>rules</memory>"));
});

test("an isolated turn without a visible answer keeps only the command record", async () => {
  const client = makeClient({ rounds: [[]] });

  const result = await client.promptIsolated("task", { displayText: "/review x" });

  assert.equal(result.stopReason, "empty_response");
  // transcript 上这条命令的 user 块不撤回，主历史也必须留着它，否则 /resume
  // 还原出的上下文会比实时多出一条没有回音的命令。
  assert.deepEqual(
    client.messages.map((message) => [message.role, message.content]),
    [["user", "/review x"]]
  );
});

test("cancelling an isolated turn keeps the record and the half-finished answer", async () => {
  const client = makeClient();
  let started;
  const firstChunk = new Promise((resolve) => {
    started = resolve;
  });
  client.dependencies.streamCompletion = async function* ({ signal }) {
    yield { type: "text", text: "half" };
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  };

  const pending = client.promptIsolated("task", { displayText: "/review x" });
  await firstChunk;
  client.cancel();

  assert.equal((await pending).stopReason, "cancelled");
  // 与普通回合的中断路径及 transcript 一致：流给过 UI 的半截正文留在历史里。
  assert.deepEqual(
    client.messages.map((message) => [message.role, message.content]),
    [
      ["user", "/review x"],
      ["assistant", "half"],
    ]
  );
});

test("text between tool rounds is joined with blank lines instead of welded", async () => {
  const rounds = [
    [
      { type: "text", text: "Let me look at the diff first." },
      // 未知工具不会真执行：循环直接回灌「Unknown tool」并进入下一轮，
      // 但 onTool 已经把正文切成了两段。
      { type: "tool_calls", calls: [{ id: "c1", name: "not_a_tool", arguments: "{}" }] },
    ],
    [{ type: "text", text: "## Findings" }],
  ];
  const client = makeClient({ rounds });

  const result = await client.promptIsolated("task", { displayText: "/review x" });

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(
    client.messages.map((message) => [message.role, message.content]),
    [
      ["user", "/review x"],
      ["assistant", "Let me look at the diff first.\n\n## Findings"],
    ]
  );
});

test("rememberIsolatedAnswer ignores empty text", () => {
  const client = makeClient();

  client.rememberIsolatedAnswer("   ");
  assert.deepEqual(client.messages, []);

  client.rememberIsolatedAnswer(" full answer ");
  assert.deepEqual(client.messages.map((message) => message.content), ["full answer"]);
});

test("resolveSubagentRouting resolves overrides against the model catalog", () => {
  const client = makeClient();

  assert.deepEqual(
    client.resolveSubagentRouting({ model: "m2" }),
    { error: 'model "m2" is not available' }
  );

  const routed = client.resolveSubagentRouting({ model: "m1", effort: "high" });
  assert.equal(routed.patch.model, "m1");
  assert.equal(routed.patch.effort, "high");

  // 只给 effort 时仍对标父模型，不改变 model。
  const effortOnly = client.resolveSubagentRouting({ effort: "low" });
  assert.equal(effortOnly.patch.model, "m1");
  assert.equal(effortOnly.patch.effort, "low");

  assert.deepEqual(
    client.resolveSubagentRouting({ effort: "xhigh" }),
    { error: 'effort "xhigh" is not available for model "m1"' }
  );
});

test("a miro client starts on the saved top-level model / effort preference", () => {
  const client = new MiroAgentClient({
    cwd: "/tmp/agent-client-test",
    // 顶层 model / effort 是 miro 的持久偏好（/model、/effort 就写在这里）。
    settings: { model: "m2", effort: "high", miro: { models: ["m1", "m2"], model: "m1" } },
    dependencies: {
      modelsFile: null,
      oauthModels: { getModels: () => [] },
      loadSkills: () => ({ skills: [], diagnostics: [] }),
    },
  });

  // 恢复会话不会再套一次偏好，启动值必须自己就是偏好，否则会停在模型表第一项。
  assert.equal(client.config.model, "m2");
  assert.equal(client.config.effort, "high");
  assert.equal(client.modelConfig.currentValue, "m2");
  assert.equal(client.effortConfig.currentValue, "high");
});

test("a qualified oauth model preference is selected after merging catalogs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-oauth-pref-"));
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, `${JSON.stringify({
    credentials: { "openai-codex": { type: "oauth", access: "t", refresh: "r", expires: 1 } },
  })}\n`);

  const client = new MiroAgentClient({
    cwd: "/tmp/agent-client-test",
    settings: { model: "openai-codex/gpt-5.6-sol", miro: { models: ["m1"], model: "m1" } },
    dependencies: {
      modelsFile: null,
      authFile,
      oauthModels: {
        getModels: () => [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          reasoning: true,
        }],
      },
      loadSkills: () => ({ skills: [], diagnostics: [] }),
    },
  });

  assert.equal(client.config.model, "openai-codex/gpt-5.6-sol");
  assert.equal(client.config.apiModel, "gpt-5.6-sol");
  assert.equal(client.modelConfig.currentValue, "openai-codex/gpt-5.6-sol");
});

test("/config sandbox persists the setting and keeps the terminal tool in both modes", async () => {
  const writes = [];
  const client = makeClient();
  client.dependencies.writeSystemSettings = async (settings) => writes.push(settings);
  const toolIds = () => client.configOptions.find((option) => option.id === "tools").tools.map((option) => option.id);

  await client.setConfigOption("sandbox", "on");
  assert.equal(client.config.sandboxEnabled, true);
  assert.equal(writes[0].miro.sandbox.enabled, true);
  assert.ok(toolIds().includes("tool:terminal"));

  await client.setConfigOption("sandbox", "off");
  assert.equal(client.config.sandboxEnabled, false);
  assert.equal(writes[1].miro.sandbox.enabled, false);
  assert.ok(toolIds().includes("tool:terminal"));
  assert.ok(!toolIds().includes("tool:run_command"));
});

test("/config no longer exposes a user-selectable approval reviewer", () => {
  const client = makeClient();
  assert.equal(client.configOptions.some((option) => option.id === "approval_reviewer"), false);
});
