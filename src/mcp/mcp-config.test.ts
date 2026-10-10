import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpServers, parseMcpServers, projectMcpTrust, toAcpMcpServers, trustProjectMcp, updateMcpServerSetting } from "./mcp-config.ts";
import { AcpClient } from "../acp/acp-client.ts";
import { AcpSessionRecorder } from "../acp/session-recorder.ts";

const settings = { mcpServers: {
  local: { command: "node", args: ["server.js", "secret-argument"], env: { TOKEN: "secret-env" } },
  remote: { type: "http", url: "https://example.test/mcp?key=secret-query", headers: { Authorization: "secret-header" } },
} };

test("MCP configuration preserves valid entries, skips disabled servers and isolates invalid entries", () => {
  const result = parseMcpServers({
    ...settings.mcpServers,
    disabled: { disabled: true },
    bad: { type: "sse", url: "secret-value" },
    invalidArgs: { command: "node", args: [1] },
    invalidEnv: { command: "node", env: { KEY: false } },
    invalidTimeout: { command: "node", timeoutMs: -1 },
    badUrl: { url: "https://user:secret-password@example.test/mcp" },
  });
  assert.deepEqual(result.servers.map((server) => server.name), ["local", "remote"]);
  assert.equal(result.diagnostics.length, 5);
  assert.ok(!JSON.stringify(result.diagnostics).includes("secret"));
  assert.equal(result.servers[0].connectTimeoutMs, 10_000);
  assert.equal(result.servers[0].timeoutMs, 60_000);
  assert.equal(parseMcpServers([]).diagnostics.length, 1);
  assert.deepEqual(parseMcpServers(undefined), { servers: [], diagnostics: [] });
});

test("ACP converts MCP configuration and only sends advertised HTTP transports", () => {
  const client = new AcpClient({ settings });
  const warnings = [];
  client.on("stderr", (message) => warnings.push(message));
  assert.deepEqual(client.mcpServers, toAcpMcpServers(parseMcpServers(settings.mcpServers).servers));
  assert.deepEqual(client.mcpServers[0].env, [{ name: "TOKEN", value: "secret-env" }]);
  client.agentCapabilities = {};
  client.negotiateMcpServers();
  assert.deepEqual(client.sessionNewParams().mcpServers.map((server) => server.name), ["local"]);
  assert.match(warnings[0], /does not support http/);
  const compatible = new AcpClient({ settings });
  compatible.agentCapabilities = { mcpCapabilities: { http: true } };
  compatible.negotiateMcpServers();
  assert.equal(compatible.sessionNewParams().mcpServers.length, 2);
  assert.equal(compatible.mcpServers[1].type, "http");
  const direct = new AcpClient({ mcpServers: [{ name: "direct", command: "node", args: [], env: [] }] });
  assert.equal(direct.mcpServers[0].name, "direct");
});

test("ACP logs omit all MCP connection details without mutating protocol messages", () => {
  const recorder = new AcpSessionRecorder();
  for (const method of ["session/new", "session/load"]) {
    const message = { method, params: { cwd: "/work", mcpServers: toAcpMcpServers(parseMcpServers(settings.mcpServers).servers) } };
    const original = structuredClone(message);
    recorder.record("client", message);
    assert.deepEqual(message, original);
  }
  const logged = JSON.stringify(recorder.buffer);
  assert.ok(!logged.includes("secret"));
  assert.ok(!logged.includes("example.test"));
  assert.match(logged, /redacted/);
  assert.match(logged, /remote/);
});

test("project MCP config replaces global only after trusting its exact contents", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "miro-mcp-project-"));
  const file = path.join(cwd, ".miro", "mcp.json");
  const trustFile = path.join(cwd, "trust.json");
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: "project" } } }));
  const global = { mcpServers: { local: { command: "global" } } };
  assert.equal(loadMcpServers(global, cwd, { trustFile }).servers[0].command, "global");
  trustProjectMcp(cwd, trustFile);
  assert.equal(loadMcpServers(global, cwd, { trustFile }).servers[0].command, "project");
  writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: "changed" } } }));
  const changed = loadMcpServers(global, cwd, { trustFile });
  assert.equal(changed.servers[0].command, "global");
  assert.match(changed.diagnostics[0], /requires trust/);
  trustProjectMcp(cwd, trustFile);
  writeFileSync(file, JSON.stringify({ mcpServers: { local: { type: "sse", url: "https://example.test/sse" } } }));
  trustProjectMcp(cwd, trustFile);
  const invalid = loadMcpServers(global, cwd, { trustFile });
  assert.equal(invalid.servers[0].command, "global");
  assert.match(invalid.diagnostics[0], /type must be/);
});

test("MCP 忽略已移除的 exposure 配置且不改写原配置", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "miro-mcp-exposure-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const original = { mcpServers: { local: { command: "node", exposure: "hidden", toolExposure: { echo: "deferred" } } } };
  const snapshot = structuredClone(original);
  const loaded = loadMcpServers(original, cwd, { trustFile: path.join(cwd, "trust.json") });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.servers[0].exposure, undefined);
  assert.equal((loaded.configured[0] as { exposure?: string }).exposure, undefined);
  assert.deepEqual(original, snapshot);
});

test("项目设置只更新已加载且仍可信的版本，不隐式授权外部改动", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "miro-mcp-update-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, ".miro", "mcp.json");
  const trustFile = path.join(cwd, "trust.json");
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: "original" } } }));
  trustProjectMcp(cwd, trustFile);
  const stale = loadMcpServers({}, cwd, { trustFile }).configured[0];
  const changed = JSON.stringify({ mcpServers: { local: { command: "changed" }, extra: { command: "unreviewed" } } });
  writeFileSync(file, changed);
  assert.throws(() => updateMcpServerSetting(stale, "enabled", false, cwd, { trustFile }), /reload and trust/);
  assert.equal(readFileSync(file, "utf8"), changed);
  assert.equal(projectMcpTrust(cwd, trustFile).trusted, false);
  trustProjectMcp(cwd, trustFile);
  const current = loadMcpServers({}, cwd, { trustFile }).configured[0];
  assert.throws(() => updateMcpServerSetting(current, "exposure", "hidden", cwd, { trustFile }), /Unsupported MCP setting/);
  updateMcpServerSetting(current, "enabled", false, cwd, { trustFile });
  assert.equal(projectMcpTrust(cwd, trustFile).trusted, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.local.enabled, false);
});

test("启用全局和项目 MCP 服务时清除旧 disabled 标记", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "miro-mcp-enable-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const trustFile = path.join(cwd, "trust.json");
  let saved = { mcpServers: { local: { command: "node", disabled: true, enabled: false } } };
  const global = loadMcpServers(saved, cwd, { trustFile }).configured[0];
  updateMcpServerSetting(global, "enabled", true, cwd, {
    readSettings: () => saved, writeSettings: (next) => { saved = next; },
  });
  assert.equal(saved.mcpServers.local.disabled, undefined);
  assert.equal(loadMcpServers(saved, cwd, { trustFile }).servers.length, 1);
  const file = path.join(cwd, ".miro", "mcp.json");
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: "node", disabled: true } } }));
  trustProjectMcp(cwd, trustFile);
  const project = loadMcpServers({}, cwd, { trustFile }).configured[0];
  updateMcpServerSetting(project, "enabled", true, cwd, { trustFile });
  assert.equal(loadMcpServers({}, cwd, { trustFile }).servers.length, 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.local.disabled, undefined);
});

test("不可读的项目 MCP 文件仅产生诊断，不影响全局服务和 ACP 初始化", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "miro-mcp-unreadable-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, ".miro", "mcp.json"), { recursive: true });
  const trustFile = path.join(cwd, "trust.json");
  const result = loadMcpServers(settings, cwd, { trustFile });
  assert.equal(result.servers.length, 2);
  assert.equal(result.trust.trusted, false);
  assert.match(result.diagnostics[0], /Cannot read project MCP configuration/);
  assert.throws(() => trustProjectMcp(cwd, trustFile), /Cannot read/);
  assert.doesNotThrow(() => new AcpClient({ cwd, settings }));
});

test("MCP OAuth scope 保留合法空格分隔权限，拒绝无效值且不回显配置", () => {
  const scope = "openid profile offline_access logs:read";
  const valid = parseMcpServers({ remote: { url: "https://example.test/mcp", oauth: { scope } } });
  assert.equal(valid.servers[0].oauth.scope, scope);
  assert.deepEqual(valid.diagnostics, []);
  for (const invalid of ["", " ", "openid  profile", "openid\nsecret", "openid\tprofile", "\"secret\"", null, 3, ["secret"], {}]) {
    const result = parseMcpServers({ remote: { url: "https://example.test/mcp", oauth: { scope: invalid } } });
    assert.equal(result.servers.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.doesNotMatch(result.diagnostics[0], /secret/);
  }
});
