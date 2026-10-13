// CLI 入口。这里是启动路径上的最内层，刻意只保留「解析参数 + 短路退出」需要的
// 最小依赖：cli.ts / config.ts / utils.ts。headless 与 tui 两棵大树一律按需动态
// import，编译产物的入口 chunk 因此只有几 KB。
//
// 为什么要这么切：`bun build --compile` 的冷启动开销几乎全在 JS 模块图的实例化
// （Bun 运行时本身约 3ms），而 --help 根本不需要那条 3MB 级的图。分块后
// `--help` 只加载入口 + 两个小 chunk；重路径因为 chunk 更小，字节码反序列化反而
// 比单块内联略快。改动分组时要保住入口的这份「薄」，别把重模块挪回来。
//
// 唯一的例外是 Node 垫片：它必须排在其它 import 之前求值，Node 下先把 Bun 全局
// 补上（src/runtime/bun-compat.ts），后面按需 import 的模块才敢直接用 Bun API；
// Bun 运行时里这个模块只做一次 typeof 判断，不加载任何额外依赖。
import "./runtime/bun-compat.ts";
import process from "node:process";

import { parseCliArgs } from "./cli/cli.ts";
import { APP_VERSION, HELP } from "./config/config.ts";
import { errorMessage } from "./utils.ts";

if (process.argv[2] === "mcp") {
  try {
    const { runMcpCommand } = await import("./mcp/mcp-command.ts");
    process.exitCode = await runMcpCommand(process.argv.slice(3));
  } catch (error) {
    process.stderr.write(`miro mcp: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
} else {

let options;
try {
  options = parseCliArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`miro: ${errorMessage(error)}\nUse --help for usage.\n`);
  process.exit(1);
}

// 短路路径：不碰 headless / tui，也不读 ~/.miro。
// --help 优先于 --version：两个都给时输出更有信息量的那份。
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (options.version) {
  process.stdout.write(`${APP_VERSION}\n`);
  process.exit(0);
}

if (options.continueLatest && options.continueSessionId == null) {
  const { latestSessionId } = await import("./session/session-store.ts");
  options.continueSessionId = latestSessionId(process.cwd(), options.acp ?? "miro");
  if (options.continueSessionId == null) {
    process.stderr.write("miro: no saved sessions for this project to continue.\n");
    process.exit(1);
  }
}

if (options.mode === "print") {
  // print 模式不加载 tui（React / Ink 那一整棵），反之亦然。
  const { runHeadless } = await import("./cli/headless.ts");
  process.exitCode = await runHeadless(options);
} else {
  const { runTui } = await import("./cli/tui.tsx");
  process.exitCode = await runTui(options);
}
}
