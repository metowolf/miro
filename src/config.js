import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const APP_NAME = "miro";
export const APP_VERSION =
  typeof __MIRO_VERSION__ !== "undefined"
    ? __MIRO_VERSION__
    : JSON.parse(
        readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
          "utf-8",
        ),
      ).version;

export const PROVIDERS = [
  { id: "pi", name: "Pi", bin: "pi-acp", args: [] },
  { id: "cursor", name: "Cursor", bin: "cursor-agent", args: ["acp"] },
  { id: "claude", name: "Claude", bin: "claude-agent-acp", args: [] },
  { id: "codex", name: "Codex", bin: "codex-acp", args: [] },
  { id: "miro", name: "Miro", kind: "miro" },
];

/** Miro 自带进程内 agent，不需要 PATH 上的二进制。 */
export const MIRO_PROVIDER_ID = "miro";

export function isMiroProvider(provider) {
  return provider?.kind === "miro" || provider?.id === MIRO_PROVIDER_ID;
}

export const MAX_TRANSCRIPT_LENGTH = 500_000;

export const CLEAR_TERMINAL = "\u001B[2J\u001B[3J\u001B[H";

export const BASH_PREVIEW_LINES = 20;

export const DYNAMIC_BASH_PREVIEW_LINES = 8;

export const THOUGHT_PREVIEW_LINES = 6;

/** 工具标题下命令正文展开的物理行数上限，超出以 +N lines 收尾。 */
export const COMMAND_PREVIEW_ROWS = 3;

/** thinking 动态区的 UI 刷新间隔；ACP chunk 仍会完整记录，但不逐条触发 React 更新。 */
export const THOUGHT_UI_FLUSH_MS = 50;

/**
 * 思考行实时估算的采样间隔，按动画时钟的 tick 计（5 × 100ms = 500ms 一个桶）。
 *
 * 估算要把整段思考正文按 cell 宽度重新分段，跟着 50ms 一批的思考刷新等于每秒
 * 二十次全量重算；而这一行数字每批只变个位数。按桶取值后同一个桶里的渲染结果
 * 逐字相同，Ink 比较输出后直接跳过写入，动态区只剩 StatusVerb 那个 spinner。
 */
export const THOUGHT_STAT_SAMPLE_TICKS = 5;

export const PLAN_MAX_ROWS = 20;

export const HELP = `Miro CLI

An interactive and non-interactive terminal client with a built-in coding agent
and optional ACP-compatible providers.

Usage:
  miro [OPTIONS]

Examples:
  miro
  miro -p "Analyze this project"
  miro -p --mode plan "Design an implementation"
  echo "Summarize this input" | miro -p
  miro -p --output-format json "Fix the tests"
  miro --continue
  miro --resume <session-id>
  ./dist/miro -c <session-id>

Commands:
  /login              Sign in to a subscription provider
  /init [extra]       Analyze the codebase and create or improve AGENTS.md
  /model [model]      Select or switch model; match by display name or value
  /effort [level]     Select or set the current model's effort level
  /config [id] [val]  View or change config options (ACP session options plus
                      miro's own "language" for built-in prompts)
  /statusline [reset] Configure status line items, order, and colors; reset
                      restores the defaults
  /thinking [mode]    Set thinking display: compact summary (default), full
                      body, or hidden; no mode opens the picker
  /permissions [mode] Set miro permissions: auto (default, routine operations
                      without confirmation) or manual (confirm writes and commands);
                      no mode opens the picker
  /plan [on|off]      Enter or leave Plan Mode; without an argument,
                      toggle it (built-in agent only)
  /resume [id]        Resume a saved session; no id opens the session picker
  /continue [id]      Alias for /resume
  /new                Start a new session without clearing the terminal
  /sessions           List saved sessions for the current project
  /clear              Start a new session and clear the terminal and transcript
  /compact [text]     Summarize earlier context; optional summary instructions
  /export [file]      Save the conversation to a text file; no file opens
                      export options (clipboard or file)
  /review [text]      Review code changes and report prioritized findings; no
                      text opens the review presets (branch, uncommitted,
                      commit, or custom instructions)
  /simplify [text]    Simplify code for clarity while preserving behavior; text
                      may be file paths or free-form instructions; no text
                      opens the simplify presets
  /goal [text]        Work toward an objective across as many turns as it takes,
                      until the model reports it done or blocked; no text shows
                      the current goal; also status, pause, resume, cancel
                      (built-in agent only)
  /commit [text]      Draft a commit message from the current changes and
                      create a single commit; text becomes extra guidance for
                      the message; no text commits the pending changes as-is
  /commit-push-pr     Commit current changes, push the branch to origin, and
                      open a pull request with the CLI for that host (gh, glab,
                      or tea)
  /help               Show this help message
  /exit               Exit (aliases: exit, /quit, quit)
  !<command>          Run a local shell command; its output is included with
                      your next ordinary prompt

Options:
  -p, --print          Run one non-interactive request and exit
  --output-format <f>  Non-interactive output: text (default) or json
  --acp <provider-id>  Start the specified available ACP provider. Without this
                       option miro always uses its built-in miro agent.
  --model <model>      Select a model by value or display name
  --effort <level>     Select an effort level by value or display name; works
                       with -p and when starting the TUI (including resume),
                       for this run only (does not save preferences)
  -c, --continue [id]  Continue a session by id; without an id, use the most
                       recent saved session in the current project
  --resume <id>        Resume the specified saved session by id
  --permission-mode <m>  Miro permissions: auto (default) or manual
                       (works with -p and when starting the TUI).
                       auto never asks; only high-risk or sandbox-opt-out
                       Terminal calls receive an isolated model review
  --mode <mode>        Interaction mode: default or plan. In print
                       mode, plan returns a visible plan without implementing it
  -h, --help           Print this help message

Shortcuts:
  Enter                Send the prompt
  ?                    Show keyboard shortcuts (empty input)
  ↑/↓                  Browse input history or completion choices
  Ctrl+M               Select or switch model (needs a terminal that
                       supports the kitty keyboard protocol)
  Shift+Tab            Cycle interaction mode (Default / Plan)
  Ctrl+O               Browse live and retained thinking, shell output and
                       tool details in the Review window
  Ctrl+Q               Review, edit, reorder, or remove queued messages
  Ctrl+L               Clear the terminal and displayed transcript
  Ctrl+C               Clear the input draft; on an empty input, cancel the
                       task; press again within 2 seconds to exit
  Esc                  Close shortcut help, or interrupt a running turn

Providers:
  pi                   Pi (pi-acp)
  cursor               Cursor (cursor-agent)
  claude               Claude (claude-agent-acp)
  codex                Codex (codex-acp)
  Miro includes an agent that talks to Chat Completions, OpenAI Responses,
  or Anthropic Messages directly and needs no external binary. Use
  "miro --acp <provider-id>" to enter an ACP
  provider; only ACP providers whose binaries are available on PATH can be
  selected. Prefer ~/.miro/models.json for
  LLM endpoints (pi-compatible providers table), e.g.
  {"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","api":"openai-completions","apiKey":"ollama","models":[{"id":"llama3.1:8b"}]}}}
  Opening /model reloads that file. If it is missing or empty, fall back to
  the "miro" object in ~/.miro/settings.json, e.g.
  {"miro":{"baseUrl":"https://api.openai.com/v1","models":["gpt-4o-mini"]}}
  protocol accepts chat-completions (default), openai-responses, or
  anthropic-messages. baseUrl defaults to the selected protocol's endpoint;
  apiKey uses $MIRO_API_KEY, then $OPENAI_API_KEY or
  $ANTHROPIC_API_KEY; models accepts strings or { "id", "name",
  "contextWindow" } entries.
  Provider-specific slash commands advertised by ACP are forwarded as-is.
  Add or override providers with the "providers" object in
  ~/.miro/settings.json, e.g.
  {"providers":{"demo":{"command":"demo-cli","args":["acp"],"name":"Demo"}}}
  Each entry maps an id to { "command", "args", "name", "sessionMeta" }
  (args, name, and sessionMeta are optional; "bin" is accepted as an alias
  for "command"). sessionMeta is forwarded as session/new _meta so agents
  that key on fields like agentId can bind the session. Entries sharing an
  id with a built-in provider override it. miro also records that
  provider's last /model and /effort choice as "model" / "effort" in the
  same entry, so built-in providers may have an entry without "command".

Sessions:
  Visible transcripts are saved under
  ~/.miro/sessions/<flattened-cwd>/<acp|miro>/ and can be resumed with
  /resume, --continue, or --resume. Raw ACP traffic is isolated under
  ~/.miro/sessions/<flattened-cwd>/acp/raw/.

Context:
  ~/.miro/AGENTS.md and ./AGENTS.md are loaded at startup and sent to the
  agent with the first ordinary prompt, when present.
  While a response is running, ordinary prompts are queued in order.
  File paths can be completed with @; multiline pastes are kept as one input.

Configuration:
  ~/.miro/settings.json  System settings: statusLine, statusLineUseColors,
                         language (built-in prompt language), providers
                         (custom ACP providers), and per-provider saved
                         model / effort preferences (miro keeps its
                         preference at the top level)
  ~/.miro/models.json    Miro LLM providers and models (pi-compatible)
  /config                Live ACP session options advertised in configOptions,
                         plus miro's own "language" option

Permission mode:
  /permissions auto     Default: never asks the user; only high-risk or
                        sandbox-opt-out Terminal calls are auto-reviewed
  /permissions manual   Writes, edits, deletes, moves, and commands need approval
  Permission mode is independent from Default / Plan interaction mode.
  Configure miro.permissionMode in ~/.miro/settings.json to change the startup
  default. Unknown values,
  including legacy ask, fall back to auto; --permission-mode ask is invalid.
  Auto does not parse command text. A Terminal review that cannot explicitly
  approve the action is denied and returned to the next model round; it never
  falls back to user approval.

Plan mode:
  /plan                Toggle Default / Plan for the built-in agent
  /plan status         Show the current interaction mode
  Shift+Tab            Cycle Default -> Plan
  Plan Mode keeps the normal tool capabilities while focusing the agent on
  investigation and design. Approving a proposed plan starts a
  fresh implementation turn in Default mode. --mode plan is non-interactive:
  it prints the plan and exits without implementing it.

Prompt language:
  /config language English  Use English for miro's built-in workflow prompts
                            (default)
  /config language Chinese  Use Chinese for those prompts
  /config language Cantonese
                            Use Cantonese for those prompts
  Only miro's own built-in prompts are affected; the ACP session config and
  your own messages are untouched. The choice is saved as "language" in
  ~/.miro/settings.json, e.g. {"language":"chinese"}
  Unknown values fall back to English.

Status line:
  Use /statusline to select and order items or toggle colors interactively;
  /statusline reset restores the default items and color setting.
  Set "statusLine" in ~/.miro/settings.json to an ordered array of item ids,
  e.g. {"statusLine":["model-with-reasoning","current-dir","task-progress"]}
  An empty array hides the status line; omitting the field uses the defaults
  ["model-with-reasoning","current-dir"]. Unknown ids are ignored with a
  one-time warning, and items without data are skipped.
  Available ids:
    model (model-name)      model-with-reasoning   reasoning
    mode                    current-dir            project-name (project)
    permission-mode         hostname               git-branch
    run-state (status)       provider               session-id (thread-id)
    provider                session-id (thread-id) session-title
    miro-version (version)  context-used           context-remaining
    context-window-size     task-progress          used-tokens
    input-tokens            output-tokens          thought-tokens
    session-cost
  Context, token, cost, and session-title items require the ACP provider to
  report them; they are omitted otherwise. permission-mode shows AUTO or
  MANUAL for Miro's built-in agent, and is hidden when no mode is available.

`;
