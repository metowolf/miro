import assert from "node:assert/strict";
import test from "node:test";

import {
  configDisplayValue,
  matchConfigChoice,
  matchConfigOption,
  toggleConfigValue,
} from "./config-options.js";

const OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "hy3",
    options: [
      { name: "hy3", value: "hy3" },
      { name: "GLM-5", value: "glm-5" },
    ],
  },
  {
    id: "enable_thinking",
    name: "Enable Thinking",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [{ name: "Off", value: "false" }],
  },
  {
    id: "enable_web_search",
    name: "Web Search",
    category: "_tools",
    type: "select",
    currentValue: "",
    options: [
      { name: "Default", value: "" },
      { name: "On", value: "true" },
      { name: "Off", value: "false" },
    ],
  },
  {
    id: "show_pr",
    name: "Show PR status footer",
    type: "select",
    currentValue: "false",
    options: [
      { name: "true", value: "true" },
      { name: "false", value: "false" },
    ],
  },
];

test("configDisplayValue prefers the display name of the current option", () => {
  assert.equal(configDisplayValue(OPTIONS[0]), "hy3");
  assert.equal(configDisplayValue(OPTIONS[2]), "Default");
  assert.equal(configDisplayValue({ id: "x", currentValue: "", options: null }), "default");
});

test("matchConfigOption matches by id / name", () => {
  assert.equal(matchConfigOption(OPTIONS, "enable_thinking").name, "Enable Thinking");
  assert.equal(matchConfigOption(OPTIONS, "Web Search").id, "enable_web_search");
  assert.equal(matchConfigOption(OPTIONS, "missing"), null);
});

test("matchConfigChoice matches by value / name", () => {
  assert.equal(matchConfigChoice(OPTIONS[2], "true").name, "On");
  assert.equal(matchConfigChoice(OPTIONS[2], "Off").value, "false");
  assert.equal(matchConfigChoice(OPTIONS[2], "nope"), null);
});

test("matchConfigChoice matches a catalog model by bare id", () => {
  const option = {
    id: "model",
    type: "select",
    currentValue: "openai-codex/gpt-5.6-sol",
    options: [
      { name: "openai-codex", options: [{ value: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol", id: "gpt-5.6-sol" }] },
      { name: "metowolf", options: [{ value: "metowolf/gpt-5.6-terra", name: "gpt-5.6-terra", id: "gpt-5.6-terra" }] },
    ],
  };
  assert.equal(matchConfigChoice(option, "openai-codex/gpt-5.6-sol").id, "gpt-5.6-sol");
  assert.equal(matchConfigChoice(option, "gpt-5.6-sol").value, "openai-codex/gpt-5.6-sol");
  assert.equal(matchConfigChoice(option, "GPT-5.6 Sol").value, "openai-codex/gpt-5.6-sol");
});

test("toggleConfigValue returns the other value only with exactly two choices", () => {
  assert.equal(toggleConfigValue(OPTIONS[3]), "true");
  assert.equal(toggleConfigValue(OPTIONS[1]), null);
  assert.equal(toggleConfigValue(OPTIONS[2]), null);
});
