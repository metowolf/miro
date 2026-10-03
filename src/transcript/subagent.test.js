import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubagentState,
  extractRawText,
  isSpawnAgentTool,
  subagentDisplay,
  updateSubagentState,
} from "./subagent.js";

function line(event) {
  return `${JSON.stringify(event)}\n`;
}

const RAW_INPUT = {
  tool_call_name: "spawn_agent",
  sub_content: "worker-1",
  model: "gpt-4o",
  effort: "high",
  message: "Write a hello world script.\n\nUse JavaScript.",
};

function sampleEvents() {
  return [
    { type: "RUN_STARTED", rawEvent: {} },
    {
      type: "TOOL_CALL_START",
      rawEvent: { tool_call_id: "plan-1", name: "task_planning", display_name: "Planning" },
      toolCallId: "plan-1",
      toolCallName: "task_planning",
    },
    { type: "TOOL_CALL_END", rawEvent: { tool_call_id: "plan-1" }, toolCallId: "plan-1" },
    {
      type: "TOOL_CALL_RESULT",
      rawEvent: { tool_call_id: "plan-1", display_name: "Planning done" },
      toolCallId: "plan-1",
      content: "",
    },
    { type: "CUSTOM", rawEvent: { type: "remove-tool", tool_call_id: "plan-1" }, name: "remove-tool" },
    {
      type: "TOOL_CALL_START",
      rawEvent: { tool_call_id: "write-1", name: "write_to_file", display_name: "Writing file" },
      toolCallId: "write-1",
      toolCallName: "write_to_file",
    },
    {
      type: "TOOL_CALL_ARGS",
      rawEvent: { tool_call_id: "write-1", patchs: [{ op: "add", path: "/file_path", value: "/tmp" }] },
      toolCallId: "write-1",
    },
    {
      type: "TOOL_CALL_ARGS",
      rawEvent: {
        tool_call_id: "write-1",
        patchs: [{ op: "add", path: "/file_path", value: "/hello.js" }],
      },
      toolCallId: "write-1",
    },
    {
      type: "TOOL_CALL_RESULT",
      rawEvent: { tool_call_id: "write-1" },
      toolCallId: "write-1",
      content: "File written successfully.",
    },
    {
      type: "STEP_FINISHED",
      rawEvent: { step_name: "call_llm", token_usage: { total_tokens: 16087 } },
      stepName: "call_llm",
    },
    { type: "TEXT_MESSAGE_CONTENT", rawEvent: { content: "Created" }, delta: "Created" },
    { type: "TEXT_MESSAGE_CONTENT", rawEvent: { content: " the file." }, delta: " the file." },
    {
      type: "STEP_FINISHED",
      rawEvent: { step_name: "call_llm", token_usage: { total_tokens: 164 } },
      stepName: "call_llm",
    },
    { type: "RUN_FINISHED", rawEvent: {} },
  ];
}

test("isSpawnAgentTool matches rawInput and title fallback", () => {
  assert.equal(isSpawnAgentTool({ rawInput: { tool_call_name: "spawn_agent" } }), true);
  assert.equal(isSpawnAgentTool({ title: "子智能体" }), true);
  assert.equal(isSpawnAgentTool({ title: "Read", rawInput: { path: "/x" } }), false);
  assert.equal(isSpawnAgentTool(null), false);
});

test("updateSubagentState parses a full snapshot", () => {
  const snapshot = sampleEvents().map(line).join("");
  const state = updateSubagentState(createSubagentState(), RAW_INPUT, snapshot);

  assert.equal(state.name, "worker-1");
  assert.equal(state.taskSummary, "Write a hello world script.");
  assert.equal(state.request.model, "gpt-4o");
  assert.equal(state.request.effort, "high");
  assert.equal(state.runFinished, true);
  assert.equal(state.tokens, 16087 + 164);
  assert.equal(state.text, "Created the file.");

  assert.equal(state.tools.length, 2);
  assert.equal(state.tools[0].removed, true);
  assert.equal(state.tools[1].name, "write_to_file");
  assert.equal(state.tools[1].args, "/tmp/hello.js");
  assert.equal(state.tools[1].resultLine, "File written successfully.");
});

test("updateSubagentState only parses the appended suffix", () => {
  const events = sampleEvents();
  const half = events.slice(0, 8).map(line).join("");
  const full = events.map(line).join("");

  let state = updateSubagentState(createSubagentState(), RAW_INPUT, half);
  assert.equal(state.runFinished, false);
  assert.equal(state.parsedOffset, half.length);
  const toolsAfterHalf = state.tools;

  state = updateSubagentState(state, null, full);
  assert.equal(state.runFinished, true);
  assert.equal(state.tools.length, toolsAfterHalf.length);
  assert.equal(state.parsedOffset, full.length);
});

test("updateSubagentState defers incomplete trailing line", () => {
  const complete = line({ type: "RUN_STARTED", rawEvent: {} });
  const partial = '{"type":"TOOL_CALL_START","rawEvent":{"tool_call_id":"x1","na';

  let state = updateSubagentState(createSubagentState(), null, complete + partial);
  assert.equal(state.parsedOffset, complete.length);
  assert.equal(state.tools.length, 0);

  const finished =
    complete +
    line({
      type: "TOOL_CALL_START",
      rawEvent: { tool_call_id: "x1", name: "read_file" },
      toolCallId: "x1",
      toolCallName: "read_file",
    });
  state = updateSubagentState(state, null, finished);
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].name, "read_file");
});

test("updateSubagentState skips corrupt lines and non-appending snapshots reset", () => {
  const good = line({ type: "RUN_FINISHED", rawEvent: {} });
  let state = updateSubagentState(createSubagentState(), null, "not-json\n" + good);
  assert.equal(state.runFinished, true);

  const shorter = line({ type: "RUN_STARTED", rawEvent: {} });
  state = updateSubagentState(state, null, shorter);
  assert.equal(state.runFinished, false);
  assert.equal(state.parsedOffset, shorter.length);
});

test("subagentDisplay folds tools beyond the row cap and skips removed", () => {
  const state = createSubagentState();
  state.tools = [
    { id: "a", name: "task_planning", args: "", resultLine: null, removed: true },
    { id: "b", name: "write_to_file", args: "/tmp/1.txt", resultLine: null, removed: false },
    { id: "c", name: "write_to_file", args: "/tmp/2.txt", resultLine: null, removed: false },
    { id: "d", name: "run_command", args: "ls", resultLine: null, removed: false },
    { id: "e", name: "read_file", args: "/tmp/3.txt", resultLine: null, removed: false },
  ];
  state.text = "Done.\nDetails omitted.";
  state.tokens = 1234;

  const display = subagentDisplay(state);
  assert.deepEqual(display.rows, [
    "write_to_file(/tmp/1.txt)",
    "write_to_file(/tmp/2.txt)",
    "run_command(ls)",
  ]);
  assert.equal(display.moreTools, 1);
  assert.equal(display.toolCount, 4);
  assert.equal(display.textLine, "Done.");
  assert.equal(display.tokens, 1234);
});

test("extractRawText joins text blocks and ignores others", () => {
  assert.equal(
    extractRawText([
      { type: "content", content: { type: "text", text: "a\n" } },
      { type: "diff", path: "x" },
      { type: "content", content: { type: "text", text: "b" } },
    ]),
    "a\nb"
  );
  assert.equal(extractRawText(undefined), "");
});
