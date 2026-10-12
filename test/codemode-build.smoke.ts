import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** 手动运行：先构建两种产物。只连本机假模型，不使用用户凭据或真实 MCP。 */
test("codemode 源码、旁路 JS 包和独立二进制均能在无依赖目录执行", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-codemode-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "project");
  const bundle = path.join(dir, "bundle");
  const binary = path.join(dir, "binary");
  for (const folder of [path.join(home, ".miro"), cwd, bundle, binary]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(cwd, "fixture.txt"), "selected-value\nprivate-intermediate\n");
  for (const name of readdirSync(path.join(root, "dist"))) {
    if (name.endsWith(".js") || name.endsWith(".wasm")) copyFileSync(path.join(root, "dist", name), path.join(bundle, name));
  }
  copyFileSync(path.join(root, "dist/miro"), path.join(binary, "miro"));
  chmodSync(path.join(binary, "miro"), 0o755);
  assert.deepEqual(readdirSync(binary), ["miro"]);

  const requests: any[] = [];
  const code = 'const [file, found, matched] = await Promise.all([tools.read_file({path:"fixture.txt"}), tools.glob({pattern:"*.txt"}), tools.grep({pattern:"selected",path:"fixture.txt"})]); return {selected:file.data.content.split("\\n")[0], files:found.data.paths.length, matches:matched.data.matches.length}';
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const body = await request.json() as any;
    requests.push(body);
    const previous = body.messages.find((message) => message.role === "tool");
    const delta = previous ? { content: "build-ok" } : { tool_calls: [{ index: 0, id: "code-build", type: "function", function: { name: "codemode", arguments: JSON.stringify({ code }) } }] };
    const chunk = (value, finish) => JSON.stringify({ id: "chat-build", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] });
    return new Response(`data: ${chunk({ role: "assistant", ...delta }, null)}\n\ndata: ${chunk({}, previous ? "stop" : "tool_calls")}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  } });
  t.after(() => server.stop(true));
  writeFileSync(path.join(home, ".miro/settings.json"), JSON.stringify({ skills: false, miro: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-only", models: ["fixture"], model: "fixture",
    thinking: false, autoCompact: false, maxToolRounds: 2, streamMaxRetries: 0, codemode: { enabled: true },
  } }));
  try {
    const variants = [
      ["source", [process.execPath, path.join(root, "src/main.ts")]],
      ["bundle", [process.execPath, path.join(bundle, "main.js")]],
      ["binary", [path.join(binary, "miro")]],
    ] as const;
    for (const [name, command] of variants) {
      requests.length = 0;
      const child = Bun.spawn([...command, "-p", "--output-format", "json", "compose tools"], {
        cwd, env: { HOME: home, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        assert.equal(exit, 0, `${name}: ${stderr}\n${stdout}`);
        const result = JSON.parse(stdout);
        assert.equal(result.result, "build-ok", name);
        assert.deepEqual(result.permission_denials, [], name);
        assert.equal(requests.length, 2, `${name}: expected exactly one tool round`);
        assert.ok(requests[0].tools.some((tool) => tool.function.name === "codemode"), name);
        const messages = requests[1].messages.filter((message) => message.role === "tool");
        assert.equal(messages.length, 1, name);
        assert.equal(messages[0].tool_call_id, "code-build", name);
        assert.match(messages[0].content, /"selected":"selected-value","files":1,"matches":1/, name);
        assert.doesNotMatch(messages[0].content, /private-intermediate|Codemode sandbox|failed/, name);
        console.error(`codemode ${name}: verified`);
      } finally { clearTimeout(timer); child.kill(); await child.exited; }
    }
  } finally { server.stop(true); }
});
