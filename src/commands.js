/** 斜杠命令注册表与候选生成。 */

export const SLASH_COMMANDS = [
  { name: "login", aliases: [], description: "Sign in to a subscription provider (ChatGPT, Claude, Copilot, and more)" },
  { name: "init", aliases: [], description: "Analyze codebase and generate / improve AGENTS.md (/init [extra instructions])" },
  { name: "model", aliases: [], description: "Select / switch model (/model [model] to set directly)" },
  { name: "effort", aliases: [], description: "Set effort level for model usage (/effort [level] to set directly)" },
  { name: "config", aliases: [], description: "View / change config options, incl. prompt language (/config [id] [value])" },
  { name: "statusline", aliases: [], description: "Configure status line items, order, and colors (/statusline reset to restore defaults)" },
  { name: "thinking", aliases: [], description: "Set thinking display: compact, full, or hidden (/thinking [mode])" },
  { name: "permissions", description: "Set permission mode: Auto (default) or Manual (/permissions [mode])" },
  { name: "plan", aliases: [], description: "Enter, exit, or show Plan Mode (/plan [on|off|status])" },
  { name: "resume", aliases: ["continue"], description: "Resume a previous session in this project (/resume [id] to pick directly)" },
  { name: "new", aliases: [], description: "Start a fresh session (discard current in-memory transcript)" },
  { name: "sessions", aliases: [], description: "List saved sessions for this project" },
  { name: "clear", aliases: [], description: "Clear conversation context and start a fresh session" },
  { name: "export", aliases: [], description: "Export the current conversation to a file or clipboard (/export [filename])" },
  { name: "review", aliases: [], description: "Review code changes and report prioritized findings (/review [instructions])" },
  { name: "goal", aliases: [], description: "Run a goal until it finishes (/goal <objective> | replace <objective> | status | pause | resume | cancel)" },
  { name: "simplify", aliases: [], description: "Simplify code for clarity while preserving behavior (/simplify [files or instructions])" },
  { name: "commit", aliases: [], description: "Create a git commit from the current changes (/commit [message guidance])" },
  { name: "commit-push-pr", aliases: [], description: "Commit current changes, push the branch, and open a pull request" },
  { name: "help", aliases: [], description: "Show help and available commands" },
  { name: "exit", aliases: ["quit"], description: "Exit the REPL" },
];

export function isCommandInput(input) {
  return input.startsWith("/");
}

/** 含空格即视为带参数。 */
export function hasCommandArgs(input) {
  return isCommandInput(input) && input.includes(" ");
}

/** 匹配优先级，越小越靠前。 */
function matchRank(cmd, query) {
  const name = cmd.name.toLowerCase();
  const aliases = (cmd.aliases ?? []).map((alias) => alias.toLowerCase());

  if (name === query) return 0;
  if (aliases.includes(query)) return 1;
  if (name.startsWith(query)) return 2;
  if (aliases.some((alias) => alias.startsWith(query))) return 3;
  if (name.includes(query)) return 4;
  if (cmd.description.toLowerCase().includes(query)) return 5;
  return -1;
}

function toSuggestion(cmd, query) {
  const matchedAlias =
    query !== ""
      ? (cmd.aliases ?? []).find((alias) => alias.toLowerCase().startsWith(query))
      : undefined;
  const showAlias = matchedAlias && !cmd.name.toLowerCase().startsWith(query);
  return {
    name: cmd.name,
    displayText: `/${cmd.name}${showAlias ? ` (${matchedAlias})` : ""}`,
    description: cmd.description,
  };
}

/** 输入以 "/" 开头且不含参数时生成候选。 */
export function generateCommandSuggestions(input, commands = SLASH_COMMANDS) {
  if (!isCommandInput(input) || hasCommandArgs(input)) return [];

  const query = input.slice(1).toLowerCase();

  if (query === "") {
    return [...commands]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cmd) => toSuggestion(cmd, query));
  }

  return commands
    .map((cmd) => ({ cmd, rank: matchRank(cmd, query) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
    .map((item) => toSuggestion(item.cmd, query));
}

/** 解析 "/xxx [args]"；未命中返回 null。 */
export function parseCommandInput(text, commands = SLASH_COMMANDS) {
  if (!isCommandInput(text)) return null;
  const spaceIndex = text.search(/\s/);
  const head = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).slice(1).toLowerCase();
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex).trim();

  const hit = commands.find(
    (cmd) =>
      cmd.name.toLowerCase() === head ||
      (cmd.aliases ?? []).some((alias) => alias.toLowerCase() === head)
  );
  return hit ? { key: hit.name, args } : null;
}

/** 命中 name 或 alias 时返回 name。 */
export function getCommandHandlerKey(text, commands = SLASH_COMMANDS) {
  return parseCommandInput(text, commands)?.key ?? null;
}

/** 大小写敏感地匹配 provider 推送的命令。 */
export function matchProviderCommand(text, providerCommands = []) {
  if (!isCommandInput(text)) return null;
  const spaceIndex = text.search(/\s/);
  const head = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).slice(1);
  if (!head) return null;
  return providerCommands.some((cmd) => cmd?.name === head) ? head : null;
}
