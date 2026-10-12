import assert from "node:assert/strict";
import test from "node:test";
import { CODEMODE_LIMITS, runCodemode } from "./codemode-runtime.ts";
import { READ_FILE_DEFINITION } from "./read-file.ts";
import { MCP_CALL_DEFINITION } from "./mcp.ts";

const definitions = [READ_FILE_DEFINITION, MCP_CALL_DEFINITION];
const run = (code: string, executeNested: any = async () => ({ output: "ok", structuredContent: { value: 42 } }), limits: any = CODEMODE_LIMITS) =>
  runCodemode({ code }, { executeNested }, definitions, limits);

function deferred() {
  let resolve: (value?: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { promise, resolve };
}

test("codemode 使用真实 QuickJS 执行 async body 并返回选定的结构化结果", async () => {
  const calls = [];
  const result = await run('const r = await tools.read_file({path:"a"}); text(r.data.value); return {value:r.data.value + 1}', async (definition, args) => {
    calls.push([definition.name, args]);
    return { output: "中间原文不应自动回灌", structuredContent: { value: 42 } };
  });
  assert.equal(result.failed, false);
  assert.deepEqual(calls, [["read_file", { path: "a" }]]);
  assert.match(result.output, /42\n\{"value":43\}/);
  assert.doesNotMatch(result.output, /中间原文/);
  assert.match(result.output, /read_file: ok/);
});

test("codemode 不注入宿主能力、写工具、递归入口和跨执行 store", async () => {
  const code = 'return [typeof process, typeof require, typeof fetch, typeof setTimeout, "terminal" in tools, "write_file" in tools, "codemode" in tools, load("saved")]';
  await run('store("saved", 123)');
  const result = await run(code);
  assert.equal(result.failed, false);
  assert.match(result.output, /\["undefined","undefined","undefined","undefined",false,false,false,null\]/);
});

test("codemode 校验输入并允许脚本处理真实工具错误", async () => {
  let called = 0;
  const executor = async () => { called += 1; return { output: "远端失败", failed: true }; };
  const invalid = await run('await tools.read_file({path:42})', executor);
  assert.equal(invalid.failed, true);
  assert.match(invalid.output, /Invalid read_file arguments/);
  assert.equal(called, 0);
  const caught = await run('try { await tools.read_file({path:"a"}) } catch (e) { text(e.message) }', executor);
  assert.equal(caught.failed, false);
  assert.match(caught.output, /远端失败/);
  assert.match(caught.output, /read_file: error/);
  for (const input of [{ code: "" }, { code: "return 1", extra: true }, { code: "x".repeat(65537) }, []]) {
    assert.match((await runCodemode(input, { executeNested: executor }, definitions)).error, /expected/);
  }
});

test("codemode 调用数和 UTF-8 数据预算不能靠 catch 绕过", async () => {
  for (const [code, limits, pattern] of [
    ['for(let i=0;i<4;i++){try{await tools.read_file({path:"a"})}catch{}}', { maxCalls: 2 }, /tool-call limit/],
    ['try{await tools.read_file({path:"中".repeat(100)})}catch{}', { maxCallBytes: 100 }, /per-call data budget/],
    ['for(let i=0;i<4;i++){await tools.read_file({path:"a"})}', { maxTotalBytes: 70 }, /cumulative tool data budget/],
  ] as const) {
    const result = await run(code, undefined, { ...CODEMODE_LIMITS, ...limits });
    assert.equal(result.failed, true);
    assert.match(result.output, pattern);
  }
  const oversized = await run('await tools.read_file({path:"a"})', async () => ({ output: "中".repeat(100) }), { ...CODEMODE_LIMITS, maxCallBytes: 100 });
  assert.equal(oversized.failed, true);
  assert.match(oversized.output, /per-call data budget/);
});

test("codemode 返回输出严格限长且保留失败说明", async () => {
  const result = await run('text("x".repeat(40000)); throw new Error("重要错误")');
  assert.equal(result.failed, true);
  assert.ok(result.output.length <= CODEMODE_LIMITS.maxOutputChars);
  assert.match(result.output, /重要错误/);
  assert.match(result.output, /Calls \(0\): none/);
  assert.match(result.output, /output truncated/);
});

test("codemode CPU 死循环和微任务循环均能被 Worker 超时终止", async () => {
  for (const code of ['while(true){}', 'while(true){await Promise.resolve()}']) {
    const result = await run(code, undefined, { ...CODEMODE_LIMITS, timeoutMs: 200 });
    assert.equal(result.failed, true);
    assert.match(result.output, /timed out/);
  }
});

test("codemode 取消后等待不消费 signal 的宿主任务收尾且不启动排队调用", async () => {
  const started = deferred();
  const release = deferred();
  const controller = new AbortController();
  let called = 0;
  let finished = false;
  const execution = runCodemode({ code: 'await Promise.all(Array.from({length:12},()=>tools.mcp_call({server:"s",name:"n",arguments:{}})))' }, {
    signal: controller.signal,
    executeNested: async () => { called += 1; started.resolve(); await release.promise; return { output: "ok" }; },
  }, definitions).then((result) => { finished = true; return result; });
  await started.promise;
  controller.abort(new Error("stop now"));
  await Bun.sleep(40);
  assert.equal(finished, false);
  assert.equal(called, 1);
  release.resolve();
  const result = await execution;
  assert.equal(result.failed, true);
  assert.match(result.output, /stop now/);
  assert.match(result.output, /verify before retrying/);
  assert.equal(called, 1);
});

test("codemode return 后停止未 await 调用并等待实际宿主完成", async () => {
  let completed = false;
  const result = await run('tools.read_file({path:"a"}); return "early"', async (_definition, _args, { signal }) => {
    await Bun.sleep(30);
    assert.equal(signal.aborted, true);
    completed = true;
    return { output: "done" };
  });
  assert.equal(completed, true);
  assert.equal(result.failed, true);
  assert.match(result.output, /Unawaited or cancelled/);
});

test("codemode QuickJS 堆耗尽后失败，下次执行仍是独立 VM", async () => {
  const result = await run('const values = []; for(let i=0;i<1000000;i++) values.push({i, text:"x".repeat(100)}); return values.length', undefined,
    { ...CODEMODE_LIMITS, memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 2000 });
  assert.equal(result.failed, true);
  assert.match(result.output, /memory|allocation/i);
  const next = await run('return 42');
  assert.equal(next.failed, false);
  assert.match(next.output, /^42/);
});
