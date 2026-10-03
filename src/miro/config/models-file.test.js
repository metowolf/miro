import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogFromModelsFile,
  catalogKey,
  findCatalogModel,
  mergeModelCatalogs,
  resolveConfigValue,
  resolveHeaders,
  resolveModelSecrets,
} from "./models-file.js";

const ollamaFile = {
  providers: {
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [{ id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }],
    },
  },
};

test("catalogFromModelsFile parses the minimal example", () => {
  const catalog = catalogFromModelsFile(ollamaFile);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].key, "ollama/llama3.1:8b");
  assert.equal(catalog[0].id, "llama3.1:8b");
  assert.equal(catalog[0].provider, "ollama");
  assert.equal(catalog[0].api, "openai-completions");
  assert.equal(catalog[0].baseUrl, "http://localhost:11434/v1");
  assert.equal(catalog[0].apiKey, "ollama");
  assert.equal(catalog[0].fromCatalog, true);
  assert.equal(catalog[0].contextWindow, 128_000);
  assert.equal(catalog[0].maxTokens, 16_384);
});

test("catalog keys are always provider/id, including unique ids", () => {
  const catalog = catalogFromModelsFile(ollamaFile);
  assert.deepEqual(catalog.map((entry) => entry.key), ["ollama/llama3.1:8b", "ollama/qwen2.5-coder:7b"]);
  assert.equal(findCatalogModel(catalog, "ollama/llama3.1:8b").id, "llama3.1:8b");
  assert.equal(findCatalogModel(catalog, "llama3.1:8b").key, "ollama/llama3.1:8b");
});

test("same id across providers uses provider/id as the selection key", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      a: {
        baseUrl: "http://a.test/v1",
        api: "openai-completions",
        models: [{ id: "shared" }],
      },
      b: {
        baseUrl: "http://b.test/v1",
        api: "anthropic-messages",
        models: [{ id: "shared", name: "Shared B" }],
      },
    },
  });
  assert.deepEqual(catalog.map((entry) => entry.key), ["a/shared", "b/shared"]);
  assert.equal(findCatalogModel(catalog, "b/shared").name, "Shared B");
  assert.equal(findCatalogModel(catalog, "shared").provider, "a");
});

test("ids that contain slashes stay inside provider/id", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      vendor: {
        baseUrl: "https://vendor.test/v1",
        api: "anthropic-messages",
        models: [{ id: "deepseek/deepseek-flash" }],
      },
    },
  });
  assert.equal(catalog[0].key, "vendor/deepseek/deepseek-flash");
  assert.equal(findCatalogModel(catalog, "vendor/deepseek/deepseek-flash").id, "deepseek/deepseek-flash");
  assert.equal(findCatalogModel(catalog, "deepseek/deepseek-flash").provider, "vendor");
});

test("mergeModelCatalogs keeps the first entry for a duplicated key", () => {
  const file = [{ key: "openai-codex/gpt-5.6-sol", id: "gpt-5.6-sol", provider: "openai-codex", name: "from-file" }];
  const oauth = [
    { key: "openai-codex/gpt-5.6-sol", id: "gpt-5.6-sol", provider: "openai-codex", name: "from-oauth" },
    { key: "openai-codex/gpt-5.6-luna", id: "gpt-5.6-luna", provider: "openai-codex", name: "Luna" },
  ];
  const merged = mergeModelCatalogs(file, oauth);
  assert.deepEqual(merged.map((entry) => [entry.key, entry.name]), [
    ["openai-codex/gpt-5.6-sol", "from-file"],
    ["openai-codex/gpt-5.6-luna", "Luna"],
  ]);
  assert.equal(catalogKey("metowolf", "gpt-5.6-sol"), "metowolf/gpt-5.6-sol");
  assert.equal(catalogKey("", "bare"), "bare");
});

test("entries with unsupported api, missing baseUrl or empty id are dropped", () => {
  const catalog = catalogFromModelsFile({
    providers: {
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        models: [{ id: "gemma" }],
      },
      broken: {
        api: "openai-completions",
        models: [{ id: "no-url" }],
      },
      ok: {
        baseUrl: "http://ok.test/v1",
        api: "openai-completions",
        models: [{ id: "kept" }, { id: "  " }, 42],
      },
    },
  });
  assert.deepEqual(catalog.map((entry) => entry.id), ["kept"]);
});

test("model-level api / baseUrl / compat override provider defaults", () => {
  const [entry] = catalogFromModelsFile({
    providers: {
      mixed: {
        baseUrl: "http://provider.test/v1",
        api: "openai-completions",
        compat: { supportsDeveloperRole: false },
        models: [{
          id: "claude",
          api: "anthropic-messages",
          baseUrl: "https://proxy.test",
          compat: { allowEmptySignature: true },
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            high: "high",
            max: "max",
            invalid: "ignored",
          },
          contextWindow: 200_000,
        }],
      },
    },
  });
  assert.equal(entry.api, "anthropic-messages");
  assert.equal(entry.baseUrl, "https://proxy.test");
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.thinkingLevelMap, {
    minimal: null,
    high: "high",
    max: "max",
  });
  assert.equal(entry.contextWindow, 200_000);
  assert.deepEqual(entry.compat, {
    supportsDeveloperRole: false,
    allowEmptySignature: true,
  });
});

test("resolveConfigValue interpolates env vars and escapes $$ / $!", () => {
  const env = { MY_KEY: "secret", PREFIX: "ab" };
  assert.deepEqual(resolveConfigValue("$MY_KEY", { env }), { ok: true, value: "secret" });
  assert.deepEqual(resolveConfigValue("${PREFIX}_tail", { env }), { ok: true, value: "ab_tail" });
  assert.deepEqual(resolveConfigValue("$$literal-dollar-prefix", { env }), { ok: true, value: "$literal-dollar-prefix" });
  assert.deepEqual(resolveConfigValue("$!literal-bang-prefix", { env }), { ok: true, value: "!literal-bang-prefix" });
  assert.equal(resolveConfigValue("$MISSING", { env }).ok, false);
});

test("resolveConfigValue runs !command at request time", () => {
  assert.deepEqual(
    resolveConfigValue("!echo hello-key", { execCommand: (command) => ({ ok: true, value: `ran:${command.trim()}` }) }),
    { ok: true, value: "ran:echo hello-key" },
  );
});

test("resolveModelSecrets resolves apiKey and headers", () => {
  const env = { PORTKEY: "pk" };
  const secrets = resolveModelSecrets({
    apiKey: "ollama",
    headers: { "x-portkey-api-key": "$PORTKEY" },
  }, { env });
  assert.equal(secrets.apiKey, "ollama");
  assert.equal(secrets.headers["x-portkey-api-key"], "pk");
  assert.deepEqual(resolveHeaders(null), {});
});
