import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { runMcpCommand } from "./mcp-command.js";

test("MCP CLI writes project entries without trusting or starting them", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "miro-mcp-cli-"));
  const output = [];
  const options = { cwd, output: (line) => output.push(line) };
  assert.equal(await runMcpCommand(["add", "docs", "--local", "--", "node", "server.js"], options), 0);
  const file = path.join(cwd, ".miro", "mcp.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.docs.command, "node");
  assert.match(output[0], /trust/);
  await assert.rejects(runMcpCommand(["add", "bad/name", "--local", "--", "node"], options), /server name/);
  assert.equal(await runMcpCommand(["remove", "docs", "--local"], options), 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers, {});
});

test("MCP CLI only parses scope options before the command separator", () => {
  const home = mkdtempSync(path.join(tmpdir(), "miro-mcp-cli-scope-"));
  const cwd = path.join(home, "project");
  const moduleUrl = new URL("./mcp-command.js", import.meta.url).href;
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      import { runMcpCommand } from ${JSON.stringify(moduleUrl)};
      const options = { cwd: ${JSON.stringify(cwd)}, output: () => {} };
      await runMcpCommand(["add", "long", "--", "node", "server.js", "--local"], options);
      await runMcpCommand(["add", "short", "--", "node", "server.js", "-l"], options);
    `], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(cwd, ".miro", "mcp.json")), false);
    const { mcpServers } = JSON.parse(readFileSync(path.join(home, ".miro", "settings.json"), "utf8"));
    assert.deepEqual(mcpServers.long.args, ["server.js", "--local"]);
    assert.deepEqual(mcpServers.short.args, ["server.js", "-l"]);
    const local = spawnSync(process.execPath, ["--eval", `
      import { runMcpCommand } from ${JSON.stringify(moduleUrl)};
      await runMcpCommand(["add", "project", "-l", "--", "node", "server.js", "--local"],
        { cwd: ${JSON.stringify(cwd)}, output: () => {} });
    `], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 });
    assert.equal(local.status, 0, local.stderr);
    const config = JSON.parse(readFileSync(path.join(cwd, ".miro", "mcp.json"), "utf8"));
    assert.deepEqual(config.mcpServers.project.args, ["server.js", "--local"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});