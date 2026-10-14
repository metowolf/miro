// `bun run build:js` 的入口：产出一个可以直接 `node dist/cli.js` 跑的单体 ESM。
//
// 与 scripts/build.ts（自带 Bun 运行时的 dist/miro）的区别：
//   - target: "node"，产物只依赖 Node 内置模块，Bun 专有 API 由
//     src/runtime/bun-compat.ts 在 Node 下补垫片（入口最先加载）。
//   - 关闭 splitting：动态 import 全部内联，dist/cli.js 自包含；入口的按需加载
//     因此不再省启动时间，这条路径只求单文件好分发。
//
// 入口分两次构建：codemode Worker 必须是独立文件（worker 不能内联进主 bundle），
// 而命名规则按 [name] 走，分两次才能一次得到 cli.js、一次得到 codemode-worker.js；
// 顺带不会碰 `scripts/build.ts --no-compile` 留下的 dist/main.js。
// QuickJS WASM 按 file import 落在同一目录，运行时靠 import.meta.url 定位。
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import stubDevtools from "./bun-plugin-stub-devtools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf-8"));

const build = (entrypoint: string, name: string) => Bun.build({
  entrypoints: [entrypoint],
  outdir: "dist",
  naming: { entry: `${name}.js`, asset: "[name]-[hash].[ext]" },
  plugins: [stubDevtools],
  target: "node",
  format: "esm",
  splitting: false,
  // 只压空白与语法，不改标识符：Ink 依赖组件名，重命名会破坏它。
  minify: { whitespace: true, syntax: true, identifiers: false },
  define: {
    __MIRO_VERSION__: JSON.stringify(pkg.version),
    __MIRO_BUNDLED__: "true",
    // 让 react / react-reconciler 走 production 构建，dev 版体积近一倍且带运行时检查。
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

const results = [
  await build("src/main.ts", "cli"),
  await build("src/miro/tools/codemode-worker.ts", "codemode-worker"),
];

if (results.some((result) => !result.success)) {
  for (const result of results) {
    for (const log of result.logs) console.error(log.message ?? log);
  }
  process.exit(1);
}

// dist/cli.js 同时是 npm 包里的 bin：npm 靠 shebang 决定用哪个解释器启动，
// 缺了它（或没有可执行位）装出来就是一个跑不起来的命令，所以这里补上。
const cliPath = join(here, "../dist/cli.js");
const cliSource = readFileSync(cliPath, "utf-8");
if (!cliSource.startsWith("#!")) writeFileSync(cliPath, `#!/usr/bin/env node\n${cliSource}`);
chmodSync(cliPath, 0o755);

console.log("Bundled: dist/cli.js (node dist/cli.js 或 npm bin) + codemode-worker.js, QuickJS WASM");
