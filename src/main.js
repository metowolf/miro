// CLI 入口。这里是启动路径上的最内层，刻意只保留「解析参数 + 短路退出」需要的
// 最小依赖：cli.js / config.js / utils.js。headless 与 tui 两棵大树一律按需动态
// import，编译产物的入口 chunk 因此只有几 KB。
//
// 为什么要这么切：`bun build --compile` 的冷启动开销几乎全在 JS 模块图的实例化
// （Bun 运行时本身约 3ms），而 --help 根本不需要那条 3MB 级的图。分块后
// `--help` 只加载入口 + 两个小 chunk；重路径因为 chunk 更小，字节码反序列化反而
// 比单块内联略快。改动分组时要保住入口的这份「薄」，别把重模块挪回来。
import process from "node:process";

import { parseCliArgs } from "./cli.js";
import { HELP } from "./config.js";
import { errorMessage } from "./utils.js";

let options;
try {
  options = parseCliArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`miro: ${errorMessage(error)}\nUse --help for usage.\n`);
  process.exit(1);
}

// 短路路径：不碰 headless / tui，也不读 ~/.miro。
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (options.continueLatest && options.continueSessionId == null) {
  const { latestSessionId } = await import("./session-store.js");
  options.continueSessionId = latestSessionId(process.cwd(), options.acp ?? "miro");
  if (options.continueSessionId == null) {
    process.stderr.write("miro: no saved sessions for this project to continue.\n");
    process.exit(1);
  }
}

if (options.mode === "print") {
  // print 模式不加载 tui（React / Ink 那一整棵），反之亦然。
  const { runHeadless } = await import("./headless.js");
  process.exitCode = await runHeadless(options);
} else {
  const { runTui } = await import("./tui.jsx");
  process.exitCode = await runTui(options);
}
