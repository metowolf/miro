import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Plan mode state persists independently from visible blocks", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "miro-session-plan-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { SessionRecorder, loadSessionBlocks } from "./src/session-store.js";
      const cwd = "/work/example";
      const recorder = new SessionRecorder({ sessionId: "plan-session", providerId: "miro", cwd });
      recorder.recordBlock({ role: "user", text: "plan this" });
      recorder.recordPlanModeState({ mode: "plan", planId: "p1", planPath: "/tmp/p1.md" });
      recorder.recordPlanModeState({ mode: "default", planId: null, planPath: null });
      const loaded = loadSessionBlocks("plan-session", cwd, "miro");
      assert.deepEqual(loaded.planModeState, { mode: "default", planId: null, planPath: null });
      assert.deepEqual(loaded.blocks, [{ role: "user", text: "plan this" }]);
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ACP raw traffic and ACP/miro visible sessions use separate subdirectories", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "miro-session-layout-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      import { SessionRecorder, listSessions, loadSessionBlocks } from "./src/session-store.js";
      import { AcpSessionRecorder, sessionLogPath } from "./src/acp/session-recorder.js";

      const cwd = "/work/example";
      const acpId = "acp-session";
      const raw = new AcpSessionRecorder({ cwd });
      raw.record("client", { jsonrpc: "2.0", method: "initialize" });
      await raw.start(acpId);
      await raw.close();

      const acp = new SessionRecorder({ sessionId: acpId, providerId: "acp-agent", cwd });
      acp.recordBlock({ role: "user", text: "ACP session" });
      const miro = new SessionRecorder({ sessionId: "miro-session", providerId: "miro", cwd });
      miro.recordBlock({ role: "user", text: "Miro session" });

      assert.equal(path.basename(path.dirname(acp.file)), "acp");
      assert.equal(path.basename(path.dirname(miro.file)), "miro");
      assert.equal(path.basename(path.dirname(sessionLogPath(cwd, acpId))), "raw");
      assert.equal(path.basename(path.dirname(path.dirname(sessionLogPath(cwd, acpId)))), "acp");
      assert.notEqual(acp.file, sessionLogPath(cwd, acpId));
      assert.equal(JSON.parse(readFileSync(acp.file, "utf8").split("\n")[0]).type, "meta");
      assert.equal(loadSessionBlocks(acpId, cwd).meta.providerId, "acp-agent");
      assert.deepEqual(
        new Set(listSessions(cwd).map((session) => session.sessionId)),
        new Set([acpId, "miro-session"]),
      );

      // 同一个 sessionId 被两个 provider 各写一份：两边是独立历史，各自可读、各自列出。
      const shared = "shared-session";
      const sharedAcp = new SessionRecorder({ sessionId: shared, providerId: "acp-agent", cwd });
      sharedAcp.recordBlock({ role: "user", text: "ACP 那份" });
      const sharedMiro = new SessionRecorder({ sessionId: shared, providerId: "miro", cwd });
      sharedMiro.recordBlock({ role: "user", text: "miro 那份" });

      assert.notEqual(sharedAcp.file, sharedMiro.file);
      assert.equal(loadSessionBlocks(shared, cwd, "acp-agent").blocks[0].text, "ACP 那份");
      assert.equal(loadSessionBlocks(shared, cwd, "miro").blocks[0].text, "miro 那份");
      assert.deepEqual(
        new Set(
          listSessions(cwd)
            .filter((session) => session.sessionId === shared)
            .map((session) => session.providerId),
        ),
        new Set(["miro", "acp-agent"]),
      );
      assert.deepEqual(
        listSessions(cwd, "miro").map((session) => session.providerId),
        ["miro", "miro"],
        "provider-scoped session lists never cross into ACP histories",
      );
      assert.deepEqual(
        new Set(listSessions(cwd, "acp-agent").map((session) => session.providerId)),
        new Set(["acp-agent"]),
        "an ACP startup sees only its own provider id",
      );

      // 破坏性布局变更后，项目根目录下的旧 transcript 一律忽略。
      const projectRoot = path.dirname(path.dirname(acp.file));
      copyFileSync(sharedMiro.file, path.join(projectRoot, shared + ".jsonl"));
      const legacyId = "legacy-only";
      writeFileSync(
        path.join(projectRoot, legacyId + ".jsonl"),
        JSON.stringify({ type: "meta", sessionId: legacyId, providerId: "acp-agent", createdAt: 1 }) +
          "\n" +
          JSON.stringify({ type: "block", block: { role: "user", text: "旧布局会话" } }) +
          "\n",
        "utf8",
      );

      assert.equal(
        listSessions(cwd).filter((session) => session.sessionId === shared).length,
        2,
        "the root copy is ignored",
      );
      assert.equal(
        listSessions(cwd).filter((session) => session.sessionId === legacyId).length,
        0,
        "a root-only legacy session is ignored",
      );
      assert.equal(loadSessionBlocks(legacyId, cwd), null);
      assert.equal(loadSessionBlocks(legacyId, cwd, "acp-agent"), null);
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tool blocks are persisted without the duplicated reviewItems/preview and load back identical", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "miro-session-dedup-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      import { SessionRecorder, loadSessionBlocks } from "./src/session-store.js";

      const cwd = "/work/example";
      const output = [
        "total 48",
        "drwxr-xr-x  9 root root 4096 Jan  1 00:00 .",
        "-rw-r--r--  1 root root  128 Jan  1 00:00 a.js",
        "-rw-r--r--  1 root root  256 Jan  1 00:00 b.js",
      ].join("\n");
      const detail = {
        kind: "execute",
        title: "Bash",
        input: JSON.stringify({ command: "ls -la", path: "/work/example" }, null, 2),
        output,
        locations: "",
      };
      // store.js toolFromGroup() 的单工具形态：顶层是 items[0] 的拷贝，只有 kind 不在顶层。
      // finalizeTool() 会给每个 item 补上 autoReview（没有审查时是 null），单一工具块
      // 因此也带着这个键，缺了它瘦身会因为字段对不上而整份落盘。
      const fields = {
        label: { name: "Bash", args: "ls -la" },
        status: "completed",
        elapsed: 12,
        preview: { lines: ["total 48", "drwxr-xr-x  9 root root 4096 Jan  1 00:00 ."], more: 2 },
        command: "ls -la",
        subagent: null,
        detail,
        diff: null,
        autoReview: null,
      };
      const bashBlock = {
        role: "tool",
        head: true,
        text: "Bash(ls -la)",
        tool: { ...fields, hint: null, reviewItems: [{ ...fields, kind: "execute" }] },
      };

      // 预览末行被截断（带 …）或 more 对不上输出行数：不推导 preview，但仍删 reviewItems。
      const truncatedBlock = {
        role: "tool",
        head: true,
        text: "Bash(cat big.log)",
        tool: {
          ...fields,
          preview: { lines: ["total 48", "drwxr-xr-x  9 root root 4096 Jan  1 00:0…"], more: 2 },
          hint: null,
          reviewItems: [{ ...fields, kind: "execute", preview: { lines: ["total 48", "drwxr-xr-x  9 root root 4096 Jan  1 00:0…"], more: 2 } }],
        },
      };
      const mismatchBlock = {
        ...truncatedBlock,
        text: "Bash(stat .)",
        tool: {
          ...fields,
          preview: { lines: ["total 48"], more: 99 },
          hint: null,
          reviewItems: [{ ...fields, kind: "execute", preview: { lines: ["total 48"], more: 99 } }],
        },
      };

      // 多工具组：group.items 与 reviewItems 内容相同但不是同一引用。
      const groupItems = [
        { ...fields, kind: "read" },
        { ...fields, kind: "read", label: { name: "Read", args: "b.js" } },
      ];
      const groupBlock = {
        role: "tool",
        head: true,
        text: "2 tool calls · 2 reads",
        tool: {
          group: { name: "2 tool calls", summary: "2 reads", count: 2, items: groupItems },
          status: "completed",
          hint: null,
          elapsed: 30,
          reviewItems: groupItems.map((item) => ({ ...item })),
        },
      };

      // Auto 审查结论挂在块上：被阻断的理由只在块里，瘦身时丢了就再也看不到。
      const autoReview = { toolCallId: "call-auto", status: "blocked", action: "Bash", reason: "目标在工作区之外" };
      const blockedBlock = {
        role: "tool",
        head: true,
        text: "Bash(rm -rf /tmp/x)",
        tool: {
          ...fields,
          autoReview,
          hint: null,
          reviewItems: [{ ...fields, kind: "execute", autoReview }],
        },
      };

      const blocks = [bashBlock, truncatedBlock, mismatchBlock, groupBlock, blockedBlock];
      const recorder = new SessionRecorder({ sessionId: "dedup", providerId: "acp-agent", cwd });
      recorder.recordBlock({ role: "user", text: "跑几条命令" });
      for (const block of blocks) recorder.recordBlock(block);

      const lines = readFileSync(recorder.file, "utf8").trim().split("\n");
      const rows = lines.map((line) => JSON.parse(line));
      const blockRows = rows.filter((row) => row.type === "block");
      assert.equal(blockRows[1].v, 2, "every block record carries the new version");
      assert.equal(
        lines.slice(1).some((line) => line.includes("reviewItems")),
        false,
        "the duplicated reviewItems never reaches the file",
      );

      const persistedBash = blockRows[1].block.tool;
      assert.equal(persistedBash.reviewItems, undefined);
      assert.equal(persistedBash.kind, "execute", "the item kind moves to the top level for the round trip");
      assert.equal(persistedBash.previewFromOutput, 2, "a derivable preview is stored as a line count");
      assert.equal(persistedBash.preview, undefined);
      assert.ok(
        JSON.stringify(blockRows[1].block).length < JSON.stringify(bashBlock).length * 0.6,
        "a single-tool block loses at least 40% of its bytes",
      );
      assert.ok(blockRows[2].block.tool.preview, "a truncated preview is kept verbatim");
      assert.equal(blockRows[2].block.tool.previewFromOutput, undefined);
      assert.ok(blockRows[3].block.tool.preview, "a preview whose more does not match the output is kept verbatim");
      assert.ok(blockRows[4].block.tool.group.items.length === 2, "the group keeps its items");
      assert.equal(blockRows[4].block.tool.reviewItems, undefined);
      assert.deepEqual(
        blockRows[5].block.tool.autoReview,
        autoReview,
        "the Auto review verdict, reason included, survives slimming",
      );
      assert.equal(blockRows[5].block.tool.reviewItems, undefined);

      const loaded = loadSessionBlocks("dedup", cwd, "acp-agent");
      for (const [index, block] of blocks.entries()) {
        assert.deepEqual(loaded.blocks[index + 1], block, "block " + index + " round-trips byte for byte");
      }
      assert.deepEqual(
        loaded.blocks[4].tool.reviewItems.map((item) => item.label.name),
        ["Bash", "Read"],
        "a group block rebuilds reviewItems from group.items",
      );

      // 旧格式（无 v 标记、带全量字段）照旧原样读出。
      const legacyBlock = {
        role: "tool",
        head: true,
        text: "Bash(ls)",
        tool: { ...fields, hint: null, reviewItems: [{ ...fields, kind: "execute" }] },
      };
      const legacy = new SessionRecorder({ sessionId: "legacy", providerId: "acp-agent", cwd });
      mkdirSync(path.dirname(legacy.file), { recursive: true });
      writeFileSync(
        legacy.file,
        [
          JSON.stringify({ type: "meta", sessionId: "legacy", providerId: "acp-agent", cwd, createdAt: 1 }),
          JSON.stringify({ type: "block", at: 1, block: legacyBlock }),
        ].join("\n") + "\n",
        "utf8",
      );
      assert.deepEqual(
        loadSessionBlocks("legacy", cwd, "acp-agent").blocks,
        [legacyBlock],
        "a legacy row keeps its full shape",
      );
      // 旧文件里追加新格式记录：两种形态共存，各自读出自己的那份。
      const appended = new SessionRecorder({ sessionId: "legacy", providerId: "acp-agent", cwd });
      appended.recordBlock(bashBlock);
      const mixedLines = readFileSync(appended.file, "utf8").trim().split("\n");
      assert.equal(mixedLines.length, 3, "the legacy rows stay untouched while a v2 row is appended");
      assert.equal(mixedLines[0], JSON.stringify({ type: "meta", sessionId: "legacy", providerId: "acp-agent", cwd, createdAt: 1 }));
      assert.equal(mixedLines[1], JSON.stringify({ type: "block", at: 1, block: legacyBlock }));
      assert.equal(JSON.parse(mixedLines[2]).v, 2);
      const mixed = loadSessionBlocks("legacy", cwd, "acp-agent").blocks;
      assert.deepEqual(mixed[0], legacyBlock, "the legacy row is still read as-is");
      assert.deepEqual(mixed[1], bashBlock, "the appended v2 row is inflated");
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("adjacent identical ui_state checkpoints are written once", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "miro-session-uistate-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { existsSync, readFileSync } from "node:fs";
      import { SessionRecorder, loadSessionBlocks } from "./src/session-store.js";

      const cwd = "/work/example";
      const draft = (value) => ({
        composer: { value, cursor: value.length, pastes: [], nextPasteId: 1 },
        queuedInputs: [],
      });
      const uiStates = (file) =>
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((row) => row.type === "ui_state")
          .map((row) => row.state.composer.value);

      const recorder = new SessionRecorder({ sessionId: "ui", providerId: "miro", cwd });
      recorder.recordBlock({ role: "user", text: "你好" });
      // 退出时 effect cleanup 与 shutdown 会各 checkpoint 一次相同的草稿。
      recorder.recordUiState(draft("a"));
      recorder.recordUiState(draft("a"));
      recorder.recordUiState(draft("ab"));
      recorder.recordUiState(draft("a"));
      assert.deepEqual(uiStates(recorder.file), ["a", "ab", "a"], "only adjacent duplicates collapse");
      assert.equal(
        loadSessionBlocks("ui", cwd, "miro").uiState.composer.value,
        "a",
        "the last state is still readable",
      );

      // 恢复的会话首次写 ui_state 时没有「上一条」可比，就算内容与文件最后一条相同也照写。
      const resumed = new SessionRecorder({ sessionId: "ui", providerId: "miro", cwd });
      resumed.recordUiState(draft("a"));
      assert.deepEqual(uiStates(resumed.file), ["a", "ab", "a", "a"]);

      // 首个对话块之前攒下的 ui_state 照旧只留最新一条，不管内容是否相同。
      const deferred = new SessionRecorder({ sessionId: "ui-deferred", providerId: "miro", cwd });
      deferred.recordUiState(draft("draft"));
      deferred.recordUiState(draft("draft"));
      deferred.recordUiState(draft("draft 2"));
      assert.equal(existsSync(deferred.file), false, "a draft-only session still creates no file");
      deferred.recordBlock({ role: "user", text: "第一条" });
      assert.deepEqual(uiStates(deferred.file), ["draft 2"]);
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an empty conversation produces no session storage and is backfilled once the first block arrives", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "miro-session-empty-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      import {
        SessionRecorder,
        latestSessionId,
        listSessions,
        loadSessionBlocks,
      } from "./src/session-store.js";

      const cwd = "/work/example";
      const sessionsRoot = path.join(process.env.HOME, ".miro", "sessions");

      // 空对话：草稿、切模型、provider 横幅都可能先到达，但一条消息都没有。
      const empty = new SessionRecorder({ sessionId: "empty-session", providerId: "miro", cwd, model: "m1" });
      empty.recordUiState({
        composer: { value: "draft", cursor: 5, pastes: [], nextPasteId: 1 },
        queuedInputs: [],
      });
      empty.recordModel("m2");
      empty.recordBlock({ role: "system", text: "provider banner" });

      assert.equal(existsSync(empty.file), false, "an empty conversation creates no session file");
      assert.equal(existsSync(sessionsRoot), false, "an empty conversation does not even create the sessions directory");
      assert.equal(listSessions(cwd).length, 0, "an empty conversation is not listed");
      assert.equal(loadSessionBlocks("empty-session", cwd, "miro"), null, "an empty conversation has no history to load");

      // 首条 user 消息到达：先补写攒下的记录，再写这一块与标题。
      empty.recordBlock({ role: "user", text: "你好" });
      const rows = readFileSync(empty.file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(rows[0].type, "meta", "the first row is still meta");
      assert.equal(rows[0].model, "m2", "the backfilled meta carries the last selected model");
      assert.deepEqual(
        rows.slice(1).map((row) => row.type),
        ["ui_state", "model", "block", "block", "title"],
        "buffered records are backfilled in arrival order, followed by blocks and the title"
      );
      assert.equal(rows[1].state.composer.value, "draft", "the draft state is backfilled too");
      assert.equal(rows[2].model, "m2", "the model record is backfilled too");
      assert.equal(rows[4].block.text, "你好");
      const loaded = loadSessionBlocks("empty-session", cwd, "miro");
      assert.deepEqual(loaded.blocks.map((block) => block.role), ["system", "user"]);
      assert.equal(loaded.uiState.composer.value, "draft", "the backfilled ui_state is readable");

      empty.recordGoalState({
        goalId: "goal-1", objective: "ship it", completionCriterion: null, status: "active",
        turnsUsed: 2, tokensUsed: 30, wallClockMs: 4000, budgetLimits: {}, terminalReason: null,
      });
      assert.equal(loadSessionBlocks("empty-session", cwd, "miro").goalState.objective, "ship it");
      empty.recordGoalState(null);
      assert.equal(loadSessionBlocks("empty-session", cwd, "miro").goalState, null, "a cancelled goal clears persisted state");

      // 会话文件一旦存在（恢复的会话），非对话记录照旧立刻落盘。
      const resumed = new SessionRecorder({ sessionId: "empty-session", providerId: "miro", cwd });
      resumed.recordModel("m3");
      assert.match(readFileSync(resumed.file, "utf8"), /"model":"m3"/, "a model switch on an existing session is still persisted");

      // 惰性落盘之前留下的零消息文件（草稿会话）不再抢走列表首位。
      const projectDir = path.dirname(path.dirname(empty.file));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, "draft-only.jsonl"),
        JSON.stringify({ type: "meta", sessionId: "draft-only", providerId: "miro", createdAt: 1 }) +
          "\n" +
          JSON.stringify({
            type: "ui_state",
            version: 1,
            state: { composer: { value: "d", cursor: 1, pastes: [], nextPasteId: 1 }, queuedInputs: [] },
          }) +
          "\n",
        "utf8"
      );
      assert.ok(
        !listSessions(cwd).some((session) => session.sessionId === "draft-only"),
        "a legacy file with zero messages is no longer listed"
      );
      assert.equal(latestSessionId(cwd), "empty-session", "latestSessionId skips zero-message sessions");
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
