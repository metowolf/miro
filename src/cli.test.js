import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "./cli.js";

test("parses the interactive session resume flags", () => {
  assert.deepEqual(parseCliArgs(["-c", "sess-123"]), {
    mode: "interactive",
    prompt: null,
    continueSessionId: "sess-123",
    continueLatest: false,
    outputFormat: "text",
    acp: null,
    model: null,
    effort: null,
    permissionMode: null,
    interactionMode: null,
    help: false,
  });
  assert.equal(parseCliArgs(["--continue", "sess-456"]).continueSessionId, "sess-456");
});

test("--continue without an ID selects the latest session", () => {
  assert.equal(parseCliArgs(["-c"]).continueLatest, true);
  assert.equal(parseCliArgs(["--continue"]).continueLatest, true);
});

test("parses the non-interactive prompt and output options", () => {
  const result = parseCliArgs([
    "-p",
    "--output-format",
    "json",
    "--acp",
    "pi",
    "--model",
    "sonnet",
    "--effort",
    "high",
    "review",
    "this",
  ]);
  assert.equal(result.mode, "print");
  assert.equal(result.prompt, "review this");
  assert.equal(result.outputFormat, "json");
  assert.equal(result.acp, "pi");
  assert.equal(result.model, "sonnet");
  assert.equal(result.effort, "high");
});

test("dash-prefixed arguments after -- become part of the prompt", () => {
  assert.equal(parseCliArgs(["-p", "--", "- explain", "--all"]).prompt, "- explain --all");
});

test("validates the options that are limited to non-interactive mode", () => {
  assert.throws(() => parseCliArgs(["hello"]), /requires --print/);
  assert.throws(() => parseCliArgs(["--output-format", "json"]), /require --print/);
  assert.equal(parseCliArgs(["--model", "sonnet"]).model, "sonnet");
  assert.throws(() => parseCliArgs(["-p", "--output-format", "xml"]), /must be one of/);
  assert.throws(() => parseCliArgs(["--resume"]), /requires a value/);
  assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
});

test("--acp starts interactive mode and combines with model and resume flags", () => {
  const result = parseCliArgs(["--acp", "pi"]);
  assert.equal(result.mode, "interactive");
  assert.equal(result.acp, "pi");
  assert.equal(result.prompt, null);

  const resumed = parseCliArgs(["-c", "--acp", "pi", "--model", "sonnet"]);
  assert.equal(resumed.mode, "interactive");
  assert.equal(resumed.acp, "pi");
  assert.equal(resumed.model, "sonnet");
  assert.equal(resumed.continueLatest, true);
});

test("--acp requires a value, while --provider reports its migration", () => {
  assert.throws(() => parseCliArgs(["--acp"]), /--acp requires a value/);
  assert.throws(() => parseCliArgs(["--acp", "--model", "sonnet"]), /--acp requires a value/);
  assert.throws(() => parseCliArgs(["--acp", "pi", "hello"]), /requires --print/);
  assert.throws(() => parseCliArgs(["--provider", "pi"]), /has been removed; use --acp/);
});

test("--effort starts interactive mode and combines with ACP, model and resume flags", () => {
  const result = parseCliArgs(["--effort", "high"]);
  assert.equal(result.mode, "interactive");
  assert.equal(result.effort, "high");
  assert.equal(result.prompt, null);

  const resumed = parseCliArgs(["-c", "--acp", "pi", "--model", "demo", "--effort", "High"]);
  assert.equal(resumed.mode, "interactive");
  assert.equal(resumed.acp, "pi");
  assert.equal(resumed.model, "demo");
  assert.equal(resumed.effort, "High");
  assert.equal(resumed.continueLatest, true);
});

test("--effort requires a value and does not relax the bare prompt or output-format rules", () => {
  assert.throws(() => parseCliArgs(["--effort"]), /--effort requires a value/);
  assert.throws(() => parseCliArgs(["--effort", "--model", "demo"]), /--effort requires a value/);
  assert.throws(() => parseCliArgs(["--effort", "high", "hello"]), /requires --print/);
  assert.throws(() => parseCliArgs(["--effort", "high", "--output-format", "json"]), /require --print/);
});

test("--permission-mode accepts Auto and Manual, and removed modes are rejected", () => {
  assert.equal(parseCliArgs(["--permission-mode", "auto"]).permissionMode, "auto");
  assert.equal(parseCliArgs(["--permission-mode", "manual"]).permissionMode, "manual");
  assert.equal(parseCliArgs([]).permissionMode, null);
  for (const value of ["ask", "plan", "yolo", "YOLO"]) {
    assert.throws(() => parseCliArgs(["--permission-mode", value]), /must be one of: auto, manual/);
  }
  assert.throws(() => parseCliArgs(["--plan"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["--yolo"]), /Unknown option/);
  // 命令行是显式意图：拼错不能静默降级成 auto。
  assert.throws(() => parseCliArgs(["--permission-mode", "nonsense"]), /must be one of/);
  assert.throws(() => parseCliArgs(["--permission-mode", "YOLO"]), /must be one of/);
  assert.throws(() => parseCliArgs(["--permission-mode"]), /requires a value/);
});

test("--mode selects the interaction mode independently from permissions", () => {
  assert.equal(parseCliArgs(["--mode", "default"]).interactionMode, "default");
  assert.equal(parseCliArgs(["--mode", "plan"]).interactionMode, "plan");
  assert.equal(parseCliArgs(["--mode", "plan", "--permission-mode", "manual"]).permissionMode, "manual");
  assert.throws(() => parseCliArgs(["--mode"]), /requires a value/);
  assert.throws(() => parseCliArgs(["--mode", "ask"]), /must be one of: default, plan/);
});
