import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readTool } from "./read-file.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { mcpListToolsTool, mcpCallTool } from "./mcp.ts";
import { normalizeMcpResult } from "../../mcp/mcp-runtime.ts";

async function fixture(t, files) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "miro-structured-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [name, content] of Object.entries<string>(files)) await writeFile(path.join(cwd, name), content);
  return cwd;
}

test("read_file 程序化分页没有行号，空文件和续读状态明确", async (t) => {
  const cwd = await fixture(t, { "a.txt": "one\ntwo\nthree\n", "empty.txt": "" });
  const read = readTool(cwd);
  const first = await read({ path: "a.txt", limit: 2 });
  assert.deepEqual(first.structuredContent, { path: path.join(cwd, "a.txt"), content: "one\ntwo", offset: 0, lineCount: 2, nextOffset: 2, truncated: true });
  const next = await read({ path: "a.txt", offset: 2 });
  assert.deepEqual(next.structuredContent, { path: path.join(cwd, "a.txt"), content: "three", offset: 2, lineCount: 1, nextOffset: null, truncated: false });
  assert.deepEqual((await read({ path: "empty.txt" })).structuredContent, { path: path.join(cwd, "empty.txt"), content: "", offset: 0, lineCount: 0, nextOffset: null, truncated: false });
});

test("glob 数据保留排序路径和数量截断而不混入提示", async (t) => {
  const cwd = await fixture(t, { "b.txt": "ok", "a.txt": "ok" });
  const glob = globTool(cwd);
  assert.deepEqual((await glob({ pattern: "*.txt" })).structuredContent, { path: cwd, paths: ["a.txt", "b.txt"], truncated: false });
  const limited: any = (await glob({ pattern: "*.txt", limit: 1 })).structuredContent;
  assert.equal(limited.paths.length, 1);
  assert.equal(limited.truncated, true);
  assert.deepEqual((await glob({ pattern: "*.none" })).structuredContent, { path: cwd, paths: [], truncated: false });
});

test("grep 数据只列命中行，不混入 context；标记行截断和未搜索文件", async (t) => {
  const cwd = await fixture(t, { "a.txt": "before\nneedle\nafter", "binary.txt": "\0needle", "wide.txt": `needle ${"x".repeat(600)}` });
  const grep = grepTool(cwd);
  const single: any = (await grep({ path: "a.txt", pattern: "needle", context: 1 })).structuredContent;
  assert.deepEqual(single, { path: path.join(cwd, "a.txt"), matches: [{ path: "a.txt", line: 2, text: "needle", truncated: false }], skippedFiles: 0, truncated: false });
  const all: any = (await grep({ pattern: "needle", glob: "*.txt" })).structuredContent;
  assert.equal(all.matches.length, 2);
  assert.equal(all.matches[1].truncated, true);
  assert.equal(all.skippedFiles, 1);
  assert.equal(all.truncated, true);
});

test("MCP 发现与远端 structuredContent 保留原对象，普通 output 不变", async () => {
  const catalog = { results: [{ server: "s", tools: [{ name: "echo", inputSchema: {}, outputSchema: { type: "object" } }] }] };
  const data = { count: 2 };
  const result = normalizeMcpResult({ content: [{ type: "text", text: "hello" }], structuredContent: data });
  const runtime = { listTools: async () => catalog, callTool: async () => result };
  assert.deepEqual((await mcpListToolsTool(runtime)({ server: "s" })).structuredContent, catalog);
  assert.deepEqual((await mcpCallTool(runtime)({})).structuredContent, data);
  assert.match(result.output, /hello/);
  assert.equal(normalizeMcpResult({ content: [{ type: "text", text: "ok" }] }).structuredContent, undefined);
});
