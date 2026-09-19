import assert from "node:assert/strict";
import test from "node:test";

import { AcpClient } from "./acp-client.js";

function option(id, category, currentValue, options) {
  return { id, category, type: "select", currentValue, options };
}

const OFF_ONLY = [{ name: "Off", value: "false" }];
const THINKING_OPTIONS = [
  { name: "Off", value: "false" },
  { name: "On", value: "true" },
];
const EFFORT_OPTIONS = [
  { name: "Slow", value: "high" },
  { name: "Fast", value: "no_think" },
];

function configs({
  thinking = "false",
  thinkingOptions = OFF_ONLY,
  effortOptions = null,
  effortValue = "",
} = {}) {
  return [
    option("model", "model", "hy3", [{ value: "hy3", name: "hy3" }, { value: "glm-5", name: "GLM-5" }]),
    option("reasoning_effort", "thought_level", effortValue, effortOptions),
    option("enable_thinking", "model_config", thinking, thinkingOptions),
  ];
}

function stubClient(initial = configs()) {
  const client = new AcpClient();
  client.sessionId = "session-1";
  client.updateConfigs(initial);
  const thinkingOptions =
    initial.find((item) => item.id === "enable_thinking")?.options ?? OFF_ONLY;
  const sent = [];
  client.context = {
    request: async (_method, params) => {
      sent.push({ configId: params.configId, value: params.value });
      if (params.configId === "enable_thinking") {
        return { configOptions: configs({ thinking: params.value, thinkingOptions, effortOptions: EFFORT_OPTIONS }) };
      }
      if (params.configId === "model") {
        return { configOptions: configs({ thinking: "false", thinkingOptions, effortOptions: EFFORT_OPTIONS }) };
      }
      if (params.configId === "reasoning_effort") {
        return {
          configOptions: configs({
            thinking: thinkingOptions.some((item) => item.value === "true") ? "true" : "false",
            thinkingOptions,
            effortOptions: EFFORT_OPTIONS,
            effortValue: params.value,
          }),
        };
      }
      return { configOptions: configs({ thinkingOptions }) };
    },
  };
  return { client, sent };
}

test("with only Off among options, switching model sends no enable_thinking but still fetches effort", async () => {
  const { client, sent } = stubClient();
  await client.setModel("glm-5");

  assert.deepEqual(sent, [{ configId: "model", value: "glm-5" }]);
  assert.equal(client.thinkingConfig.currentValue, "false");
  assert.equal(client.effortConfig.options.length, 2);
});

test("with On among options, switching model then sets enable_thinking to true", async () => {
  const { client, sent } = stubClient(configs({ thinkingOptions: THINKING_OPTIONS }));
  await client.setModel("glm-5");

  assert.deepEqual(sent, [
    { configId: "model", value: "glm-5" },
    { configId: "enable_thinking", value: "true" },
  ]);
  assert.equal(client.thinkingConfig.currentValue, "true");
  assert.equal(client.effortConfig.options.length, 2);
});

test("with only Off among options, setEffort writes reasoning_effort directly", async () => {
  const { client, sent } = stubClient(configs({ thinking: "false", effortOptions: EFFORT_OPTIONS }));
  await client.setEffort("no_think");

  assert.deepEqual(sent, [{ configId: "reasoning_effort", value: "no_think" }]);
  assert.equal(client.effortConfig.currentValue, "no_think");
});

test("with On among options, setEffort enables thinking before writing reasoning_effort", async () => {
  const { client, sent } = stubClient(
    configs({ thinking: "false", thinkingOptions: THINKING_OPTIONS, effortOptions: EFFORT_OPTIONS }),
  );
  await client.setEffort("no_think");

  assert.deepEqual(sent, [
    { configId: "enable_thinking", value: "true" },
    { configId: "reasoning_effort", value: "no_think" },
  ]);
  assert.equal(client.effortConfig.currentValue, "no_think");
});

test("set_config_option is not repeated when thinking is already on", async () => {
  const { client, sent } = stubClient(
    configs({
      thinking: "true",
      thinkingOptions: THINKING_OPTIONS,
      effortOptions: EFFORT_OPTIONS,
      effortValue: "high",
    }),
  );
  await client.enableThinking();
  await client.setEffort("no_think");

  assert.deepEqual(sent, [{ configId: "reasoning_effort", value: "no_think" }]);
});

test("effort can still be set directly when there is no enable_thinking option", async () => {
  const { client, sent } = stubClient([
    option("model", "model", "hy3", [{ value: "hy3", name: "hy3" }]),
    option("reasoning_effort", "thought_level", "", EFFORT_OPTIONS),
  ]);
  await client.setEffort("high");

  assert.deepEqual(sent, [{ configId: "reasoning_effort", value: "high" }]);
});

test("a rejected enable_thinking still lets effort be set", async () => {
  const { client, sent } = stubClient(
    configs({ thinking: "false", thinkingOptions: THINKING_OPTIONS, effortOptions: EFFORT_OPTIONS }),
  );
  const inner = client.context.request;
  client.context.request = async (method, params) => {
    if (params.configId === "enable_thinking") {
      sent.push({ configId: params.configId, value: params.value });
      throw new Error('invalid value "true" for configId "enable_thinking"');
    }
    return inner(method, params);
  };

  await client.setEffort("high");

  assert.deepEqual(sent, [
    { configId: "enable_thinking", value: "true" },
    { configId: "reasoning_effort", value: "high" },
  ]);
  assert.equal(client.effortConfig.currentValue, "high");
});
