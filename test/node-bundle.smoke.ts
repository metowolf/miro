// 手动运行：`bun run build:js` 之后再跑本脚本（会验证 dist/cli.js 在 Node 下自包含）。
//
// 覆盖三条最容易被运行时差异打破的路径：
//   1. `--help` 短路：入口 + 参数解析 + 帮助文本，不需要任何 Bun API；
//   2. 一轮 read_file 的 print：文件工具、会话持久化与 Bun 垫片；
//   3. 一轮 codemode：Worker（独立入口）与 QuickJS WASM 在 Node 下同样可用。
//
// 产物只从「只剩 dist 几个文件」的隔离目录里跑，确保它不依赖仓库与 node_modules。
// 不在默认 `bun test` 发现内（文件名是 *.smoke.ts），与其它 smoke 一致。
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("dist/cli.js 能在 Node 下独立启动并跑完带工具的回合", async (t) => {
  const node = Bun.which("node");
  if (!node) { t.skip("node is not available on PATH"); return; }

  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-node-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "project");
  const bundle = path.join(dir, "bundle");
  for (const folder of [path.join(home, ".miro"), cwd, bundle]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(cwd, "fixture.txt"), "selected-value\n");
  let entries;
  try {
    entries = readdirSync(path.join(root, "dist"));
  } catch {
    assert.fail("dist is missing: run `bun run build:js` first");
  }
  for (const name of entries) {
    if (name === "cli.js" || name === "codemode-worker.js" || name.endsWith(".wasm")) {
      copyFileSync(path.join(root, "dist", name), path.join(bundle, name));
    }
  }
  assert.ok(readdirSync(bundle).includes("cli.js"), "dist/cli.js is missing: run `bun run build:js` first");

  const run = (args) => Bun.spawn([node, path.join(bundle, "cli.js"), ...args], {
    cwd, env: { HOME: home, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
  });

  /** 假模型：第一轮发一个工具调用，第二轮收尾，返回 call 与看到的请求。 */
  const withModel = async (call) => {
    const requests = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const payload = await request.json();
      requests.push(payload);
      const previous = payload.messages.find((message) => message.role === "tool");
      const delta = previous
        ? { content: "node-ok" }
        : { tool_calls: [{ index: 0, id: "node-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
      const chunk = (value, finish) => JSON.stringify({ id: "chat-node", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] });
      return new Response(`data: ${chunk({ role: "assistant", ...delta }, null)}\n\ndata: ${chunk({}, previous ? "stop" : "tool_calls")}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    } });
    writeFileSync(path.join(home, ".miro/settings.json"), JSON.stringify({ skills: false, miro: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-only", models: ["fixture"], model: "fixture",
      thinking: false, autoCompact: false, maxToolRounds: 2, streamMaxRetries: 0, codemode: { enabled: true },
    } }));
    const child = run(["-p", "--output-format", "json", "run it"]);
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert.equal(exit, 0, `${stderr}\n${stdout}`);
      return { result: JSON.parse(stdout), requests };
    } finally { clearTimeout(timer); child.kill(); await child.exited; server.stop(true); }
  };

  const help = run(["--help"]);
  const [helpOut, , helpExit] = await Promise.all([new Response(help.stdout).text(), new Response(help.stderr).text(), help.exited]);
  assert.equal(helpExit, 0);
  assert.match(helpOut, /^Miro CLI/);

  const read = await withModel({ name: "read_file", arguments: { path: "fixture.txt" } });
  assert.equal(read.result.result, "node-ok");
  assert.deepEqual(read.result.permission_denials, []);
  assert.match(read.result.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/, "the Node shim must still mint UUIDv7 session ids");
  assert.equal(read.requests.length, 2, "expected exactly one tool round");
  const readResults = read.requests[1].messages.filter((message) => message.role === "tool");
  assert.equal(readResults.length, 1);
  assert.match(readResults[0].content, /selected-value/);

  const code = 'const file = await tools.read_file({path:"fixture.txt"}); return file.data.content.split("\\n")[0]';
  const sandboxed = await withModel({ name: "codemode", arguments: { code } });
  const codemodeResults = sandboxed.requests[1].messages.filter((message) => message.role === "tool");
  assert.equal(codemodeResults.length, 1);
  assert.match(codemodeResults[0].content, /"selected-value"|selected-value/, JSON.stringify(codemodeResults[0].content));
  assert.match(codemodeResults[0].content, /read_file: ok/, "the QuickJS worker must run under Node");
});
