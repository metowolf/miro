import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { modelConfigFrom, effortConfigFrom, thinkingConfigFrom } from "../acp/model.js";
import {
  DEFAULT_MIRO_MODELS,
  DEFAULT_MIRO_PROTOCOL,
  buildConfigOptions,
  contextWindowOf,
  effortChoicesForModel,
  mappedEffortForModel,
  normalizeModels,
  normalizeMiroProtocol,
  readMiroConfig,
} from "./config-options.js";
import { catalogFromModelsFile } from "./models-file.js";

test("buildConfigOptions output is recognized by ACP model.js", () => {
  const options = buildConfigOptions({
    models: [{ id: "m1", name: "Model One" }, { id: "m2", name: "Model Two" }],
    model: "m1",
    effort: "high",
    thinking: true,
  });

  const model = modelConfigFrom(options);
  const effort = effortConfigFrom(options);
  const thinking = thinkingConfigFrom(options);

  assert.equal(model.id, "model");
  assert.equal(model.currentValue, "m1");
  assert.equal(model.options.length, 2);
  assert.equal(effort.id, "reasoning_effort");
  assert.equal(effort.currentValue, "high");
  assert.equal(thinking.id, "enable_thinking");
  assert.equal(thinking.currentValue, "on");
  assert.equal(options.find((option) => option.id === "protocol").currentValue, DEFAULT_MIRO_PROTOCOL);
});

test("Tools config options reflect top-level disableTools", () => {
  const options = buildConfigOptions({
    models: [{ id: "m1" }], model: "m1", effort: "medium", thinking: true,
    disabledTools: ["read_file"],
  });
  const tools = options.find((option) => option.id === "tools");
  const read = tools.tools.find((option) => option.id === "tool:read_file");
  const write = tools.tools.find((option) => option.id === "tool:write_file");
  assert.equal(tools.currentValue, "1 disabled");
  assert.equal(read.category, "tools");
  assert.equal(read.currentValue, "disabled");
  assert.deepEqual(read.options.map((choice) => choice.value), ["enabled", "disabled"]);
  assert.equal(write.currentValue, "enabled");
  assert.deepEqual(readMiroConfig({ disableTools: ["run_command", "run_command"] }).disabledTools, ["terminal"]);
});

test("sandbox setting only changes the terminal parameters, never the tool name", () => {
  const base = { models: [{ id: "m1" }], model: "m1", effort: "medium", thinking: true };
  const sandboxed = buildConfigOptions({ ...base, sandboxEnabled: true });
  const sandboxNames = sandboxed.find((option) => option.id === "tools").tools.map((option) => option.id);
  const hostNames = buildConfigOptions(base).find((option) => option.id === "tools").tools.map((option) => option.id);
  assert.deepEqual(sandboxNames, hostNames);
  assert.ok(sandboxNames.includes("tool:terminal"));
  assert.ok(!sandboxNames.includes("tool:run_command"));
  const sandbox = sandboxed.find((option) => option.id === "sandbox");
  assert.equal(sandbox.currentValue, "on");
  assert.deepEqual(sandbox.options.map((option) => option.value), ["off", "on"]);
  // 曾用名 `run_command` 的禁用选择要落到 terminal 上，两种模式都一样。
  for (const sandboxEnabled of [false, true]) {
    const legacyDisabled = buildConfigOptions({ ...base, sandboxEnabled, disabledTools: ["run_command"] });
    assert.equal(
      legacyDisabled.find((option) => option.id === "tools").tools.find((option) => option.id === "tool:terminal").currentValue,
      "disabled",
    );
  }
  assert.equal(readMiroConfig({ miro: { sandbox: { enabled: true } } }).sandboxEnabled, true);
  assert.equal(readMiroConfig({ miro: { sandbox: { enabled: "true" } } }).sandboxEnabled, false);
});

test("normalizeModels accepts strings and objects and falls back to the defaults for an empty list", () => {
  assert.deepEqual(normalizeModels(["a", { id: "b", name: "B", contextWindow: 8 }]), [
    { id: "a", name: "a", contextWindow: null, key: "a", fromCatalog: false },
    { id: "b", name: "B", contextWindow: 8, key: "b", fromCatalog: false },
  ]);
  assert.deepEqual(
    normalizeModels([]),
    DEFAULT_MIRO_MODELS.map((entry) => ({ ...entry, key: entry.id, fromCatalog: false })),
  );
  assert.deepEqual(
    normalizeModels(null),
    DEFAULT_MIRO_MODELS.map((entry) => ({ ...entry, key: entry.id, fromCatalog: false })),
  );
  assert.equal(normalizeModels([42, null]).length, DEFAULT_MIRO_MODELS.length);
});

test("readMiroConfig falls back for unconfigured fields", () => {
  const config = readMiroConfig({});
  assert.equal(config.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.protocol, DEFAULT_MIRO_PROTOCOL);
  assert.equal(config.model, DEFAULT_MIRO_MODELS[0].id);
  assert.equal(config.effort, "medium");
  assert.equal(config.thinking, true);
  assert.equal(config.maxToolRounds, Infinity);
  // 重试预算必须是具体数字：agent-loop 刻意原样透传，undefined 会让
  // settings 里的配置形同虚设。
  assert.equal(config.streamMaxRetries, 10);
  assert.equal(config.retryBaseDelayMs, 1_000);
});

test("readMiroConfig accepts explicit retry budget overrides", () => {
  const config = readMiroConfig({
    miro: { streamMaxRetries: 0, retryBaseDelayMs: 250 },
  });
  // 0 是有意义的取值（关掉重试），不能被当成缺省而回退成默认次数。
  assert.equal(config.streamMaxRetries, 0);
  assert.equal(config.retryBaseDelayMs, 250);
});

test("readMiroConfig accepts explicit config and validates model / effort", () => {
  const config = readMiroConfig({
    miro: {
      baseUrl: "https://proxy.test/v1/",
      apiKey: "sk-test",
      models: ["custom-1", "custom-2"],
      model: "custom-2",
      effort: "low",
      thinking: false,
      protocol: "anthropic-messages",
    },
  });

  // 自定义 endpoint 原样保留；具体协议 backend 在发请求时处理路径。
  assert.equal(config.baseUrl, "https://proxy.test/v1/");
  assert.equal(config.apiKey, "sk-test");
  assert.equal(config.model, "custom-2");
  assert.equal(config.effort, "low");
  assert.equal(config.thinking, false);
  assert.equal(config.protocol, "anthropic-messages");
});

test("an invalid protocol falls back to Chat Completions, and the protocol picks the default endpoint", () => {
  assert.equal(normalizeMiroProtocol("unknown"), DEFAULT_MIRO_PROTOCOL);
  assert.equal(readMiroConfig({ miro: { protocol: "anthropic-messages" } }).baseUrl, "https://api.anthropic.com");
  assert.equal(readMiroConfig({ miro: { protocol: "openai-responses" } }).baseUrl, "https://api.openai.com/v1");
});

test("readMiroConfig drops a model missing from the model list and an invalid effort", () => {
  const config = readMiroConfig({
    miro: { models: ["only-one"], model: "missing", effort: "insane" },
  });
  assert.equal(config.model, "only-one");
  assert.equal(config.effort, "medium");
});

test("MIRO_BASE_URL and MIRO_API_KEY act as environment variable fallbacks", () => {
  const saved = { baseUrl: process.env.MIRO_BASE_URL, apiKey: process.env.MIRO_API_KEY };
  try {
    process.env.MIRO_BASE_URL = "https://env.test/v1";
    process.env.MIRO_API_KEY = "env-key";
    const config = readMiroConfig({});
    assert.equal(config.baseUrl, "https://env.test/v1");
    assert.equal(config.apiKey, "env-key");
  } finally {
    if (saved.baseUrl === undefined) delete process.env.MIRO_BASE_URL;
    else process.env.MIRO_BASE_URL = saved.baseUrl;
    if (saved.apiKey === undefined) delete process.env.MIRO_API_KEY;
    else process.env.MIRO_API_KEY = saved.apiKey;
  }
});

test("contextWindowOf uses matching model metadata and falls back to the default without a match", () => {
  const models = [{ id: "m1", name: "M1", contextWindow: 32_000 }, { id: "m2", name: "M2", contextWindow: null }];
  assert.equal(contextWindowOf(models, "m1"), 32_000);
  assert.equal(contextWindowOf(models, "m2"), 128_000);
  assert.equal(contextWindowOf(models, "unknown", 999), 999);
});

test("permission config defaults to Auto, and legacy Ask and unknown values migrate to Auto", () => {
  for (const permissionMode of [undefined, null, "ask", "unknown"]) {
    assert.equal(readMiroConfig({ miro: { permissionMode } }).permissionMode, "auto");
  }
  for (const permissionMode of ["auto", "manual"]) {
    assert.equal(readMiroConfig({ miro: { permissionMode } }).permissionMode, permissionMode);
  }
});

test("Auto safety review has no user-selectable reviewer option", () => {
  const option = buildConfigOptions({ models: [{ id: "m1" }], model: "m1", effort: "medium", thinking: true })
    .find((entry) => entry.id === "approval_reviewer");
  assert.equal(option, undefined);
});

test("the models.json catalog wins over settings.miro.models and carries that model's connection parameters", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        models: [{ id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }],
      },
    },
  });
  const config = readMiroConfig(
    { miro: { models: ["ignored"], model: "qwen2.5-coder:7b", baseUrl: "https://api.openai.com/v1" } },
    { catalog },
  );
  assert.equal(config.model, "ollama/qwen2.5-coder:7b");
  assert.equal(config.apiModel, "qwen2.5-coder:7b");
  assert.equal(config.baseUrl, "http://localhost:11434/v1");
  assert.equal(config.protocol, DEFAULT_MIRO_PROTOCOL);
  assert.equal(config.apiKeyRaw, "ollama");
  assert.equal(config.models.length, 2);
});

test("catalog models are grouped by provider without a global protocol toggle", () => {
  const options = buildConfigOptions({
    models: [
      { key: "ollama/llama3.1:8b", id: "llama3.1:8b", name: "llama3.1:8b", provider: "ollama", fromCatalog: true },
      { key: "anthropic-proxy/claude", id: "claude", name: "Claude", provider: "anthropic-proxy", fromCatalog: true },
    ],
    model: "anthropic-proxy/claude",
    effort: "medium",
    thinking: true,
    includeProtocol: false,
  });
  assert.equal(options.find((option) => option.id === "protocol"), undefined);
  const model = modelConfigFrom(options);
  assert.equal(model.currentValue, "anthropic-proxy/claude");
  assert.equal(model.options.length, 2);
  assert.equal(model.options[0].name, "ollama");
  assert.equal(model.options[1].options[0].value, "anthropic-proxy/claude");
  assert.equal(model.options[1].options[0].id, "claude");
});

test("thinkingLevelMap controls the selectable effort levels and the upstream mapping", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.test/v1",
        api: "openai-completions",
        models: [{
          id: "deepseek-v4-pro",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "maximum",
          },
        }],
      },
    },
  });
  const config = readMiroConfig(
    { miro: { model: "deepseek-v4-pro", effort: "medium" } },
    { catalog },
  );

  assert.equal(config.model, "deepseek/deepseek-v4-pro");
  assert.equal(config.effort, "high", "an unsupported saved effort falls back to the first available level");
  assert.deepEqual(
    effortChoicesForModel(config.models, config.model).map((choice) => choice.value),
    ["high", "max"],
  );
  assert.equal(mappedEffortForModel(config.models, config.model, "high"), "high");
  assert.equal(mappedEffortForModel(config.models, config.model, "max"), "maximum");

  const options = buildConfigOptions({
    models: config.models,
    model: config.model,
    effort: config.effort,
    thinking: true,
    includeProtocol: false,
  });
  assert.deepEqual(
    effortConfigFrom(options).options.map((choice) => choice.value),
    ["high", "max"],
  );
});

test("the top-level model / effort preference picks the startup model for miro", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      first: {
        baseUrl: "https://first.test/v1",
        api: "openai-completions",
        models: [{ id: "first-model" }],
      },
      preferred: {
        baseUrl: "https://preferred.test/v1",
        api: "anthropic-messages",
        models: [{ id: "preferred-model", reasoning: true }],
      },
    },
  });

  // 顶层 model / effort 是 miro 的持久偏好，新建会话与恢复会话都靠它开局：
  // 恢复会话不会再套一次偏好（ACP 的模型由 session/load 带回），让目录里的第一个
  // 模型顶上来就会出现「恢复后模型突然变了」。
  const config = readMiroConfig(
    { model: "preferred/preferred-model", effort: "high", miro: { models: ["ignored"], model: "first-model" } },
    { catalog },
  );
  assert.equal(config.model, "preferred/preferred-model");
  assert.equal(config.apiModel, "preferred-model");
  assert.equal(config.effort, "high");
  assert.equal(config.baseUrl, "https://preferred.test/v1");

  // 显式 --model，以及 /model 切换后重读目录时传的 selectedModel，仍然最高优先。
  assert.equal(
    readMiroConfig({ model: "preferred/preferred-model" }, { catalog, selectedModel: "first-model" }).model,
    "first/first-model",
  );

  // 旧的裸 id 偏好仍能对上唯一条目，但运行时 model 写成 provider/id。
  assert.equal(
    readMiroConfig({ model: "preferred-model" }, { catalog }).model,
    "preferred/preferred-model",
  );

  // 偏好匹配不到目录条目：退回 miro.model，再退回首个模型。
  assert.equal(
    readMiroConfig({ model: "gone", miro: { model: "first-model" } }, { catalog }).model,
    "first/first-model",
  );
  assert.equal(readMiroConfig({ model: "gone" }, { catalog }).model, "first/first-model");
});

test("an unavailable top-level effort falls back to the selected model's levels", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      only: {
        baseUrl: "https://only.test/v1",
        api: "openai-completions",
        models: [{
          id: "deepseek-v4-pro",
          reasoning: true,
          thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" },
        }],
      },
    },
  });
  const config = readMiroConfig(
    { model: "deepseek-v4-pro", effort: "low", miro: { effort: "medium" } },
    { catalog },
  );
  assert.equal(config.model, "only/deepseek-v4-pro");
  assert.equal(config.effort, "high", "the top-level preference is normalized against the model, not dropped for miro.effort");
});

test("reasoning models without a map support minimal through high, non-reasoning models offer no effort", () => {
  const models = [
    { key: "reasoning", id: "reasoning", fromCatalog: true, reasoning: true },
    { key: "plain", id: "plain", fromCatalog: true, reasoning: false },
  ];
  assert.deepEqual(
    effortChoicesForModel(models, "reasoning").map((choice) => choice.value),
    ["minimal", "low", "medium", "high"],
  );
  assert.deepEqual(effortChoicesForModel(models, "plain"), []);
  assert.equal(mappedEffortForModel(models, "plain", "high"), null);
});
