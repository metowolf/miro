import assert from "node:assert/strict";
import test from "node:test";

import { useStore, setRecorder } from "./store.js";

function resetStore() {
  useStore.setState({
    blocks: [],
    pending: null,
    epoch: 0,
    length: 0,
    activeTools: [],
    finalizedToolIds: new Set(),
    planningToolIds: new Set(),
    toolRound: 0,
    pendingToolGroup: null,
    thought: null,
    thinkingDisplay: "compact",
    planSignature: null,
    queuedInputs: [],
    providerCommands: [],
    pendingBashContext: [],
    bashCard: null,
    status: "connecting",
    usage: null,
    tokens: null,
    sessionTokens: null,
    sessionCost: null,
    goal: null,
    busy: false,
    cancelling: false,
    turnStartedAt: null,
    turnKind: null,
  });
}

function textContent(text) {
  return [{ type: "content", content: { type: "text", text } }];
}

function imageContent(data = "") {
  return [{ type: "content", content: { type: "image", data, mimeType: "image/png" } }];
}

test("setTokens keeps the latest reading and accumulates miro per-call increments", () => {
  resetStore();
  useStore.getState().setTokens({
    totalTokens: 10,
    inputTokens: 7,
    outputTokens: 3,
    cachedReadTokens: 2,
    cachedWriteTokens: 1,
    thoughtTokens: 1,
  });
  useStore.getState().setTokens({
    totalTokens: 20,
    inputTokens: 14,
    outputTokens: 6,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
  });

  // 最近一次读数原样保留（ActivitySlot 的思考行提示依赖它），未上报的字段不清零。
  assert.deepEqual(useStore.getState().tokens, {
    total: 20,
    input: 14,
    output: 6,
    cacheRead: 4,
    cacheWrite: 2,
    thought: 1,
  });
  // 会话累计把两次调用相加。
  assert.deepEqual(useStore.getState().sessionTokens, {
    total: 30,
    input: 21,
    output: 9,
    cacheRead: 6,
    cacheWrite: 3,
    thought: 1,
  });
});

test("setUsage accumulates miro per-request cost and keeps the latest reading", () => {
  resetStore();
  // miro 每次 LLM 请求上报的是本次成本，直接相加。
  useStore.getState().setUsage({ used: 100, size: 1_000, cost: { amount: 0.002, currency: "USD" } });
  useStore.getState().setUsage({ used: 150, size: 1_000, cost: { amount: 0.003, currency: "USD" } });
  assert.deepEqual(useStore.getState().sessionCost, { amount: 0.005, currency: "USD" });
  // 未上报成本的一轮只更新上下文水位，不把累计值清零，也不动上一次的成本读数。
  useStore.getState().setUsage({ used: 200, size: 1_000, cost: null });
  assert.deepEqual(useStore.getState().sessionCost, { amount: 0.005, currency: "USD" });
  assert.deepEqual(useStore.getState().usage.cost, { amount: 0.003, currency: "USD" });
});

test("setUsage treats ACP cost as a session snapshot instead of an increment", () => {
  resetStore();
  // ACP 的 Cost.amount 按协议是会话累计值，只能整量替换：0.007 而不是 0.009。
  useStore.getState().setUsage({ used: 100, size: 1_000, cost: { amount: 0.002, currency: "USD" }, costCumulative: true });
  useStore.getState().setUsage({ used: 200, size: 1_000, cost: { amount: 0.007, currency: "USD" }, costCumulative: true });
  assert.deepEqual(useStore.getState().sessionCost, { amount: 0.007, currency: "USD" });
});

test("setTokens treats ACP usage as a session snapshot instead of an increment", () => {
  resetStore();
  for (const totalTokens of [100, 250, 500]) {
    useStore.getState().setTokens({
      totalTokens,
      inputTokens: totalTokens,
      outputTokens: 0,
      sessionCumulative: true,
    });
  }

  // 快照直接作为最新读数，但累计只能取增量：500 而不是 850。
  assert.deepEqual(useStore.getState().tokens, {
    total: 500,
    input: 500,
    output: 0,
    cacheRead: null,
    cacheWrite: null,
    thought: null,
  });
  // outputTokens 一直是 0：它是已上报的有效读数，累计值要留 0 而不是折叠成
  // null（否则「0 也要显示」的分支在真实数据下不可达）；未上报的字段才是 null。
  assert.deepEqual(useStore.getState().sessionTokens, {
    total: 500,
    input: 500,
    output: 0,
    cacheRead: null,
    cacheWrite: null,
    thought: null,
  });
});

test("setTokens keeps a reported zero as a session total", () => {
  resetStore();
  useStore.getState().setTokens({ totalTokens: 12, outputTokens: 12, cachedWriteTokens: 0 });

  assert.equal(useStore.getState().sessionTokens.cacheWrite, 0);
  assert.equal(useStore.getState().sessionTokens.output, 12);
  // 再上报一次同样的 0 不改变累计值，也不把字段打回未上报。
  useStore.getState().setTokens({ totalTokens: 3, outputTokens: 3, cachedWriteTokens: 0 });
  assert.equal(useStore.getState().sessionTokens.cacheWrite, 0);
  assert.equal(useStore.getState().sessionTokens.total, 15);
});

test("setTokens folds an unreported field back to the previous session total", () => {
  resetStore();
  useStore.getState().setTokens({ totalTokens: 10, thoughtTokens: 4 });
  useStore.getState().setTokens({ totalTokens: 5 });

  // thoughtTokens 这一轮没上报：保留原累计值，而不是当成 0 或清空。
  assert.equal(useStore.getState().sessionTokens.thought, 4);
  assert.equal(useStore.getState().sessionTokens.total, 15);
  assert.equal(useStore.getState().tokens.thought, 4);
});

test("setTokens ignores a session-counter rollback and invalid values", () => {
  resetStore();
  useStore.getState().setTokens({ totalTokens: 500, sessionCumulative: true });
  useStore.getState().setTokens({ totalTokens: 20, sessionCumulative: true });
  useStore.getState().setTokens({ totalTokens: -1, inputTokens: "12" });

  assert.equal(useStore.getState().sessionTokens.total, 500);
  assert.equal(useStore.getState().tokens.input, null);
});

test("connected and reconnecting drop the accumulated session usage", () => {
  resetStore();
  useStore.getState().setTokens({ totalTokens: 40 });
  useStore.getState().setTokens({ totalTokens: 60 });
  assert.equal(useStore.getState().sessionTokens.total, 100);

  useStore.getState().connected({ providerName: "Claude", sessionId: "session-2" });
  assert.equal(useStore.getState().sessionTokens, null);
  assert.equal(useStore.getState().tokens, null);

  useStore.getState().setTokens({ totalTokens: 7, sessionCumulative: true });
  assert.equal(useStore.getState().sessionTokens.total, 7);
  useStore.getState().reconnecting();
  assert.equal(useStore.getState().sessionTokens, null);
});

test("setGoal keeps the same state object when no visible field changed", () => {
  resetStore();
  const base = {
    goalId: "goal_1",
    objective: "ship the feature",
    status: "active",
    turnsUsed: 1,
    terminalReason: null,
    wallClockMs: 4_000,
    budget: { turnBudget: 5 },
  };
  useStore.getState().setGoal(base);
  const first = useStore.getState().goal;

  // 状态机每累计一次 token 都会 emit，但 token 数只在 /goal status 里看（那边直接
  // 向 client 要新快照）：必须复用同一个 state 对象，否则状态栏会按 token 计数的
  // 频率重渲。
  useStore.getState().setGoal({ ...base, tokensUsed: 900 });
  assert.equal(useStore.getState().goal, first);

  // 墙钟不同：底栏右侧的 `◎ /goal active (4s)` 印的就是它，秒表每次取到的新快照
  // 都必须落到 state 上，否则计时会停在第一次 emit 的读数。
  useStore.getState().setGoal({ ...base, wallClockMs: 5_000 });
  assert.notEqual(useStore.getState().goal, first);
  assert.equal(useStore.getState().goal.wallClockMs, 5_000);

  useStore.getState().setGoal({ ...base, turnsUsed: 2 });
  assert.equal(useStore.getState().goal.turnsUsed, 2);
});

test("setGoal tracks status and terminal reason changes", () => {
  resetStore();
  const base = { goalId: "goal_1", objective: "x", status: "active", turnsUsed: 3, budget: {} };
  useStore.getState().setGoal(base);
  useStore.getState().setGoal({ ...base, status: "blocked", terminalReason: "needs credentials" });
  assert.equal(useStore.getState().goal.status, "blocked");
  assert.equal(useStore.getState().goal.terminalReason, "needs credentials");
});

test("setGoal(null) clears the goal and is a no-op when already empty", () => {
  resetStore();
  const before = useStore.getState();
  useStore.getState().setGoal(null);
  assert.equal(useStore.getState().goal, null);
  assert.equal(useStore.getState(), before);

  useStore.getState().setGoal({ goalId: "g", objective: "x", status: "active", budget: {} });
  assert.notEqual(useStore.getState().goal, null);
  useStore.getState().setGoal(null);
  assert.equal(useStore.getState().goal, null);
});

test("a goal does not survive a new session, a reconnect, or a cleared transcript", () => {
  const goal = { goalId: "g", objective: "x", status: "active", turnsUsed: 2, budget: {} };
  for (const boundary of [
    () => useStore.getState().connected({ providerName: "Miro", sessionId: "session-9" }),
    () => useStore.getState().reconnecting(),
    // 目标依附于会话上下文：清空 transcript 后留着它，续跑就会对着空历史推进。
    () => useStore.getState().clearTranscript(),
  ]) {
    resetStore();
    useStore.getState().setGoal(goal);
    assert.notEqual(useStore.getState().goal, null);
    boundary();
    assert.equal(useStore.getState().goal, null);
  }
});

test("tool preview is finalized into the transcript block", () => {
  resetStore();
  const store = useStore.getState();
  store.startTurn();
  store.upsertTool({
    kind: "tool_call",
    toolCallId: "t1",
    name: "Write",
    rawInput: { path: "/tmp/x.txt" },
    status: "pending",
  });
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: textContent("Wrote 3 lines\nalpha\nbeta"),
  });
  useStore.getState().endTurn();

  const toolBlock = useStore.getState().blocks.find((b) => b.role === "tool");
  assert.ok(toolBlock, "tool block should be finalized");
  assert.deepEqual(toolBlock.tool.preview.lines, ["Wrote 3 lines"]);
  assert.equal(toolBlock.tool.preview.more, 0);
});

test("Read result is finalized as a line-count summary", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "read-lines",
    toolKind: "read",
    name: "Read",
    rawInput: { path: "/tmp/large.txt" },
    status: "in_progress",
  });
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "read-lines",
    toolKind: "read",
    status: "completed",
    content: textContent("one\ntwo\nthree\n"),
  });
  useStore.getState().endTurn();

  const toolBlock = useStore.getState().blocks.find((block) => block.role === "tool");
  assert.deepEqual(toolBlock.tool.preview, { lines: ["Read 3 lines"], more: 0 });
});

test("Read image result and failure use one-line summaries", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "read-image",
    toolKind: "read",
    name: "Read",
    rawInput: { path: "/tmp/image.png" },
    status: "completed",
    content: imageContent(),
  });
  useStore.getState().endTurn();
  const imageTool = useStore.getState().blocks.find((block) => block.role === "tool");
  assert.deepEqual(imageTool.tool.preview, { lines: ["Read image"], more: 0 });

  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "read-failed",
    toolKind: "read",
    name: "Read",
    rawInput: { path: "/tmp/missing.txt" },
    status: "failed",
    content: textContent("file not found\nextra details"),
  });
  useStore.getState().endTurn();

  const failedTool = useStore.getState().blocks.find((block) => block.role === "tool");
  assert.deepEqual(failedTool.tool.preview, { lines: ["file not found"], more: 0 });
});

test("internal planning placeholders become one Thought line instead of a duplicate tool", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "planning",
    toolKind: "other",
    title: "任务规划中",
    status: "in_progress",
    content: textContent("任务规划中"),
  });
  assert.ok(useStore.getState().thought, "planning should enter the thought state");
  assert.equal(useStore.getState().activeTools.length, 0);

  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "planning",
    status: "completed",
    content: textContent("任务规划中"),
  });
  // 已定稿后 provider 偶尔会重发进度，不能重新开启 Thinking 状态。
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "planning",
    toolKind: "other",
    title: "任务规划中",
    status: "in_progress",
  });
  assert.equal(useStore.getState().thought, null);
  useStore.getState().endTurn();

  const blocks = useStore.getState().blocks;
  assert.equal(blocks.filter((block) => block.role === "tool").length, 0);
  assert.equal(blocks.filter((block) => /^Thought\b/.test(block.text ?? "")).length, 1);
});

test("a planning placeholder with an empty rawInput is still recognized as a planning placeholder", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  // 有的 ACP provider 会带上空的 rawInput/locations，那不是真实参数。
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "planning-empty-raw",
    toolKind: "other",
    title: "任务规划中",
    status: "in_progress",
    rawInput: {},
    locations: [],
    content: textContent("任务规划中"),
  });
  assert.ok(useStore.getState().thought, "planning should enter the thought state");
  assert.equal(useStore.getState().activeTools.length, 0);

  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "planning-empty-raw",
    status: "completed",
  });
  useStore.getState().endTurn();

  assert.equal(useStore.getState().blocks.filter((block) => block.role === "tool").length, 0);
});

test("a kind=other tool with real arguments is not mistaken for a planning placeholder", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "real-other",
    toolKind: "other",
    title: "任务规划中",
    status: "completed",
    rawInput: { query: "plan the migration" },
  });
  useStore.getState().endTurn();

  assert.equal(useStore.getState().blocks.filter((block) => block.role === "tool").length, 1);
});

test("Bash keeps assistant text independent and preserves real output", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("I'll compute it directly.");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "bash",
    toolKind: "execute",
    title: "执行命令",
    rawInput: {},
    status: "in_progress",
    content: textContent("执行命令"),
  });
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "bash",
    toolKind: "execute",
    status: "completed",
    rawInput: { command: 'python3 -c "print(2**234)"' },
    rawOutput: { stdout: "27606985387162255149739023449108101809804435888681546220650096895197184" },
    content: textContent("执行命令"),
  });
  useStore.getState().endTurn();

  const tool = useStore.getState().blocks.find((block) => block.role === "tool");
  assert.equal(tool.tool.label.name, "Bash");
  assert.equal(tool.tool.label.args, 'python3 -c "print(2**234)"');
  assert.equal(tool.tool.hint, null);
  assert.deepEqual(tool.tool.preview, {
    lines: ["27606985387162255149739023449108101809804435888681546220650096895197184"],
    more: 0,
  });
  assert.equal(tool.tool.command, 'python3 -c "print(2**234)"');
  const assistant = useStore
    .getState()
    .blocks.find((block) => block.role === "assistant");
  assert.equal(assistant?.text, "I'll compute it directly.");
  assert.ok(
    useStore.getState().blocks.indexOf(assistant) < useStore.getState().blocks.indexOf(tool),
    "assistant text should precede the tool block"
  );
});

test("miro wire-format tool names render the same display name as the ACP path", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  // miro 同时上报 name（给模型的 snake_case）与 kind / title（给人看的）；
  // 取前者会让同一个工具在两条 provider 路径上显示成两个名字。
  for (const [toolCallId, name, toolKind, title, rawInput] of [
    ["n1", "run_command", "execute", "Bash", { command: "ls" }],
    ["n2", "read_file", "read", "Read", { path: "src/a.js" }],
    // 命令工具现在固定叫 terminal，两种模式上报的都是这个名字。
    ["n3", "terminal", "execute", "Terminal", { command: "ls" }],
    ["n4", "write_plan", "plan", "Write plan", { plan: "# 计划" }],
  ]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId,
      name,
      toolKind,
      title,
      rawInput,
      status: "completed",
    });
  }
  useStore.getState().endTurn();

  const names = useStore
    .getState()
    .blocks.filter((block) => block.role === "tool")
    .flatMap((block) => block.tool.group?.items.map((item) => item.label.name) ?? [block.tool.label.name]);
  assert.deepEqual(names, ["Bash", "Read", "terminal", "Write plan"]);
});

test("falls back to the wire-format tool name when no display name is available", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "unknown",
    name: "vendor_special_tool",
    toolKind: "other",
    status: "completed",
  });
  useStore.getState().endTurn();

  const tool = useStore.getState().blocks.find((block) => block.role === "tool")?.tool;
  assert.equal(tool.label.name, "vendor_special_tool");
});

test("short assistant text after thought stays separate from the next tool", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().noteThought("checking the isolated result");
  useStore.getState().appendChunk("隔离环境下全部正常。重新运行完整 verify 脚本确认。");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "verify",
    toolKind: "execute",
    rawInput: { command: "python3 /tmp/verify.py" },
    status: "completed",
  });

  const blocks = useStore.getState().blocks;
  assert.deepEqual(blocks.map((block) => block.role), ["thought", "assistant", "tool"]);
  assert.match(blocks[0].text, /^Thought\b/);
  assert.equal(blocks[1].text, "隔离环境下全部正常。重新运行完整 verify 脚本确认。");
  assert.equal(blocks[2].tool.hint, null);
});

test("a short prose chunk seals the pending tool group first so the order does not flip after finalization", () => {
  resetStore();
  useStore.getState().startTurn();
  twoCompletedReads();

  // 不带空行的短正文不会触发 streamChunk 切块，但工具组仍必须立即定稿，
  // 否则动态区里 pending 正文画在活动槽之上，endTurn 后才反转为组在上。
  useStore.getState().appendChunk("一句话总结。");
  let state = useStore.getState();
  assert.equal(state.pendingToolGroup, null);
  assert.deepEqual(state.blocks.map((block) => block.role), ["tool"]);
  assert.equal(state.blocks[0].tool.group?.count, 2);
  assert.equal(state.pending?.text, "一句话总结。");

  useStore.getState().endTurn();
  const blocks = useStore.getState().blocks;
  assert.deepEqual(blocks.map((block) => block.role), ["tool", "assistant", "system"]);
  assert.equal(blocks[0].tool.group.name, "2 tool calls");
});

function twoCompletedReads() {
  for (const [id, file] of [["r1", "a.js"], ["r2", "b.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: file },
      status: "completed",
    });
  }
}

test("the pending tool group finalizes before bash cards and user messages", () => {
  resetStore();
  useStore.getState().startTurn();
  twoCompletedReads();

  useStore.getState().startBashCard("ls");
  useStore.getState().finishBashCard({ stdout: "a.js", stderr: "", outcome: null });
  useStore.getState().push("user", "下一个问题");

  const blocks = useStore.getState().blocks;
  assert.deepEqual(
    blocks.map((block) => block.role),
    ["tool", "bashCard", "user"]
  );
});

test("consecutive tool calls become one reviewable turn summary", () => {
  resetStore();
  const store = useStore.getState();
  store.startTurn();
  for (const [id, file] of [["r1", "a.js"], ["r2", "b.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      name: "Read",
      rawInput: { path: file },
      status: "completed",
      content: textContent("file body"),
    });
  }
  useStore.getState().endTurn();

  const toolBlocks = useStore.getState().blocks.filter((b) => b.role === "tool");
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].tool.group.name, "2 tool calls");
  assert.equal(toolBlocks[0].tool.group.summary, "2 reads");
  assert.deepEqual(
    toolBlocks[0].tool.reviewItems.map((item) => item.label.args),
    ["a.js", "b.js"]
  );
  assert.equal(toolBlocks[0].tool.reviewItems.every((item) => item.detail.output === "file body"), true);
});

test("tool rounds: a parallel batch counts as one round, the next batch increments, and a new turn resets to zero", () => {
  resetStore();
  useStore.getState().startTurn();
  assert.equal(useStore.getState().toolRound, 0);

  for (const id of ["r1", "r2"]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: `${id}.js` },
      status: "in_progress",
    });
  }
  // 两个工具重叠在活动区上，算同一轮：否则状态行动词会在一批里连跳几个词。
  assert.equal(useStore.getState().toolRound, 1);

  for (const id of ["r1", "r2"]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: `${id}.js` },
      status: "completed",
      content: textContent("file body"),
    });
  }
  assert.equal(useStore.getState().toolRound, 1);

  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "r3",
    toolKind: "read",
    rawInput: { path: "c.js" },
    status: "in_progress",
  });
  assert.equal(useStore.getState().toolRound, 2);

  useStore.getState().endTurn();
  useStore.getState().startTurn();
  assert.equal(useStore.getState().toolRound, 0);
});

test("Bash stays outside folded tool groups and seals the groups around it", () => {
  resetStore();
  useStore.getState().startTurn();

  for (const [id, file] of [["r1", "a.js"], ["r2", "b.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: file },
      status: "completed",
      content: textContent("file body"),
    });
  }

  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "bash-middle",
    toolKind: "execute",
    rawInput: { command: "bun test" },
    status: "in_progress",
  });
  let toolBlocks = useStore.getState().blocks.filter((block) => block.role === "tool");
  assert.equal(toolBlocks.length, 1, "starting Bash should seal the preceding group");
  assert.equal(toolBlocks[0].tool.group?.count, 2);

  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "bash-middle",
    toolKind: "execute",
    rawInput: { command: "bun test" },
    rawOutput: { stdout: "ok" },
    status: "completed",
  });

  for (const [id, file] of [["r3", "c.js"], ["r4", "d.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: file },
      status: "completed",
      content: textContent("file body"),
    });
  }
  useStore.getState().endTurn();

  toolBlocks = useStore.getState().blocks.filter((block) => block.role === "tool");
  assert.equal(toolBlocks.length, 3);
  assert.equal(toolBlocks[0].tool.group?.count, 2);
  assert.equal(toolBlocks[1].tool.label?.name, "Bash");
  assert.equal(toolBlocks[1].tool.group, undefined);
  assert.equal(toolBlocks[2].tool.group?.count, 2);
  assert.equal(
    toolBlocks.some((block) => block.tool.group?.items.some((item) => item.label?.name === "Bash")),
    false
  );
});

test("Edit preserves streamed diff data and seals folded groups around it", () => {
  resetStore();
  useStore.getState().startTurn();

  for (const [id, file] of [["r1", "a.js"], ["r2", "b.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: file },
      status: "completed",
      content: textContent("file body"),
    });
  }

  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "edit-middle",
    toolKind: "edit",
    rawInput: { path: "src/app.js" },
    status: "in_progress",
    content: [{
      type: "diff",
      path: "src/app.js",
      oldText: "const value = 1;\n",
      newText: "const value = 2;\n",
    }],
  });

  let state = useStore.getState();
  assert.equal(state.blocks.filter((block) => block.role === "tool").length, 1);
  assert.equal(state.blocks.at(-1)?.tool?.group?.count, 2);
  assert.equal(state.activeTools[0].diff?.path, "src/app.js");

  // 终态 update 可能不再重复 diff content；应保留此前流式收到的结构化 diff。
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "edit-middle",
    toolKind: "edit",
    status: "completed",
  });

  for (const [id, file] of [["r3", "c.js"], ["r4", "d.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: file },
      status: "completed",
      content: textContent("file body"),
    });
  }
  useStore.getState().endTurn();

  const toolBlocks = useStore.getState().blocks.filter((block) => block.role === "tool");
  assert.equal(toolBlocks.length, 3);
  assert.equal(toolBlocks[0].tool.group?.count, 2);
  assert.equal(toolBlocks[1].tool.label?.name, "Edit");
  assert.equal(toolBlocks[1].tool.group, undefined);
  assert.equal(toolBlocks[1].tool.diff?.path, "src/app.js");
  assert.equal(toolBlocks[1].tool.reviewItems[0].diff?.path, "src/app.js");
  assert.equal(toolBlocks[2].tool.group?.count, 2);
  assert.equal(
    toolBlocks.some((block) => block.tool.group?.items.some((item) => item.label?.name === "Edit")),
    false
  );
});

test("Edit label is a rich-tool boundary even without an edit kind", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "read-before-edit",
    name: "Read",
    rawInput: { path: "a.js" },
    status: "completed",
  });
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "edit-by-name",
    name: "Edit",
    rawInput: { path: "a.js", old_string: "a", new_string: "b" },
    status: "completed",
  });
  useStore.getState().endTurn();

  const tools = useStore.getState().blocks.filter((block) => block.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].tool.label?.name, "Read");
  assert.equal(tools[1].tool.label?.name, "Edit");
  assert.ok(tools[1].tool.diff);
});

test("transcript length accounting includes structured diff content", () => {
  resetStore();
  useStore.getState().hydrate([
    { role: "assistant", text: "x".repeat(300_000), head: true },
    {
      role: "tool",
      text: "Edit(large.txt)",
      head: true,
      tool: {
        label: { name: "Edit", args: "large.txt" },
        diff: { path: "large.txt", oldText: "y".repeat(250_000), newText: "" },
      },
    },
  ]);

  const state = useStore.getState();
  assert.equal(state.blocks.length, 1, "diff bytes should participate in transcript eviction");
  assert.equal(state.blocks[0].role, "tool");
  assert.ok(state.length > 250_000);
});

test("connected appends the banner only once per epoch", () => {
  resetStore();
  const payload = { providerName: "A", modelConfig: null, effortConfig: null, modes: null };
  useStore.getState().connected(payload);
  useStore.getState().connected(payload);
  const banners = useStore.getState().blocks.filter((b) => b.role === "banner");
  assert.equal(banners.length, 1);
});

function planBlocks() {
  return useStore.getState().blocks.filter((block) => block.role === "plan");
}

test("each changed plan snapshot finalizes one Update Todos block", () => {
  resetStore();
  useStore.getState().setPlan([{ content: "one", status: "pending" }]);
  useStore.getState().setPlan([
    { content: "one", status: "completed" },
    { content: "two", status: "in_progress" },
  ]);

  const blocks = planBlocks();
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].plan.entries, [
    { status: "completed", content: "one" },
    { status: "in_progress", content: "two" },
  ]);
  assert.ok(blocks[1].text.startsWith("Update Todos\n☒ one"));
});

test("resent identical plan snapshots are dropped", () => {
  resetStore();
  const snapshot = [{ content: "one", status: "in_progress" }];
  useStore.getState().setPlan(snapshot);
  useStore.getState().setPlan(snapshot.map((entry) => ({ ...entry })));
  assert.equal(planBlocks().length, 1);
});

test("empty plan snapshots only reset the dedupe signature", () => {
  resetStore();
  const snapshot = [{ content: "one", status: "pending" }];
  useStore.getState().setPlan(snapshot);
  useStore.getState().setPlan([]);
  assert.equal(useStore.getState().planSignature, null);
  assert.equal(planBlocks().length, 1);
  useStore.getState().setPlan(snapshot);
  assert.equal(planBlocks().length, 2);
});

test("endTurn resets the plan signature so the next turn prints again", () => {
  resetStore();
  const snapshot = [{ content: "one", status: "in_progress" }];
  useStore.getState().startTurn("prompt");
  useStore.getState().setPlan(snapshot);
  useStore.getState().endTurn();
  assert.equal(useStore.getState().planSignature, null);
  useStore.getState().startTurn("prompt");
  useStore.getState().setPlan(snapshot);
  assert.equal(planBlocks().length, 2);
});

test("plan blocks are finalized after the streaming tail to keep line order", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("正在整理待办");
  useStore.getState().setPlan([{ content: "one", status: "pending" }]);
  const roles = useStore.getState().blocks.map((block) => block.role);
  assert.deepEqual(roles, ["assistant", "plan"]);
});

test("thought chunks finalize into a Thought line before tool output", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().noteThought();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "t1",
    name: "Bash",
    rawInput: { command: "ls" },
    status: "completed",
  });
  useStore.getState().endTurn();

  const blocks = useStore.getState().blocks;
  const thoughtIndex = blocks.findIndex((b) => b.role === "thought" && /^Thought\b/.test(b.text));
  const toolIndex = blocks.findIndex((b) => b.role === "tool");
  assert.ok(thoughtIndex >= 0, "thought line should exist");
  assert.ok(toolIndex > thoughtIndex, "thought line should precede the tool line");
});

test("thought text is accumulated across chunks", () => {
  resetStore();
  useStore.getState().noteThought("first line\n");
  useStore.getState().noteThought("second line\n");
  useStore.getState().noteThought("third line\n");

  const thought = useStore.getState().thought;
  assert.equal(thought?.text, "first line\nsecond line\nthird line\n");
  assert.equal(thought?.expanded, false);
});

test("starting a new thought seals the visible tool group instead of hiding it", () => {
  resetStore();
  useStore.getState().startTurn();
  for (const [id, file] of [["r1", "a.js"], ["r2", "b.js"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId: id,
      toolKind: "read",
      rawInput: { path: file },
      status: "completed",
    });
  }
  assert.equal(useStore.getState().pendingToolGroup?.items.length, 2);

  useStore.getState().noteThought("next phase");

  assert.equal(useStore.getState().pendingToolGroup, null);
  assert.equal(useStore.getState().blocks.at(-1)?.tool?.group?.count, 2);
  assert.equal(useStore.getState().thought?.text, "next phase");
});

test("thought text is truncated when exceeding 50KB limit", () => {
  resetStore();
  const largeText = "x".repeat(30_000);
  useStore.getState().noteThought(largeText);
  useStore.getState().noteThought(largeText);

  const thought = useStore.getState().thought;
  assert.ok(thought?.text.length <= 50_000, "thought text should be capped at 50KB");
  assert.ok(thought?.text.length > 0, "truncated text should still have content");
});

test("flushThought writes a semantic, compact history block", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().noteThought("**Inspecting state**\n\nthinking text\nshould not appear\n");
  useStore.getState().appendChunk("answer");

  const blocks = useStore.getState().blocks;
  const thoughtLine = blocks.find((b) => b.role === "thought" && /^Thought: Inspecting state\b/.test(b.text));
  assert.ok(thoughtLine, "thought summary should exist");
  assert.ok(!thoughtLine.text.includes("thinking text"), "thought text should not be in summary");
  // 不足 1 秒的思考不带计时，更不能留下 “ · 0s” 这种噪声。
  assert.doesNotMatch(thoughtLine.text, /0s/, "zero-second duration must not be rendered");
  assert.equal(thoughtLine.thought.text, "**Inspecting state**\n\nthinking text\nshould not appear\n");
  assert.equal(thoughtLine.thought.title, "Inspecting state");
  assert.equal(thoughtLine.thought.displayMode, "compact");
  assert.equal(thoughtLine.thought.hasContent, true);
  assert.ok(thoughtLine.thought.durationMs >= 0);
});

test("thinking display controls the current preview and finalized block", () => {
  resetStore();
  useStore.getState().setThinkingDisplay("full");
  useStore.getState().noteThought("details");
  assert.equal(useStore.getState().thought.expanded, true);
  useStore.getState().appendChunk("answer");
  assert.equal(useStore.getState().blocks.find((block) => block.role === "thought").thought.displayMode, "full");
});

test("thinking timer excludes pauses", () => {
  resetStore();
  useStore.getState().noteThought("details");
  const startedAt = useStore.getState().thought.startedAt;
  useStore.getState().setThoughtPaused(true, startedAt + 1000);
  useStore.getState().setThoughtPaused(false, startedAt + 4000);
  useStore.getState().appendChunk("answer");
  const thought = useStore.getState().blocks.find((block) => block.role === "thought").thought;
  assert.ok(thought.durationMs < 1500, `pause leaked into duration: ${thought.durationMs}`);
});

test("thinking timer stops while the request is still in flight", () => {
  resetStore();
  // 模型想了 600ms 就收流，随后是几秒的请求等待（写工具参数、重发、等正文）——
  // 那段等待不该出现在 Thought 行的耗时里。
  useStore.getState().noteThought("first", 10_000);
  useStore.getState().noteThought("second", 10_600);
  useStore.getState().appendChunk("answer");
  const thought = useStore.getState().blocks.find((block) => block.role === "thought").thought;
  assert.ok(thought.durationMs >= 600, `thinking itself should be credited: ${thought.durationMs}`);
  assert.ok(thought.durationMs <= 1600, `request wait leaked into duration: ${thought.durationMs}`);
});

test("endTurn appends a Done line for productive prompt turns", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("hello world\n\n");
  useStore.getState().endTurn();
  // 计时不是断言对象：不足 1 秒只有 “Done”，跨过一秒才是 “Done in 3s”。
  const done = useStore.getState().blocks.find((b) => /^Done\b/.test(b.text ?? ""));
  assert.ok(done, "Done line should be appended");
  assert.doesNotMatch(done.text, /0s/, "zero-second duration must not be rendered");

  // 无产出回合不打 Done 行。
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().endTurn();
  const done2 = useStore.getState().blocks.find((b) => /^Done\b/.test(b.text ?? ""));
  assert.equal(done2, undefined);
});

test("cancelled turns record an interruption instead of a Done line", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("partial answer\n\n");
  useStore.getState().setCancelling(true);
  useStore.getState().endTurn();
  const blocks = useStore.getState().blocks;
  assert.ok(blocks.some((b) => b.role === "error" && b.text === "Interrupted by user"));
  assert.ok(!blocks.some((b) => /^Done\b/.test(b.text ?? "")));
});

test("endTurn accepts an explicit cancellation result", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("partial answer\n\n");
  useStore.getState().endTurn({ stopReason: "cancelled" });

  const blocks = useStore.getState().blocks;
  assert.ok(blocks.some((block) => block.role === "error" && block.text === "Interrupted by user"));
  assert.ok(!blocks.some((block) => /^Done\b/.test(block.text ?? "")));
});

test("a turn that exhausts the tool-call round limit leaves a visible notice instead of looking like a normal finish", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("halfway there\n\n");
  useStore.getState().endTurn({ stopReason: "max_turns" });

  const blocks = useStore.getState().blocks;
  assert.ok(blocks.some((block) => block.role === "error" && /round limit/.test(block.text ?? "")));
  // 提示之外仍然收尾：被截住不等于回合没跑过。
  assert.ok(blocks.some((block) => /^Done\b/.test(block.text ?? "")));
});

test("a turn cut off by the output token limit says why", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("cut off mid-\n\n");
  useStore.getState().endTurn({ stopReason: "max_tokens" });

  assert.ok(
    useStore.getState().blocks.some((block) => block.role === "error" && /output token limit/.test(block.text ?? "")),
  );
});

test("a turn that says nothing leaves a visible notice instead of a bare Done line", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "t1",
    title: "Bash",
    toolKind: "execute",
    status: "completed",
  });
  useStore.getState().endTurn({ stopReason: "empty_response" });

  assert.ok(
    useStore.getState().blocks.some((block) => block.role === "error" && /empty reply/.test(block.text ?? "")),
  );
});

test("a turn that ends normally adds no abnormal notice", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().appendChunk("all done\n\n");
  useStore.getState().endTurn({ stopReason: "end_turn" });

  assert.equal(useStore.getState().blocks.some((block) => block.role === "error"), false);
});

test("cancelled endTurn finalizes pending and in-progress active tools as cancelled", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  for (const [toolCallId, status] of [["pending-tool", "pending"], ["running-tool", "in_progress"]]) {
    useStore.getState().upsertTool({
      kind: "tool_call",
      toolCallId,
      toolKind: "read",
      rawInput: { path: `${toolCallId}.txt` },
      status,
    });
  }

  useStore.getState().endTurn({ cancelled: true });

  const state = useStore.getState();
  assert.deepEqual(state.activeTools, []);
  const toolItems = state.blocks
    .filter((block) => block.role === "tool")
    .flatMap((block) => block.tool.reviewItems ?? []);
  assert.deepEqual(toolItems.map((item) => item.status), ["cancelled", "cancelled"]);
});

test("an Auto safety review verdict reaches the tool block, reason included", () => {
  resetStore();
  useStore.getState().startTurn("prompt");
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "t-auto",
    title: "Bash",
    toolKind: "execute",
    rawInput: { command: "rm -rf /tmp/x" },
    status: "pending",
  });
  const autoReview = { toolCallId: "t-auto", status: "blocked", action: "Bash", reason: "目标在工作区之外" };
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "t-auto",
    status: "cancelled",
    autoReview,
  });
  useStore.getState().endTurn({ cancelled: true });

  // 阻断的说明只挂在块上：这里丢了，工具行下面就没有任何解释。
  const block = useStore.getState().blocks.find((entry) => entry.role === "tool");
  assert.equal(block.tool.autoReview.reason, "目标在工作区之外");
  assert.equal(block.tool.reviewItems[0].autoReview.reason, "目标在工作区之外");
});

test("queued inputs preserve FIFO order", () => {
  resetStore();
  useStore.getState().queueInput("first");
  useStore.getState().queueInput("second");
  assert.deepEqual(useStore.getState().takeQueuedInput(), { text: "first", display: null });
  assert.deepEqual(useStore.getState().takeQueuedInput(), { text: "second", display: null });
  assert.equal(useStore.getState().takeQueuedInput(), null);
});

test("queued inputs keep the paste-collapsed display text", () => {
  resetStore();
  useStore.getState().queueInput("full pasted body", "[Pasted text #1 +42 lines]");
  assert.deepEqual(useStore.getState().takeQueuedInput(), {
    text: "full pasted body",
    display: "[Pasted text #1 +42 lines]",
  });
});

test("replaceQueuedInputs replaces and strictly normalizes restored items", () => {
  resetStore();
  useStore.getState().queueInput("stale");
  useStore.getState().replaceQueuedInputs([
    { text: "restored", display: "collapsed", ignored: true },
    { text: "plain", display: undefined },
    { text: 42, display: false },
    null,
  ]);

  assert.deepEqual(useStore.getState().queuedInputs, [
    { text: "restored", display: "collapsed" },
    { text: "plain", display: null },
    { text: "", display: null },
    { text: "", display: null },
  ]);

  useStore.getState().replaceQueuedInputs(null);
  assert.deepEqual(useStore.getState().queuedInputs, []);
});

test("queued inputs can be edited, reordered, removed, and cleared", () => {
  resetStore();
  useStore.getState().queueInput("first");
  useStore.getState().queueInput("second", "collapsed");
  useStore.getState().updateQueuedInput(1, "edited");
  assert.deepEqual(useStore.getState().queuedInputs[1], { text: "edited", display: null });

  useStore.getState().moveQueuedInput(1, -1);
  assert.deepEqual(useStore.getState().queuedInputs.map((item) => item.text), ["edited", "first"]);
  useStore.getState().removeQueuedInput(1);
  assert.deepEqual(useStore.getState().queuedInputs.map((item) => item.text), ["edited"]);
  useStore.getState().clearQueuedInputs();
  assert.equal(useStore.getState().queuedInputs.length, 0);
});

test("finalized tool ids still drop re-sent updates", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "t1",
    name: "Bash",
    rawInput: { command: "ls" },
    status: "completed",
  });
  const blockCount = useStore.getState().blocks.length;
  // 终态后重发的 update 应被丢弃，不产生新块。
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: textContent("late output"),
  });
  useStore.getState().endTurn();
  const toolBlocks = useStore.getState().blocks.filter((b) => b.role === "tool");
  assert.equal(toolBlocks.length, 1);
  assert.ok(useStore.getState().blocks.length >= blockCount);
});

test("hydrate replays saved blocks in order and skips banners", () => {
  resetStore();
  useStore.getState().hydrate([
    { role: "banner", text: "", head: true },
    { role: "user", text: "hello", head: true },
    { role: "assistant", text: "world", head: true },
    { role: "tool", text: "Bash(ls)", head: true, tool: { label: { name: "Bash", args: "ls" }, status: "completed" } },
  ]);
  const blocks = useStore.getState().blocks;
  assert.equal(blocks.filter((b) => b.role === "banner").length, 0);
  assert.deepEqual(
    blocks.map((b) => b.role),
    ["user", "assistant", "tool"]
  );
  assert.equal(blocks[0].text, "hello");
});

test("hydrate does not write replayed blocks back to the recorder", () => {
  resetStore();
  const recorded = [];
  setRecorder({ recordBlock: (block) => recorded.push(block) });
  try {
    useStore.getState().hydrate([{ role: "user", text: "old message", head: true }]);
    assert.equal(recorded.length, 0, "hydrate must not re-record history");
    useStore.getState().push("user", "new message");
    assert.equal(recorded.length, 1, "new blocks still go through the recorder");
    assert.equal(recorded[0].text, "new message");
  } finally {
    setRecorder(null);
  }
});

test("bash card lifecycle: start → finish → flush on next push", () => {
  resetStore();
  const store = useStore.getState();
  store.startBashCard("lscpu");
  assert.equal(useStore.getState().bashCard.status, "running");

  const stdout = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
  useStore.getState().finishBashCard({
    stdout,
    stderr: "",
    outcome: { type: "exited", code: 0 },
  });
  const card = useStore.getState().bashCard;
  assert.equal(card.status, "done");
  assert.equal(card.lines.length, 45);

  // 下一条内容到来时定稿：只保留开头 20 行，hidden=25；全量输出不再进 transcript，
  // 只能经 ctrl+o 的 Review 窗口在实时阶段查看。
  useStore.getState().push("user", "next input");
  assert.equal(useStore.getState().bashCard, null);
  const cardBlocks = useStore.getState().blocks.filter((b) => b.role === "bashCard");
  assert.equal(cardBlocks.length, 1);
  assert.equal(cardBlocks[0].card.hidden, 25);
  assert.equal(cardBlocks[0].card.lines.length, 20);
  assert.equal(cardBlocks[0].card.lines[0].text, "line 1");
  assert.equal(cardBlocks[0].card.lines.at(-1).text, "line 20");
});

test("empty bash output gets placeholder", () => {
  resetStore();
  useStore.getState().startBashCard("sleep 1");

  useStore.getState().finishBashCard({
    stdout: "",
    stderr: "",
    outcome: { type: "exited", code: 0 },
  });
  const card = useStore.getState().bashCard;
  assert.deepEqual(card.lines, [{ text: "(No output)", err: false }]);
  assert.deepEqual(card.outcome, { type: "exited", code: 0 });
});

test("connectionFailed stays interactive; reconnecting drops the stale fatal error", () => {
  resetStore();
  useStore.setState({
    fatalError: new Error("agent exited (code 3)"),
    switching: "x",
    busy: true,
    providerCommands: [{ name: "compact", description: "Compact context" }],
  });

  useStore.getState().connectionFailed();
  let state = useStore.getState();
  assert.equal(state.status, "failed");
  assert.equal(state.switching, null, "the composer/picker must not stay disabled in a transient state");
  assert.equal(state.busy, false);
  assert.ok(state.fatalError, "choosing exit instead of retry must still exit with a non-zero code");

  useStore.getState().reconnecting();
  state = useStore.getState();
  assert.equal(state.status, "connecting");
  assert.equal(state.fatalError, null, "a successful reconnect must not exit with the previous error");
  assert.deepEqual(state.providerCommands, [], "the previous provider's commands must not stay in `/` completion");
});

test("fenced code block with blank lines stays in one block", () => {
  resetStore();
  useStore.getState().startTurn();
  const md = "Intro paragraph.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro.";
  for (const piece of md.match(/[\s\S]{1,7}/g)) {
    useStore.getState().appendChunk(piece, "m1");
  }
  useStore.getState().endTurn();

  const texts = useStore
    .getState()
    .blocks.filter((b) => b.role === "assistant")
    .map((b) => b.text);
  const fenced = texts.find((t) => t.includes("```"));
  assert.ok(fenced, "code block should be finalized");
  assert.ok(
    fenced.includes("const a = 1;") && fenced.includes("const b = 2;") && fenced.match(/```/g).length === 2,
    `fence must stay closed within a single block: ${JSON.stringify(texts)}`
  );
});

test("long unclosed fence is not line-split by the safety valve", () => {
  resetStore();
  useStore.getState().startTurn();
  const lines = Array.from({ length: 20 }, (_, i) => `const line${i} = ${i}; // padding padding`);
  useStore.getState().appendChunk("```js\n" + lines.join("\n"), "m1");
  assert.equal(useStore.getState().blocks.filter((b) => b.role === "assistant").length, 0);

  useStore.getState().appendChunk("\n```\n\nDone.", "m1");
  useStore.getState().endTurn();
  const fenced = useStore
    .getState()
    .blocks.filter((b) => b.role === "assistant")
    .map((b) => b.text)
    .find((t) => t.includes("```"));
  assert.ok(fenced.includes("line0") && fenced.includes("line19"), "fence body must stay whole");
});

test("long markdown table is not line-split by the safety valve", () => {
  // 表头与 `| --- |` 分隔行只出现在第一段：一旦按行切开，后续碎片会被
  // Message.jsx 当成独立 markdown 文档，marked 认不出表格、只吐原始竖线。
  resetStore();
  useStore.getState().startTurn();
  const rows = [
    "| 编号 | 键名 | 值（含标点） | 说明 |",
    "| --- | --- | --- | --- |",
    "| 1 | `greeting` | `你好，世界！` | 含中文逗号与叹号 |",
    "| 2 | `path` | `/usr/local/bin:/opt/bin` | 冒号分隔的路径列表 |",
    "| 3 | `regex` | `^\\d{3}-\\d{4}$` | 含 `^`、`$`、`{}`、`-` |",
    "| 4 | `quote` | `He said: \"it's fine.\"` | 双引号、单引号、句点 |",
    "| 5 | `csv_cell` | `a,b;c\\|d` | 逗号、分号、竖线（表格内需转义） |",
    "| 6 | `url` | `https://example.com/q?x=1&y=2#top` | `?`、`&`、`#` |",
    "| 7 | `money` | `¥1,299.00 (含税)` | 货币符、千分位、括号 |",
    "| 8 | `json` | `{\"k\": [1, 2], \"ok\": true}` | 花括号、方括号、冒号 |",
  ];
  const md = `${rows.join("\n")}\n\n收尾说明，表格之后的普通段落。`;
  assert.ok(md.length > 300, "the fixture must exceed STREAM_BLOCK_MAX_CHARS to trigger line-based splitting");
  for (const piece of md.match(/[\s\S]{1,7}/g)) {
    useStore.getState().appendChunk(piece, "m1");
  }
  useStore.getState().endTurn();

  const texts = useStore
    .getState()
    .blocks.filter((b) => b.role === "assistant")
    .map((b) => b.text);
  const tables = texts.filter((t) => t.includes("| --- |"));
  assert.equal(tables.length, 1, `the table must be finalized as one block: ${JSON.stringify(texts)}`);
  for (const row of rows) {
    assert.ok(tables[0].includes(row), `a table row must not land in another block: ${row}`);
  }
  assert.ok(
    texts.some((t) => t.includes("收尾说明") && !t.includes("| --- |")),
    "plain paragraphs after the table are still split on blank lines"
  );
});

test("blank-line separated prose still splits so the safety valve stays alive", () => {
  // 防止「不切表格」被写成「什么都不切」：普通长正文必须照旧按行定稿。
  resetStore();
  useStore.getState().startTurn();
  const prose = Array.from(
    { length: 12 },
    (_, i) => `这是第 ${i} 行普通叙述，带一些填充文字用来把长度撑过阈值。`
  ).join("\n");
  for (const piece of prose.match(/[\s\S]{1,7}/g)) {
    useStore.getState().appendChunk(piece, "m1");
  }
  useStore.getState().endTurn();
  const count = useStore.getState().blocks.filter((b) => b.role === "assistant").length;
  assert.ok(count > 1, `long plain prose should still split into several blocks, got ${count}`);
});

function subagentSnapshot(events) {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

function subagentContent(text) {
  return [{ type: "content", content: { type: "text", text } }];
}

const SPAWN_RAW_INPUT = {
  tool_call_name: "spawn_agent",
  sub_content: "worker-1",
  model: "gpt-4o",
  effort: "high",
  message: "Write a hello world script.\n\nUse JavaScript.",
};

test("subagent survives premature completed updates and finalizes on RUN_FINISHED", () => {
  resetStore();
  useStore.getState().startTurn();

  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "sub1",
    title: "子智能体",
    status: "in_progress",
    isSubagent: true,
  });

  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "sub1",
    status: "in_progress",
    rawInput: SPAWN_RAW_INPUT,
    isSubagent: true,
  });

  const midEvents = [
    { type: "RUN_STARTED", rawEvent: {} },
    {
      type: "TOOL_CALL_START",
      rawEvent: { tool_call_id: "w1", name: "write_to_file" },
      toolCallId: "w1",
      toolCallName: "write_to_file",
    },
    {
      type: "TOOL_CALL_ARGS",
      rawEvent: { tool_call_id: "w1", patchs: [{ op: "add", path: "/file_path", value: "/tmp/hello.js" }] },
      toolCallId: "w1",
    },
  ];
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "sub1",
    status: "completed",
    rawInput: SPAWN_RAW_INPUT,
    content: subagentContent(subagentSnapshot(midEvents)),
    isSubagent: true,
  });

  let state = useStore.getState();
  assert.equal(state.activeTools.length, 1, "a premature completed must not finalize the tool");
  assert.equal(state.finalizedToolIds.has("sub1"), false);
  const active = state.activeTools[0];
  assert.equal(active.status, "in_progress");
  assert.equal(active.label.name, "worker-1");
  assert.equal(active.subagent.tools.length, 1);
  assert.equal(active.subagent.tools[0].args, "/tmp/hello.js");

  const finalEvents = [
    ...midEvents,
    {
      type: "TOOL_CALL_RESULT",
      rawEvent: { tool_call_id: "w1" },
      toolCallId: "w1",
      content: "File written successfully.",
    },
    {
      type: "STEP_FINISHED",
      rawEvent: { step_name: "call_llm", token_usage: { total_tokens: 16251 } },
    },
    { type: "TEXT_MESSAGE_CONTENT", rawEvent: { content: "Created the file." }, delta: "Created the file." },
    { type: "RUN_FINISHED", rawEvent: {} },
  ];
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "sub1",
    status: "completed",
    rawInput: SPAWN_RAW_INPUT,
    content: subagentContent(subagentSnapshot(finalEvents)),
    isSubagent: true,
  });
  useStore.getState().endTurn();

  state = useStore.getState();
  const toolBlocks = state.blocks.filter((b) => b.role === "tool");
  assert.equal(toolBlocks.length, 1, "the subagent finalizes exactly once");
  const tool = toolBlocks[0].tool;
  assert.equal(tool.status, "completed");
  assert.equal(tool.label.name, "worker-1");
  assert.equal(tool.label.args, "Write a hello world script.");
  assert.ok(tool.subagent, "the finalized block carries the subagent state");
  assert.equal(tool.subagent.runFinished, true);
  assert.equal(tool.subagent.tokens, 16251);
  assert.equal(tool.subagent.text, "Created the file.");
  assert.equal(tool.subagent.request.description, "worker-1");
  assert.equal(tool.subagent.request.message, SPAWN_RAW_INPUT.message);
  assert.equal(tool.subagent.request.model, "gpt-4o");
  assert.equal(tool.subagent.request.effort, "high");
  assert.equal(tool.subagent.tools[0].result, "File written successfully.");
  assert.equal(tool.preview, null, "a subagent produces no raw JSON text preview");
});

test("subagent without RUN_FINISHED is flushed at end of turn", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "sub2",
    title: "子智能体",
    status: "in_progress",
    isSubagent: true,
  });
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "sub2",
    status: "completed",
    rawInput: SPAWN_RAW_INPUT,
    content: subagentContent(subagentSnapshot([{ type: "RUN_STARTED", rawEvent: {} }])),
    isSubagent: true,
  });
  assert.equal(useStore.getState().activeTools.length, 1);

  useStore.getState().endTurn();
  const state = useStore.getState();
  assert.equal(state.activeTools.length, 0);
  const toolBlocks = state.blocks.filter((b) => b.role === "tool");
  assert.equal(toolBlocks.length, 1, "turn end finalizes a subagent left unfinished");
  assert.equal(toolBlocks[0].tool.subagent.runFinished, false);
});

test("complete ACP diff is not downgraded by later streamed raw-input updates", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "edit-1",
    toolKind: "edit",
    rawInput: { path: "src/app.js" },
    status: "in_progress",
    content: [{
      type: "diff",
      path: "src/app.js",
      oldText: "const value = 1;\n",
      newText: "const value = 2;\n",
    }],
  });
  assert.equal(useStore.getState().activeTools[0].diff?.complete, true);

  // 后到的流式 rawInput 半成品（new_string 前缀）不能把权威 diff 顶掉。
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "edit-1",
    toolKind: "edit",
    status: "in_progress",
    rawInput: { path: "src/app.js", old_string: "const value = 1;\n", new_string: "const va" },
  });

  const diff = useStore.getState().activeTools[0].diff;
  assert.equal(diff?.complete, true, "complete diff must survive incomplete updates");
  assert.equal(diff?.newText, "const value = 2;\n");
  useStore.getState().endTurn();
});

test("streamed raw-input diff stays incomplete until finalized", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "edit-2",
    toolKind: "edit",
    rawInput: { path: "src/app.js", old_string: "alpha\n", new_string: "al" },
    status: "in_progress",
  });
  assert.equal(useStore.getState().activeTools[0].diff?.complete, false);

  // 更长的流式前缀正常替换旧的半成品。
  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "edit-2",
    toolKind: "edit",
    status: "in_progress",
    rawInput: { path: "src/app.js", old_string: "alpha\n", new_string: "alpha changed\n" },
  });
  const streaming = useStore.getState().activeTools[0].diff;
  assert.equal(streaming?.complete, false);
  assert.equal(streaming?.newText, "alpha changed\n");

  useStore.getState().upsertTool({
    kind: "tool_call_update",
    toolCallId: "edit-2",
    toolKind: "edit",
    status: "completed",
  });
  useStore.getState().endTurn();

  const toolBlock = useStore.getState().blocks.find(
    (block) => block.role === "tool" && block.tool?.label?.name === "Edit"
  );
  assert.equal(toolBlock.tool.diff?.complete, true, "finalized diff must be marked complete");
  assert.equal(toolBlock.tool.diff?.newText, "alpha changed\n");
});

test("tools flushed at end of turn still expose a complete diff in history", () => {
  resetStore();
  useStore.getState().startTurn();
  useStore.getState().upsertTool({
    kind: "tool_call",
    toolCallId: "edit-3",
    toolKind: "edit",
    rawInput: { path: "src/app.js", old_string: "one\n", new_string: "two\n" },
    status: "in_progress",
  });
  // 回合结束兜底冲刷：工具从未收到终态 update。
  useStore.getState().endTurn();

  const toolBlock = useStore.getState().blocks.find(
    (block) => block.role === "tool" && block.tool?.label?.name === "Edit"
  );
  assert.ok(toolBlock, "flushed edit should land in history");
  assert.equal(toolBlock.tool.diff?.complete, true);
});
