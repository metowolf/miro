// `bun run build` 的入口。
//
// 二进制打包用 `bun build --compile`，产物是自带 Bun 运行时的单文件可执行文件
// dist/miro。
//
// 走 JS API 而不是纯 CLI，是因为 `bun build --compile` 的命令行形式没法加载插件，
// 而我们需要 stub 掉 ink 的可选依赖 react-devtools-core（详见
// scripts/bun-plugin-stub-devtools.js）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import stubDevtools from "./bun-plugin-stub-devtools.js";

// --outfile=xxx / --outfile xxx，用于交叉编译时区分产物名
const args = process.argv.slice(2);
const readFlag = (name) => {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

const outfile = readFlag("outfile") ?? "dist/miro";
const target = readFlag("target"); // 如 bun-linux-x64、bun-darwin-arm64
// --no-compile：只打包成 dist/main.js，不编译二进制，便于排查产物
const compile = !args.includes("--no-compile");

// 把 package.json 的 version 打进产物；compile 后运行在 /$bunfs，不能再靠旁路 package.json。
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf-8"),
);

const result = await Bun.build({
  entrypoints: ["src/main.js"],
  plugins: [stubDevtools],
  define: {
    __MIRO_VERSION__: JSON.stringify(pkg.version),
  },
  // minify 会破坏 Ink 依赖的函数名/组件名，这里保持关闭。
  // format: "esm" —— compile 路径下 Bun 默认按 CJS 解析，入口的顶层 await 会直接报错。
  // bytecode —— 预编译成字节码嵌进二进制，冷启动少一次 3 MB 级 JS 的解析/编译。
  // splitting: true —— 让 src/main.js 的按需 import 真的切成独立 chunk。Bun 默认
  // 不分块，会把 tui/headless 整棵图内联进入口，入口于是必须先加载 3 MB 才轮到
  // `--help` 短路：实测 `--help` 约 26ms -> 6ms，重路径（TUI / print）反而略快
  // （chunk 更小，字节码反序列化更快）。代价是 --no-compile 会输出 dist/chunk-*.js，
  // 必须与 dist/main.js 放在同一目录。
  // autoloadBunfig: false —— 避免 cwd 里的 bunfig.toml preload 在独立二进制
  // 启动前就把进程搞崩。
  ...(compile
    ? {
        format: "esm",
        bytecode: true,
        splitting: true,
        compile: {
          outfile,
          ...(target ? { target } : {}),
          autoloadBunfig: false,
        },
      }
    : { target: "bun", format: "esm", splitting: true, outdir: "dist" }),
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message ?? log);
  }
  process.exit(1);
}

console.log(compile ? `Built binary: ${outfile}` : "Bundled: dist/main.js (+ dist/chunk-*.js)");
