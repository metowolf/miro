import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonObject } from "../config/settings-file.ts";
import { MiroAgentClient } from "./agent-client.ts";

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "miro-client-mcp-"));
  const file = path.join(cwd, "settings.json");
  const settings = { skills: false, miro: { models: ["m1"], model: "m1" } };
  const write = (value) => writeFileSync(file, JSON.stringify(value));
  write(settings);
  const client = new MiroAgentClient({ cwd, settings, dependencies: {
    modelsFile: null, oauthModels: { getModels: () => [] },
    readSystemSettings: () => readJsonObject(file),
  } });
  t.after(async () => {
    client.close();
    await client.mcpRuntime.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { client, cwd, write };
}

test("MCP reload sees additions, edits and removals on disk without changing session preferences", async (t) => {
  const { client, write } = fixture(t);
  const config = client.config;
  const preference = client.settings.miro;
  const first = client.mcpRuntime;
  write({ miro: { model: "different" }, mcpServers: { docs: { command: "never-start-this" } } });
  const result = await client.reloadMcp();
  assert.equal(first.closed, true);
  assert.equal(result.servers[0].name, "docs");
  assert.equal(client.mcpRuntime.servers.get("docs").command, "never-start-this");
  assert.equal(client.mcpRuntime.connections.size, 0);
  assert.equal(client.config, config);
  assert.equal(client.settings.miro, preference);
  write({ mcpServers: { docs: { command: "updated-command" } } });
  await client.reloadMcp();
  assert.equal(client.mcpRuntime.servers.get("docs").command, "updated-command");
  write({});
  assert.deepEqual((await client.reloadMcp()).servers, []);
});

test("MCP reload rechecks project trust instead of loading changed project commands", async (t) => {
  const { client, cwd, write } = fixture(t);
  write({ mcpServers: { global: { command: "global-command" } } });
  mkdirSync(path.join(cwd, ".miro"));
  writeFileSync(path.join(cwd, ".miro", "mcp.json"), JSON.stringify({ mcpServers: { project: { command: "untrusted-command" } } }));
  const result = await client.reloadMcp();
  assert.deepEqual(result.servers.map(({ name }: any) => name), ["global"]);
  assert.match(result.diagnostics.join("\n"), /requires trust/);
  assert.equal(client.mcpRuntime.connections.size, 0);
});

test("MCP reload cannot replace a runtime during an active turn or after close", async (t) => {
  const { client } = fixture(t);
  const runtime = client.mcpRuntime;
  client.abortController = new AbortController();
  await assert.rejects(client.reloadMcp(), /idle session/);
  assert.equal(client.mcpRuntime, runtime);
  client.abortController = null;
  client.close();
  await assert.rejects(client.reloadMcp(), /idle session/);
});

for (const action of ["cancel", "close"]) {
  test(`MCP client ${action} aborts sign-in and prevents a late reconnect`, async (t) => {
    const { client } = fixture(t);
    const config = { name: "remote", type: "http", url: "http://127.0.0.1/mcp" };
    client.mcpRuntime.servers.set("remote", config);
    const finished = Promise.withResolvers();
    let signal;
    let reconnects = 0;
    client.dependencies.loginMcp = (received, options) => {
      assert.equal(received, config);
      signal = options.signal;
      return finished.promise;
    };
    client.mcpRuntime.reconnect = async () => { reconnects += 1; };
    const login = client.loginMcp("remote");
    await assert.rejects(client.reloadMcp(), /idle session/);
    await assert.rejects(client.loginMcp("remote"), /idle session/);
    await assert.rejects(client.prompt("do not send"), /current operation/);
    client[action]();
    assert.equal(signal.aborted, true);
    finished.resolve();
    await assert.rejects(login, { name: "AbortError" });
    assert.equal(reconnects, 0);
    assert.equal(client.mcpLoginController, null);
    if (action === "cancel") {
      await client.loginMcp("remote");
      assert.equal(reconnects, 1);
    } else {
      await assert.rejects(client.loginMcp("remote"), /idle session/);
    }
  });
}

test("MCP client keeps reconnect cancellable after successful OAuth", async (t) => {
  const { client } = fixture(t);
  client.mcpRuntime.servers.set("remote", { name: "remote", type: "http", url: "http://127.0.0.1/mcp" });
  client.dependencies.loginMcp = async () => {};
  const entered = Promise.withResolvers();
  let reconnectSignal;
  client.mcpRuntime.reconnect = (name, { signal }: any) => {
    assert.equal(name, "remote");
    reconnectSignal = signal;
    entered.resolve();
    return new Promise<any>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const login = client.loginMcp("remote");
  const rejected = assert.rejects(login, { name: "AbortError" });
  await entered.promise;
  client.cancel();
  await rejected;
  assert.equal(reconnectSignal.aborted, true);
  assert.equal(client.mcpLoginController, null);
});

test("MCP client releases the login slot after authentication errors", async (t) => {
  const { client } = fixture(t);
  client.mcpRuntime.servers.set("remote", { name: "remote", type: "http", url: "http://127.0.0.1/mcp" });
  client.dependencies.loginMcp = async () => { throw new Error("authentication failed"); };
  await assert.rejects(client.loginMcp("remote"), /authentication failed/);
  assert.equal(client.mcpLoginController, null);
  assert.doesNotThrow(() => client.assertIdle());
});