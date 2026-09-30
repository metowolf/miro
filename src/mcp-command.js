import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MIRO_DIR, readSystemSettings, writeSystemSettings } from "./settings-file.js";
import { loadMcpServers, parseMcpServers, projectMcpPath, projectMcpTrust, trustProjectMcp } from "./mcp-config.js";
import { loginMcp, logoutMcp } from "./mcp-oauth.js";
import { McpRuntime } from "./miro/mcp-runtime.js";

function readConfig(file) {
  if (!existsSync(file)) return { mcpServers: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.mcpServers || typeof parsed.mcpServers !== "object") {
    throw new Error(`${file}: expected an mcpServers object`);
  }
  return parsed;
}

function saveConfig(file, config) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function parsePair(value, flag) {
  const index = value.indexOf("=");
  if (index <= 0) throw new Error(`${flag} requires NAME=VALUE`);
  return [value.slice(0, index), value.slice(index + 1)];
}

export async function runMcpCommand(args, { cwd = process.cwd(), output = (line) => process.stdout.write(`${line}\n`),
  error = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const [command, name, ...rest] = args;
  const separator = rest.indexOf("--");
  const flags = separator < 0 ? rest : rest.slice(0, separator);
  const local = flags.includes("--local") || flags.includes("-l");
  const file = projectMcpPath(cwd);
  if (command === "trust") {
    const state = projectMcpTrust(cwd);
    if (!state.exists) throw new Error(`No project MCP file at ${state.file}`);
    if (!process.stdin.isTTY) throw new Error("Run `miro mcp trust` in a terminal to review project commands.");
    const config = readConfig(file);
    output(`Trust MCP servers in ${file}?`);
    for (const [server, entry] of Object.entries(config.mcpServers)) output(`  ${server}: ${entry.command ?? entry.url ?? "invalid entry"}`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!/^y(es)?$/i.test((await prompt.question("Trust this file? [y/N] ")).trim())) return 1;
    } finally { prompt.close(); }
    trustProjectMcp(cwd);
    output("Project MCP configuration trusted.");
    return 0;
  }
  if (command === "add") {
    if (!name) throw new Error("Usage: miro mcp add <name> [--local] [--url URL | -- command args...] ");
    const entry = { args: [], env: {}, headers: {} };
    if (separator >= 0) { entry.command = rest[separator + 1]; entry.args = rest.slice(separator + 2); }
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i];
      if (flag === "--local" || flag === "-l") continue;
      if (!["--url", "--env", "--header"].includes(flag)) throw new Error(`Unknown MCP option: ${flag}`);
      const value = flags[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--url") entry.url = value;
      if (flag === "--env") { const [key, valuePart] = parsePair(value, flag); entry.env[key] = valuePart; }
      if (flag === "--header") { const [key, valuePart] = parsePair(value, flag); entry.headers[key] = valuePart; }
    }
    if (entry.url) { delete entry.command; delete entry.args; delete entry.env; }
    else { delete entry.url; delete entry.headers; if (!entry.command) throw new Error("A stdio command or --url is required."); }
    const checked = parseMcpServers({ [name]: entry });
    if (checked.diagnostics.length) throw new Error(checked.diagnostics[0]);
    if (local) {
      const config = readConfig(file);
      config.mcpServers[name] = entry;
      saveConfig(file, config);
      output(`Saved ${name} to ${file}. Run miro mcp trust before use.`);
    } else {
      const settings = readSystemSettings();
      writeSystemSettings({ ...settings, mcpServers: { ...(settings.mcpServers ?? {}), [name]: entry } });
      output(`Saved ${name} to ${path.join(MIRO_DIR, "settings.json")}.`);
    }
    return 0;
  }
  if (command === "remove") {
    if (!name) throw new Error("Usage: miro mcp remove <name> [--local]");
    if (local) { const config = readConfig(file); delete config.mcpServers[name]; saveConfig(file, config); }
    else { const settings = readSystemSettings(); const servers = { ...(settings.mcpServers ?? {}) }; delete servers[name]; writeSystemSettings({ ...settings, mcpServers: servers }); }
    output(`Removed MCP server ${name}.`);
    return 0;
  }
  const loaded = loadMcpServers(readSystemSettings(), cwd);
  for (const diagnostic of loaded.diagnostics) error(diagnostic);
  if (command === "login" || command === "logout") {
    const config = loaded.servers.find((server) => server.name === name);
    if (!config) throw new Error(`Unknown MCP server: ${name ?? ""}`);
    if (command === "login") await loginMcp(config, { print: output });
    else { logoutMcp(config); output(`Signed out of MCP server ${name}.`); }
    return 0;
  }
  if (!command || command === "list") {
    const runtime = new McpRuntime({ ...loaded, cwd });
    let failed = loaded.diagnostics.length > 0;
    try {
      const catalog = await runtime.listTools();
      if (loaded.configured.length === 0) output("No MCP servers configured.");
      for (const server of loaded.configured.filter((entry) => !entry.enabled)) output(`${server.name} (${server.type}, disabled)`);
      for (const server of catalog.servers) {
        const result = await runtime.listTools({ server: server.name });
        const item = result.results[0];
        if (item.error) failed = true;
        output(`${server.name} (${server.type}): ${item.error ?? `${item.tools.length} tools`}`);
        if (item.tools) for (const tool of item.tools) output(`  ${tool.name}`);
      }
    } finally { await runtime.close(); }
    return failed ? 1 : 0;
  }
  throw new Error("Usage: miro mcp [add|remove|list|trust|login|logout]");
}
