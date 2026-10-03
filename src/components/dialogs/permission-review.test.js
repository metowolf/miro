import assert from "node:assert/strict";
import test from "node:test";
import { permissionReview, permissionTitle } from "./permission-review.js";

test("MCP 审批始终保留完整参数，不解释远端的编辑、计划和命令字段", () => {
  const args = { channel: "production", content: "hello", notify_everyone: true,
    patch: "patch", newText: "new", plan: "plan", command: "remote command" };
  const rawInput = { server: "local", name: "send", arguments: args };
  const toolCall = { name: "mcp_call", kind: "execute", rawInput, command: "not the full arguments",
    content: [{ type: "diff", newText: "not the full arguments" }] };
  const review = permissionReview(toolCall);
  assert.equal(review.diff, null);
  assert.deepEqual(JSON.parse(review.text), rawInput);
  assert.equal(permissionTitle(toolCall), "MCP tool call");
});

test("本地文件、命令、计划审批保留已有正文语义", () => {
  assert.ok(permissionReview({ name: "write_file", kind: "edit", rawInput: { path: "a", content: "new" } }).diff);
  assert.equal(permissionReview({ kind: "execute", command: "pwd" }).text, "pwd");
  assert.equal(permissionReview({ kind: "plan", rawInput: { plan: "# Plan\nDetails" } }).text, "# Plan\nDetails");
  assert.equal(permissionTitle({ kind: "execute" }), "Bash command");
  assert.deepEqual(permissionReview({}), { diff: null, text: "" });
});
