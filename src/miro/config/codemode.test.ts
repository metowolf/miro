import assert from "node:assert/strict";
import test from "node:test";
import { buildConfigOptions, readMiroConfig } from "./config-options.ts";
import { MiroAgentClient } from "../agent-client.ts";

test("codemode 配置仅明确 true 时开启", () => {
  for (const enabled of [undefined, false, "true", 1, true]) {
    const expected = enabled === true;
    const config = readMiroConfig({ miro: { codemode: { enabled } } });
    assert.equal(config.codemodeEnabled, expected);
    const options = buildConfigOptions({ models: [{ id: "m1" }], model: "m1", codemodeEnabled: expected });
    assert.equal(options.find((entry) => entry.id === "codemode").currentValue, expected ? "on" : "off");
  }
});

test("/config codemode 持久化且当前、隔离回合与配置视图立即一致", async () => {
  const writes = [];
  const schemas = [];
  const client = new MiroAgentClient({ settings: { miro: { models: ["m1"], model: "m1", codemode: { note: "keep" } }, skills: false }, dependencies: {
    modelsFile: null, oauthModels: { getModels: () => [] }, mcpRuntime: { enabled: false, close: async () => {} },
    writeSystemSettings: async (settings) => writes.push(settings),
    streamCompletion: async function* (request) { schemas.push(request.tools.map((entry) => entry.function.name)); yield { type: "text", text: "ok" }; },
  } });
  try {
    const view = () => client.configOptions.find((entry) => entry.id === "codemode").currentValue;
    assert.equal(view(), "off");
    await client.setConfigOption("codemode", "on");
    assert.equal(view(), "on");
    assert.equal(client.loopConfig().codemodeEnabled, true);
    assert.equal(writes[0].miro.codemode.enabled, true);
    assert.equal(writes[0].miro.codemode.note, "keep");
    await client.prompt("normal");
    await client.promptIsolated("isolated", { displayText: "/review" });
    assert.ok(schemas.every((names) => names.includes("codemode")));
    client.reloadSessionOptions();
    assert.equal(view(), "on");
    await client.setConfigOption("codemode", "off");
    assert.equal(view(), "off");
    assert.equal(writes[1].miro.codemode.enabled, false);
    await client.prompt("disabled");
    assert.ok(!schemas.at(-1).includes("codemode"));
    await assert.rejects(client.setConfigOption("codemode", "only"), /not available/);
  } finally { client.close(); }
});
