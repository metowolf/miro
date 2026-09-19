import assert from "node:assert/strict";
import test from "node:test";

import { AcpClient } from "./acp-client.js";

/** 构造一个不启动子进程、只记录 session/prompt 载荷的 client。 */
function stubClient(options = {}) {
  const client = new AcpClient({ contextText: "AGENTS.md rules", ...options });
  client.sessionId = "session-1";
  const sent = [];
  client.context = {
    request: async (_method, params) => {
      sent.push(params.prompt);
      return { stopReason: "end_turn" };
    },
  };
  return { client, sent };
}

test("first plain prompt prepends the session context", async () => {
  const { client, sent } = stubClient();
  await client.prompt("hello");

  assert.deepEqual(sent[0], [
    { type: "text", text: "AGENTS.md rules" },
    { type: "text", text: "hello" },
  ]);
});

test("injectContext=false sends the message verbatim and it still starts with /", async () => {
  const { client, sent } = stubClient();
  await client.prompt("/changelog", { injectContext: false });

  assert.deepEqual(sent[0], [{ type: "text", text: "/changelog" }]);
  assert.ok(sent[0][0].text.startsWith("/"), "the provider only recognizes a command when the whole message starts with /");
});

test("skipping injection does not use up first-turn eligibility: the next plain input still gets context injected", async () => {
  const { client, sent } = stubClient();
  await client.prompt("/changelog", { injectContext: false });
  await client.prompt("hello");

  assert.equal(client.contextSent, true);
  assert.deepEqual(sent[1], [
    { type: "text", text: "AGENTS.md rules" },
    { type: "text", text: "hello" },
  ]);
});

test("later turns are not prefixed again once context has been injected", async () => {
  const { client, sent } = stubClient();
  await client.prompt("hello");
  await client.prompt("world");

  assert.deepEqual(sent[1], [{ type: "text", text: "world" }]);
});

test("a failed first prompt rolls back the injection flag", async () => {
  const { client } = stubClient();
  client.context = {
    request: async () => {
      throw new Error("boom");
    },
  };

  await assert.rejects(() => client.prompt("hello"));
  assert.equal(client.contextSent, false);
});

test("resuming a session skips context injection so history never gets a second copy of the rules", async () => {
  const { client, sent } = stubClient({ continueSessionId: "session-1" });
  await client.prompt("follow up");
  assert.equal(client.contextSent, true);
  assert.deepEqual(sent[0], [{ type: "text", text: "follow up" }]);
});

test("prompt forwards ACP usage tagged as a session snapshot", async () => {
  const client = new AcpClient({ contextText: null });
  client.sessionId = "session-1";
  client.context = {
    request: async () => ({
      stopReason: "end_turn",
      usage: { totalTokens: 500, inputTokens: 400, outputTokens: 100, thoughtTokens: 20 },
    }),
  };
  const seen = [];
  client.on("token_usage", (payload) => seen.push(payload));

  await client.prompt("hello");

  // ACP 的 Usage 是会话累计快照（totalTokens = "Sum of all token types across session"），
  // 必须带上标记：store 按增量累加，误当增量会让用量随轮次成倍虚高。
  assert.deepEqual(seen, [
    { totalTokens: 500, inputTokens: 400, outputTokens: 100, thoughtTokens: 20, sessionCumulative: true },
  ]);
});

test("a prompt response without usage emits nothing", async () => {
  const { client } = stubClient();
  const seen = [];
  client.on("token_usage", (payload) => seen.push(payload));

  await client.prompt("hello");

  assert.deepEqual(seen, []);
});

test("session/new writes _meta when sessionMeta is configured and omits the field otherwise", () => {
  const withMeta = new AcpClient({
    cwd: "/home/user/project",
    sessionMeta: { agentId: "agent-id" },
    mcpServers: [],
  });
  assert.deepEqual(withMeta.sessionNewParams(), {
    cwd: "/home/user/project",
    mcpServers: [],
    _meta: { agentId: "agent-id" },
  });

  const withoutMeta = new AcpClient({ cwd: "/tmp/ws", mcpServers: [] });
  assert.deepEqual(withoutMeta.sessionNewParams(), {
    cwd: "/tmp/ws",
    mcpServers: [],
  });
  assert.equal("_meta" in withoutMeta.sessionNewParams(), false);
});

test("invalid sessionMeta never reaches session/new", () => {
  const client = new AcpClient({ sessionMeta: ["agent-id"] });
  assert.equal(client.sessionMeta, null);
  assert.equal("_meta" in client.sessionNewParams(), false);
});
