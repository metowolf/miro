import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { PROVIDERS } from "./config.js";
import {
  detectProviders,
  loadProviders,
  readCustomProviders,
} from "./providers.js";

test("the settings providers field normalizes into provider definitions", () => {
  const providers = readCustomProviders({
    providers: {
      demo: { command: " demo-cli ", args: ["acp", 42, null], name: "Demo" },
      minimal: { command: "x-cli" },
      alias: { bin: "y-cli" },
    },
  });
  assert.deepEqual(providers, [
    { id: "demo", name: "Demo", bin: "demo-cli", args: ["acp"] },
    { id: "minimal", name: "minimal", bin: "x-cli", args: [] },
    { id: "alias", name: "alias", bin: "y-cli", args: [] },
  ]);
});

test("custom provider sessionMeta keeps plain objects and drops invalid shapes", () => {
  const providers = readCustomProviders({
    providers: {
      routed: {
        command: "routed-cli",
        args: ["acp", "--no-update"],
        sessionMeta: { agentId: "example-agent-id" },
      },
      badArray: { command: "x", sessionMeta: ["agentId"] },
      badScalar: { command: "y", sessionMeta: "agent-id" },
    },
  });
  assert.deepEqual(providers.find((provider) => provider.id === "routed").sessionMeta, {
    agentId: "example-agent-id",
  });
  assert.equal(providers.find((provider) => provider.id === "badArray").sessionMeta, undefined);
  assert.equal(providers.find((provider) => provider.id === "badScalar").sessionMeta, undefined);
});

test("invalid custom provider entries are dropped", () => {
  assert.deepEqual(readCustomProviders({
    providers: {
      notObject: "demo-cli",
      array: ["demo-cli"],
      noCommand: { args: ["acp"] },
      emptyCommand: { command: "   " },
      nullEntry: null,
    },
  }), []);
  assert.deepEqual(readCustomProviders({ providers: [] }), []);
});

test("model / effort-only entries are not provider definitions and do not override built-ins", () => {
  // settings.js 会把某个 provider 上次选的模型写进它自己的条目，内置 provider
  // 因此可能有一条没有 command 的偏好条目；它不能被当成自定义定义。
  const settings = {
    providers: {
      cursor: { model: "sonnet", effort: "high" },
      codex: { command: "codex-acp", model: "gpt-5" },
    },
  };
  assert.deepEqual(readCustomProviders(settings), [
    { id: "codex", name: "codex", bin: "codex-acp", args: [] },
  ]);
  assert.equal(
    loadProviders(settings).find((provider) => provider.id === "cursor").bin,
    "cursor-agent",
    "the built-in cursor definition still applies",
  );
});

test("loadProviders merges custom entries, with the custom definition winning on a shared id", () => {
  const merged = loadProviders({
    providers: {
      extra: { command: "extra-cli" },
      pi: { command: "my-pi", args: ["--verbose"], name: "My Pi" },
    },
  });
  assert.deepEqual(
    merged.find((provider) => provider.id === "extra"),
    { id: "extra", name: "extra", bin: "extra-cli", args: [] },
  );
  assert.deepEqual(
    merged.find((provider) => provider.id === "pi"),
    { id: "pi", name: "My Pi", bin: "my-pi", args: ["--verbose"] },
  );
  assert.ok(merged.some((provider) => provider.id === "claude"));
  assert.deepEqual(loadProviders({}), PROVIDERS);
});

test("custom providers remain before built-in miro in the provider catalog", () => {
  const providers = loadProviders({
    providers: { fake: { command: "python3", args: ["fake-acp.py"], name: "Fake ACP" } },
  });
  assert.equal(providers[0].id, "fake");
  assert.equal(providers.at(-1).id, "miro");

});

test("detectProviders keeps only providers whose binary can be detected", () => {
  // process.execPath 是绝对路径且必然存在；随编造的命令名确保被过滤。
  const providers = [
    { id: "present", name: "Present", bin: process.execPath, args: [] },
    { id: "absent", name: "Absent", bin: "definitely-not-a-real-binary-xyz", args: [] },
  ];
  const detected = detectProviders(providers);
  assert.deepEqual(detected.map((provider) => provider.id), ["present"]);
});
