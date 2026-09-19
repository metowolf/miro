import { spawnAgentTool } from "../subagent-runner.js";

export const SPAWN_AGENT_DEFINITION = {
  name: "spawn_agent",
  kind: "spawn",
  title: "Sub-agent",
  description:
    "Delegate one focused, self-contained task to a sub-agent with a fresh context and one returned summary. The sub-agent sees none of this conversation and cannot ask the user questions or spawn further sub-agents, so restate all needed context, file paths, and the exact output you expect back. Use it when the work is self-contained and its tool noise would crowd your own context; for a single file or symbol you already know, just use read_file / grep / glob yourself. A sub-agent inherits your model and reasoning effort unless you override them. Calls run one at a time in the order you give them.",
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Short 3-5 word label for what the sub-agent does, shown to the user.",
      },
      message: {
        type: "string",
        description:
          "The full task for the sub-agent. It sees none of this conversation, so restate all needed context, file paths and the exact output you expect back.",
      },
      model: {
        type: "string",
        description:
          "Optional model for the sub-agent, chosen from the configured model catalog. Inherits the parent's model when omitted; an unknown model is rejected.",
      },
      effort: {
        type: "string",
        description:
          "Optional reasoning effort for the sub-agent. Inherits the parent's effort when omitted; an effort the chosen model does not support is rejected.",
      },
    },
    required: ["description", "message"],
  },
};

export { spawnAgentTool };
