import { PERMISSION_MODES } from "./miro/permission-mode.js";

const OUTPUT_FORMATS = new Set(["text", "json"]);

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

/** 解析命令行参数，不执行任何 I/O。 */
export function parseCliArgs(args) {
  const options = {
    mode: "interactive",
    prompt: null,
    continueSessionId: null,
    continueLatest: false,
    outputFormat: "text",
    acp: null,
    model: null,
    effort: null,
    permissionMode: null,
    help: false,
  };
  const promptParts = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsEnded) {
      promptParts.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      options.mode = "print";
      continue;
    }
    if (arg === "-c" || arg === "--continue") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        options.continueLatest = true;
        continue;
      }
      options.continueSessionId = value;
      index += 1;
      continue;
    }
    if (arg === "--resume") {
      options.continueSessionId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--output-format") {
      const value = readValue(args, index, arg);
      if (!OUTPUT_FORMATS.has(value)) {
        throw new Error(`${arg} must be one of: ${[...OUTPUT_FORMATS].join(", ")}`);
      }
      options.outputFormat = value;
      index += 1;
      continue;
    }
    if (arg === "--acp" || arg === "--model" || arg === "--effort") {
      options[arg.slice(2)] = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      throw new Error("--provider has been removed; use --acp <provider-id>");
    }
    if (arg === "--permission-mode") {
      const value = readValue(args, index, arg);
      // 与 --output-format 一致：显式给错值要报错。归一化的宽容只用于
      // settings.json（手改坏的配置不该让客户端起不来），命令行是显式意图，
      // 静默降级会让 `--permission-mode yoloo` 看起来生效了。
      if (!PERMISSION_MODES.includes(value)) {
        throw new Error(`${arg} must be one of: ${PERMISSION_MODES.join(", ")}`);
      }
      options.permissionMode = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    promptParts.push(arg);
  }

  if (promptParts.length > 0) options.prompt = promptParts.join(" ");
  if (options.mode !== "print") {
    if (options.prompt != null) throw new Error("A prompt requires --print");
    if (options.outputFormat !== "text") {
      throw new Error("--output-format options require --print");
    }
  }

  return options;
}
