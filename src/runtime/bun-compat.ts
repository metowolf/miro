// Node 运行时的 Bun 全局垫片。
//
// 背景：`bun run build:js` 产出只依赖 Node 的单体 dist/cli.js，而源码与个别依赖
// 里都有以 `typeof Bun` 分支的代码（工具的文件读写、会话 id、MCP OAuth 的回调
// 监听，以及 sandbox-runtime 的 whichSync）。与其把每个调用点都改成双实现，
// 这里在入口最先执行的地方补一层最小垫片：只有当前运行时没有 Bun 时才安装，
// `bun start` / dist/miro 完全不走这条路径。
//
// 两条约束：
//   - 只实现「调用方真的会用到」的成员。依赖一旦看到 `typeof Bun !== "undefined"`
//     就会走 Bun 分支，少一个成员就是运行时崩溃；反过来，`Bun.stringWidth` /
//     `Bun.wrapAnsi` 之外的缺失成员会被 render/ 里的 `typeof Bun.xxx === "function"`
//     判断挡住，自动回退到自带实现。
//   - 不提供 `Bun.version` 之类的探测字段（hono 用它判断旧版 Bun，undefined 即回退）。
// `wrapAnsi` 用 wrap-ansi 兜底（Ink 内部同一套依赖），否则 review 浏览器的 markdown
// 明细会退化成不换行。
import { randomBytes } from "node:crypto";
import { accessSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { access, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";

/** RFC 9562 UUIDv7：48 位毫秒时间戳 + 版本/变体位 + 随机位。 */
function randomUUIDv7() {
  const bytes = randomBytes(16);
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Bun.file 的最小子集：只覆盖 Miro 用到的取文本/字节的路径。 */
function file(path) {
  return {
    name: String(path),
    async text() { return readFile(path, "utf8"); },
    async json() { return JSON.parse(await readFile(path, "utf8")); },
    async bytes() { return new Uint8Array(await readFile(path)); },
    async arrayBuffer() {
      const buffer = await readFile(path);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    async exists() { try { await access(path); return true; } catch { return false; } },
  };
}

/** Bun.write 的最小子集，接受字符串、TypedArray、ArrayBuffer 与 Blob/Response。 */
async function write(destination, data) {
  let body;
  if (ArrayBuffer.isView(data)) body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) body = new Uint8Array(data);
  else if (typeof data?.arrayBuffer === "function") body = new Uint8Array(await data.arrayBuffer());
  else body = data;
  await writeFile(destination, body);
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
}

/** Bun.serve 的最小子集：http 回调监听（MCP OAuth 用它接授权码），只按需实现 stop。 */
function serve(options) {
  const handler = options.fetch;
  const server = createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? `${options.hostname ?? "127.0.0.1"}:${options.port ?? 0}`;
      const method = request.method ?? "GET";
      const init: any = { method, headers: request.headers };
      if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(request);
        init.duplex = "half";
      }
      const result = await handler(new Request(`http://${host}${request.url ?? "/"}`, init));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body) { response.end(); return; }
      Readable.fromWeb(result.body).pipe(response);
    })().catch((error) => {
      if (response.headersSent) { response.destroy(error); return; }
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error?.message ?? error));
    });
  });
  server.listen(options.port ?? 0, options.hostname);
  return {
    hostname: options.hostname,
    // Node 的 listen 是异步的，这里不像 Bun.serve 那样能立刻拿到真实端口；
    // Miro 只用固定回调端口，所以拿不到时回退到请求值（0 需由调用方自行等待）。
    get port() { return (server.address() as any)?.port ?? options.port ?? 0; },
    async stop() {
      server.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.once("close", resolve));
    },
    unref() { server.unref(); return this; },
  };
}

/** Bun.which 的最小子集：依赖里只看得到 PATH 查找这一用法（sandbox-runtime）。 */
function which(command) {
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const target = join(dir, command);
    try {
      if (!statSync(target).isFile()) continue;
      accessSync(target, 1 /* X_OK */);
      return target;
    } catch { /* 继续找下一个目录 */ }
  }
  return null;
}

const runtime = globalThis as any;
if (typeof runtime.Bun === "undefined") {
  // wrap-ansi 单独按需加载：Bun 路径下这份依赖根本不该被求值，
  // 而入口的静态依赖面直接决定 `--help` 这类短路路径的启动开销。
  const { default: wrapAnsi } = await import("wrap-ansi");
  runtime.Bun = { randomUUIDv7, file, write, serve, wrapAnsi, which };
}
