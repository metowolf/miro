<p align="center">
  <img src="logo.png" alt="Miro" width="120" height="120">
</p>

<h1 align="center">Miro</h1>

<p align="center">
  A terminal client for ACP-compatible coding agents.<br>
  Interactive TUI and one-shot print mode, built with Bun, React, and Ink.
</p>

<p align="center">
  <a href="./README.zh.md">中文</a>
  ·
  English
</p>

---

**miro-cli** includes a built-in agent that calls Chat Completions, OpenAI Responses, or Anthropic Messages directly with its own tool loop. Use `--acp <provider-id>` only when you want to start an [Agent Client Protocol](https://agentclientprotocol.com/) provider as a child process over stdio JSON-RPC.

## Requirements

- [Bun](https://bun.sh/) **>= 1.2**
- An API endpoint for Miro's built-in agent; an ACP binary on `PATH` is needed only for `--acp` (see [ACP providers](#acp-providers))

## Install and run

```bash
bun install
bun start
```

Build a standalone binary for the host platform:

```bash
bun run build
./dist/miro
```

`bun run build:js` emits an inspectable ESM bundle instead of a compiled binary.

Release tags (`v*`) publish Linux and macOS binaries (x64 and arm64). Local cross-compiles use the same flags as CI:

```bash
bun run scripts/build.js --target bun-linux-x64 --outfile dist/miro-linux-amd64
```

## Usage

```bash
miro
miro -p "Analyze this project"
echo "Summarize this input" | miro -p
miro -p --output-format json "Fix the tests"
miro --model hy3
miro --effort high
miro --acp claude
miro --continue
miro --resume <session-id>
./dist/miro -c <session-id>
```

From source, pass flags after `--`:

```bash
bun start -- -c <session-id>
bun start -- -p "Analyze this project"
```

### Options

| Flag | Description |
|------|-------------|
| `-p`, `--print` | Run one non-interactive request and exit |
| `--output-format <text\|json>` | Print-mode output (requires `--print`) |
| `--acp <provider-id>` | Start this available ACP provider by id; otherwise use Miro's built-in agent |
| `--model <model>` | Model by value or display name (interactive and print modes) |
| `--effort <level>` | Effort by value or display name (interactive and print modes; not saved) |
| `-c`, `--continue [id]` | Resume a session; omit `id` to use the latest for this project |
| `--resume <id>` | Resume the given session id |
| `--permission-mode <m>` | miro permission mode: `auto` (default) or `manual` |
| `--mode <mode>` | Interaction mode: `default` or `plan` |
| `-h`, `--help` | Print help |

`--output-format` is only valid with `-p` / `--print`; `--acp`, `--model`, and `--effort` also work when starting the interactive TUI and apply only to this run. `--acp` accepts only an available ACP provider id; the removed `--provider` flag reports a migration error. A bare prompt without `--print` is an error. `-c` without an id continues the latest session for the selected mode (and ACP id); `--resume` always requires an id.

## Commands

Type these in the interactive composer:

| Command | Description |
|---------|-------------|
| `/init [extra]` | Analyze the codebase and create or improve `AGENTS.md` |
| `/login` | Sign in to a subscription provider (ChatGPT/Codex, Claude, Copilot, OpenRouter, Kimi, or xAI) |
| `/model [model]` | Select or switch model |
| `/effort [level]` | Set the current model's effort level |
| `/config [id] [val]` | View or change ACP session config options |
| `/thinking [mode]` | Set thinking display to `compact` (default), `full`, or `hidden`; no mode opens a picker |
| `/permissions [mode]` | miro permission mode: `auto` (default) or `manual`; no mode opens a picker |
| `/plan [on\|off\|status]` | Enter, leave, or inspect Plan Mode (miro only) |
| `/statusline [reset]` | Configure status-line items, order, and colors |
| `/review [text]` | Review code changes; with no argument opens a picker (uncommitted, branch, commit, or custom instructions) |
| `/goal [text]` | Work toward an objective across as many turns as it takes until the model reports it done or blocked; while a response is running, a new objective safely interrupts it and takes over. No text shows the current goal; `replace`, `status`, `pause`, `resume`, and `cancel` manage it (miro only). |
| `/simplify [text]` | Simplify code while preserving behavior; accepts paths or free-form instructions |
| `/commit [text]` | Create one commit from the current changes; optional text guides the message |
| `/commit-push-pr` | Create one commit, push the branch to `origin`, and open a pull request with the CLI for that host (`gh`, `glab`, or `tea`) |
| `/resume [id]` | Resume a saved session; no id opens the picker |
| `/continue [id]` | Alias for `/resume` |
| `/new` | New session without clearing the terminal |
| `/sessions` | List saved sessions for the current project |
| `/clear` | New ACP session and clear the terminal display and visible transcript |
| `/export [file]` | Export the conversation (clipboard or `.txt` file) |
| `/help` | Show help |
| `/exit` | Exit (`exit`, `/quit`, `quit`) and print the session usage summary |
| `!<command>` | Run a local shell command; output is attached to the next prompt |

Provider-specific slash commands advertised by ACP are forwarded as-is.

`/commit-push-pr` reads the `origin` remote and picks the matching CLI: `gh` on GitHub, `glab` on GitLab, `tea` on Gitea or Forgejo. When that CLI is missing, unauthenticated, or the host has none at all (Bitbucket, an unrecognised self-hosted instance), it still commits and pushes, then reports the URL for opening the pull request by hand instead of inventing one. A repository with no `origin` remote stops after the local commit.

While a turn is running, ordinary prompts are queued in FIFO order. Slash commands run immediately. `!command` is refused while busy.

## Shortcuts

| Key | Action |
|-----|--------|
| Enter | Send the prompt |
| Shift+Enter | Insert a newline (Miro enables Kitty and xterm extended-key reporting; unsupported terminals still cannot distinguish it from Enter) |
| `?` | Shortcut cheatsheet (empty composer) |
| ↑ / ↓ | Input history or completion |
| Ctrl+M | Select or switch model (needs a terminal that supports the kitty keyboard protocol, otherwise the key is the same as Enter) |
| Shift+Tab | Cycle interaction mode (`Default` / `Plan`) |
| Ctrl+O | Open the full-screen Review window: live and retained thinking, shell output, and tool details |
| Ctrl+Q | Review, edit, reorder, or remove queued messages |
| Ctrl+L | Clear the terminal display (not the ACP session) |
| Ctrl+C | Clear the input draft; on an empty input, cancel the turn and press again within 2 seconds to exit. Any normal exit — this one, `/exit`, or a bare `exit`/`quit` — prints a one-line session usage summary, e.g. `Stat ↑12.4k ↓2.1k  R84.3k W6.2k CH81.9%  $0.018`: ↑/↓ are the session totals of input and output tokens, `R`/`W` the cache read and write tokens (the segment is added once the session has a cache reading; the direction with no reading is shown as 0), `CH` the cache hit rate (read / (uncached input + read + write)), and the trailing amount the session cost (three decimals below one unit, four below a tenth of a cent — miro adds each main-loop LLM request, ACP uses the agent's cumulative `usage_update` cost). The line is omitted entirely when the provider never reported usage or cost |
| Esc | Close shortcut help, or interrupt a running turn |

`@` completes file paths (`git ls-files`, with a filesystem fallback). Multiline pastes stay a single submission: they are collapsed while editing and restored to their original text in the transcript after submission.

## Rendering

Agent replies are rendered as Markdown in the terminal: headings, lists, tables, fenced code blocks, and inline code are styled, and `$...$` / `$$...$$` math is rendered with Unicode glyphs. Unterminated math delimiters in a stream are passed through verbatim until the turn ends, and unsupported LaTeX is left as plain text. This is display-only — your message text is never altered.

Thinking uses three disclosure levels. While a block is streaming, miro extracts a leading `**bold title**` when available and keeps the activity line stable. That live line also carries the timing and, once the provider has reported usage, the token counts, e.g. `Thinking… (12s · ↑5 ↓2.9k)`: input and output from the provider's latest reading — each miro LLM call, or the ACP `PromptResponse` usage at the end of a turn. Providers that never report usage leave the hint out. Finalized blocks follow the persisted `thinkingDisplay` setting: `compact` keeps a title-and-duration summary, `full` also prints the Markdown body, and `hidden` leaves it out of the visible transcript. `/thinking` opens the picker; `/thinking compact|full|hidden` applies a mode directly. Ctrl+O opens a full-screen review browser for the live thinking block, the live shell output, and everything retained in the transcript: the list selects an item with ↑/↓ and opens its detail with Enter, and Left/Right inside a detail moves to the previous or next item of that list.

Visible session files retain only thinking metadata. Raw `agent_thought_chunk` messages are also omitted from ACP traffic logs by default; set `"recordRawThinking": true` in `~/.miro/settings.json` only when those sensitive details are intentionally needed for debugging.

## ACP providers

Miro uses its built-in agent by default. Start an ACP provider explicitly with `miro --acp <id>`; its binary must be on `PATH`. Add or override ACP definitions in `~/.miro/settings.json` under `providers.<id>` = `{ command | bin, args, name }`. Miro stores an ACP provider's last `/model` and `/effort` choice as `model` / `effort` in that same entry.

| Id | Name | Binary |
|----|------|--------|
| `pi` | Pi | `pi-acp` |
| `cursor` | Cursor | `cursor-agent` |
| `claude` | Claude | `claude-agent-acp` |
| `codex` | Codex | `codex-acp` |

### Built-in agent

Miro's built-in agent does not start a child process or speak ACP: it calls an LLM API directly, runs its own tool loop (`read_file`, `write_file`, `edit_file`, `terminal`, `grep`, `glob`, `spawn_agent`, `update_tasks`), and emits the same events as ACP clients. It supports OpenAI Chat Completions (the default), OpenAI Responses, and Anthropic Messages. It is always available, with no binary to install. Long conversations are compacted automatically; when that happens, both the transcript and the model see a `Context compacted` notice.

Commands whose output is a report — `/review`, `/simplify`, `/commit`, `/commit-push-pr`, and `/init` — run in a **separate context**. Their prompt (rubric, pre-read git context, your instructions) and every file the model reads while working stay in a history built for that one run; only a one-line record of the command (added when the run starts) and its final answer are appended to the session. A review that read fifty files therefore stops crowding out the conversation, while the answer still lands in the transcript, so a follow-up like "fix the second finding" still has something to point at. `Esc` cancels the run: the command's record and whatever was already streamed stay in the session, matching what the transcript shows, so a resumed session sees the same history. This is miro-only: an ACP provider keeps its conversation history inside the provider process, where miro can neither isolate nor trim it, so the same commands run as ordinary turns there and stay in the conversation.

List miro LLM endpoints in `~/.miro/models.json`. `/model` reloads this file, so edits apply without restarting:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`api` may be `openai-completions`, `openai-responses`, or `anthropic-messages` (at provider or model level). `apiKey` accepts a literal, `$ENV_VAR` / `${ENV_VAR}`, or `!command` (resolved when a request is sent). Selecting a model also selects that provider's `baseUrl` / `api` / `apiKey`. The picker value and the saved top-level `model` preference are always `provider/id` (for example `ollama/llama3.1:8b`). `/model llama3.1:8b` and `--model llama3.1:8b` still match when that id is unique.

For reasoning models, set `"reasoning": true`. `thinkingLevelMap`: a string maps miro's standard effort level to the provider value, `null` hides an unsupported level, omitted levels use the default mapping through `high`, and omitted `xhigh` / `max` are unsupported. `/effort` only shows levels supported by the current model.

If `models.json` is missing or has no usable models, miro falls back to the `miro` object in `~/.miro/settings.json`:

```json
{
  "miro": {
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      { "id": "gpt-4o-mini", "name": "GPT-4o mini", "contextWindow": 128000 }
    ],
    "model": "gpt-4o-mini",
    "protocol": "chat-completions",
    "effort": "medium",
    "thinking": true,
    "sandbox": { "enabled": false }
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `protocol` | `chat-completions` | Fallback when `models.json` is unused: `chat-completions`, `openai-responses`, or `anthropic-messages`. Also configurable with `$MIRO_PROTOCOL`. Catalog models carry their own `api` instead. |
| `baseUrl` | Protocol-specific default | Chat Completions / Responses default to `https://api.openai.com/v1`; Anthropic Messages defaults to `https://api.anthropic.com`. `$MIRO_BASE_URL` overrides it. Catalog `baseUrl` wins for models listed in `models.json`. |
| `apiKey` | `$MIRO_API_KEY`, then protocol-specific key | Uses `$ANTHROPIC_API_KEY` for Anthropic Messages and `$OPENAI_API_KEY` for the two OpenAI protocols. In `models.json`, `apiKey` may also be `$ENV` or `!command`. |
| `models` | `gpt-4o-mini`, `gpt-4o`, `deepseek-chat` | Used only when `~/.miro/models.json` has no usable entries. Strings, or `{ id, name, contextWindow }` entries. |
| `model` / `effort` / `thinking` | first model / `medium` / `true` | Fallback defaults; the top-level `model` / `effort` preference takes precedence when it matches an available option. Same `/model`, `/effort`, and `/config` flows as ACP providers. |
| `maxToolRounds` | unlimited | Maximum tool-loop rounds per turn. There is no default cap because auto compaction already bounds the context; set a number to stop a runaway turn. |
| `temperature` | unset | Sampling temperature passed to the API. |
| `permissionMode` | `auto` | `auto` never asks the user; only Terminal calls with `risk_level: high` or `sandbox: false` receive an isolated model review, while all other tools run directly. `manual` confirms writes and commands. Unknown values and legacy `ask`, `plan`, or `yolo` fall back to `auto`. |
| `sandbox.enabled` | `false` | When `true`, the `terminal` tool runs commands inside the `@anthropic-ai/sandbox-runtime` network sandbox: no network unless `allowedDomains` grants it per call. The tool keeps its name in both modes and only gains the sandbox-only parameters. Filesystem access still uses host permissions. Requires the platform prerequisites of `@anthropic-ai/sandbox-runtime`; it never falls back to an unrestricted shell. |

Use `/config sandbox on` or `/config sandbox off` to update this setting and switch the command tool's sandboxing in the current session.

`/model` and `/effort` choices are remembered per provider. Miro uses top-level `model` / `effort` in `settings.json`, and records the model as `provider/id`; an ACP provider uses its own `providers.<id>` entry. The `model` / `effort` entries inside `miro` are fallback defaults when the top-level preference is absent or unavailable. Miro's `Default` / `Plan` interaction mode is independent from its `Auto` / `Manual` permission mode; `Shift+Tab` cycles the interaction mode.

### Skills

Miro supports the `SKILL.md` convention (Agent Skills). Skills are discovered at startup from `~/.miro/skills`, `<cwd>/.miro/skills`, `~/.agents/skills`, and `<cwd>/.agents/skills`. Extra directories go in a top-level `skills` array in `~/.miro/settings.json`; `"skills": false` turns the feature off. A directory containing `SKILL.md` is one skill and is not scanned any deeper, while a bare `*.md` file counts only when its frontmatter has a `description`. When two skills share a name, the later root wins (project over user, explicit paths last) and the shadowed file is reported in the client's diagnostics.

Frontmatter uses YAML core syntax and must be a mapping with a non-empty string `description`. Quote values that look like numbers or booleans if you intend them as text. Unicode escapes, block scalars, and bounded aliases are supported; custom tags and merge-key expansion are not. Malformed YAML, duplicate keys, excessive alias expansion, or frontmatter exceeding 64 KiB cause the skill to be skipped with a diagnostic.

Only each skill's name, description, and file path go into the system prompt, inside `<available_skills>`; the body is loaded on demand with `read_file`. `/skill:<name> [args]` injects that skill's body into the message instead, which works in `-p` runs too:

```bash
/skill:pdf extract the tables from invoice.pdf
miro -p "/skill:pdf extract the tables from invoice.pdf"
```

`disable-model-invocation: true` keeps a skill out of the model-visible catalog while leaving `/skill:` available for hand-picked use. Skills only add instructions — they never add capabilities: Manual approval and Auto's Terminal review policy remain unchanged.

This is miro-only. ACP providers own their skills, and any command they advertise (for example `skill:<name>`) reaches miro as a normal provider command.

## Sessions and context

Visible transcripts are stored at `~/.miro/sessions/<flattened-cwd>/<acp|miro>/<sessionId>.jsonl` and can be resumed with `/resume`, `--continue`, or `--resume`. Raw ACP traffic is isolated under `<flattened-cwd>/acp/raw/`, so it cannot collide with the resumable transcript for the same session ID. The project directory name is the cwd with every non-alphanumeric character collapsed to `-` (no hash, so it stays readable). Raw thinking chunks are omitted unless `recordRawThinking` is explicitly enabled. Persistence errors are non-fatal; older transcript layouts are not read. A visible session is identified by its runtime **and** its session ID. `/resume`, `/sessions`, and `--continue` show only sessions for the current startup mode; to resume an ACP transcript, restart with that transcript's `--acp <id>`. Empty conversations leave nothing behind: the transcript file (and its runtime directory) is created only when the first user or assistant message is recorded, and zero-message transcripts are not listed by `/resume`, `/sessions`, or `--continue` (raw ACP traffic logs are exempt — they still start as soon as the session opens).

`~/.miro/AGENTS.md` and `./AGENTS.md` are loaded at startup (blank or unreadable files skipped; identical text deduplicated) and sent with the **first ordinary prompt**. Resumed sessions skip AGENTS.md reinjection. A failed first request restores injection so you can retry.

Composer history is independent of the transcript, at `~/.miro/history.jsonl`.

## Configuration

Model, effort, prompt-language, status-line, and custom ACP-provider preferences live in `~/.miro/settings.json`. Its legacy top-level `provider` value is ignored. Miro LLM endpoints and models live in `~/.miro/models.json`; subscription OAuth credentials created by `/login` live separately in `~/.miro/auth.json`. `/login` is available in the Miro TUI and opens the provider's browser or device-code flow. OAuth subscriptions and API keys are separate authentication paths; keep `auth.json` private and use subscription credentials only for your own local work. `/config` changes both the live ACP options advertised as `configOptions` and miro's own `language` option.

### Permission mode

Miro offers `Auto` and `Manual`, with `Auto` as the default. `/permissions` selects a mode directly or opens a picker; this setting is independent from Plan Mode.

| Mode | Behavior |
|------|----------|
| `auto` | Default. Never opens a user approval prompt. Non-Terminal tools run directly; Terminal is auto-reviewed only for `risk_level: high` or `sandbox: false` |
| `manual` | Writes, edits, deletes, moves, and commands need approval; read, search, and task updates run directly |

`Auto` does not parse Terminal command text, so `rm`, `curl`, redirection, interpreters, and heredocs have no special lexical rules; `low` and `medium` run directly. For `high` or `sandbox: false`, it projects user intent, earlier tool calls, and the proposed action to an isolated classifier with no tools, never tool results. Only an explicit approval runs the command. A block, error, or uncertain result is returned directly to the next model round without asking the user. The verdict shows on the tool row, and a block spells out the reviewer's reason there.

```bash
miro --permission-mode auto
miro --permission-mode manual
/permissions manual
```

`/permissions` and CLI overrides affect only the current run; set `miro.permissionMode` to persist a startup preference. Legacy `ask`, `plan`, `yolo`, and unknown settings fall back to `auto`, but invalid explicit `--permission-mode` values are errors.

When configured, the `permission-mode` status-line item shows `AUTO` or `MANUAL`. Headless miro runs print the effective policy to stderr while keeping stdout clean for results.

### Plan mode

Plan Mode separates investigation and design from implementation. Enter it with `/plan`, `/plan on`, or Shift+Tab; the model can also request entry, which requires confirmation. It keeps the normal Terminal, file-write, subagent, and local-command capabilities; planning rather than implementation is a behavioral instruction, not a read-only runtime restriction. The canonical plan is stored under `~/.miro/sessions/<project>/miro/plans/<session>/<plan-id>.md`.

In either interactive mode, the agent can ask up to four structured questions with single-select or multi-select answers, optional Markdown previews, custom text, and notes. In Plan Mode it then submits the canonical file for review. Approving freezes that exact text, returns to Default Mode, and starts a fresh implementation turn from the frozen snapshot. Requesting changes keeps Plan Mode active; rejecting exits without implementation. Plan state is persisted with the session. Plan Mode cannot start while a goal is actively running. Non-interactive runs and subagents never expose the question UI.

`miro -p --mode plan "Design this change"` is intentionally non-interactive: it prints a plan and exits without asking questions, opening approval UI, or implementing the result. ACP providers keep their own mode behavior.

### Spinner verbs

The waiting-verb animation on the status line is customizable via `spinnerVerbs` in `~/.miro/settings.json`:

```json
{
  "spinnerVerbs": { "mode": "append", "verbs": ["thinking", "planning", "searching"] }
}
```

`mode` is `append` (add to the built-in verb list) or `replace` (use only your list). A blank or invalid `verbs` falls back to the defaults.

### Prompt language

`/config language English` (or `en`, `en-us`), `/config language Chinese` (or `zh`, `zh-cn`, `中文`) or `/config language Cantonese` (or `yue`, `zh-hk`, `zh-yue`, `粤语`, `粵語`) sets the language of miro's own built-in workflow prompts (`/init`, `/review`, `/simplify`, `/commit`, and `/commit-push-pr`) and saves it as `language` in `~/.miro/settings.json`. English is the default, and unknown values fall back to it. The ACP session config and your own messages are untouched; the prompt text itself lives under `src/prompts/<language>/`, so adding a language means adding a directory there.

### Status line

`/statusline` picks items, order, and colors interactively. `/statusline reset` restores the defaults. Confirming writes `statusLine` and `statusLineUseColors` together.

Default items: `["model-with-reasoning", "current-dir"]`. An empty array hides the status line. Unknown ids are ignored (one-time warning); items without data are skipped.

While a goal exists, the right end of the same line shows `◎ /goal active (4s)`: the goal's status plus how long it has actually been running (paused time and time after it stopped are not counted, matching the budget). It is not a configurable item — it appears and disappears with the goal — and the ACP provider, which has no goal mode, never shows it. An empty status line hides it along with the rest of the bar.

Available ids include `model`, `model-with-reasoning`, `reasoning`, `mode`, `permission-mode`, `current-dir`, `project-name`, `hostname`, `git-branch`, `run-state`, `provider`, `session-id`, `session-title`, `miro-version`, `context-used`, `context-remaining`, `context-window-size`, `task-progress`, `goal`, `used-tokens`, `input-tokens`, `output-tokens`, `thought-tokens`, and `session-cost`. Context, token, cost, and session-title items need the provider to report them. `used-tokens`, `input-tokens`, `output-tokens`, `thought-tokens`, and `session-cost` are session totals — miro adds each main-loop LLM request (subagent runs and compaction summaries are not counted), ACP uses the agent's cumulative `PromptResponse` snapshot (and its cumulative `usage_update` cost) — so they can exceed the latest-reading hint on the activity line. `permission-mode` shows `AUTO` or `MANUAL` for the miro provider, and stays hidden when no miro permission mode is available. `goal` shows the active goal's status and progress, and stays hidden without a goal — the ACP provider has no goal mode, so it is always hidden there. These ids also accept short aliases: `model-name` (`model`), `permissions` (`permission-mode`), `project` / `project-root` (`project-name`), `status` (`run-state`), `thread-id` / `thread-title` (`session-id`), `version` (`miro-version`), `context-usage` (`context-used`), `goal-status` (`goal`).

## License

ISC
