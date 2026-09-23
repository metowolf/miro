import process from "node:process";
import chalk from "chalk";
import { render } from "ink";

import { App } from "./components/App.jsx";
import { useStore } from "./store.js";
import { createSyncStdout } from "./sync-stdout.js";
import { shouldWrapSyncOutput } from "./term-caps.js";
import { errorMessage } from "./utils.js";
import { formatSessionTokenUsage } from "./status-line/items.js";

// Kitty CSI-u 由 Ink 管理；tmux 只接受 xterm modifyOtherKeys 请求，再按自身的
// extended-keys 配置把 Shift+Enter 转发给 pane。两种协议需要同时开启。
const ENABLE_MODIFY_OTHER_KEYS = "\x1b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS = "\x1b[>4m";

export async function runTui(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("miro must be run in an interactive terminal. Use -p for non-interactive mode.\n");
    return 1;
  }

  // Ink 每帧会先擦除再重写；支持 DEC 2026 的终端把这两步作为原子帧提交。
  const stdout = shouldWrapSyncOutput() ? createSyncStdout(process.stdout) : process.stdout;
  process.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
  let app;
  try {
    app = render(
      <App
        continueSessionId={options.continueSessionId}
        startupAcp={options.acp}
        startupModel={options.model}
        startupEffort={options.effort}
        startupPermissionMode={options.permissionMode}
        startupInteractionMode={options.interactionMode}
      />,
      {
        exitOnCtrlC: false,
        stdout,
        kittyKeyboard: { mode: "enabled" },
      },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
  }

  const { fatalError, sessionId, sessionTokens, sessionCost } = useStore.getState();
  if (fatalError) {
    process.stderr.write(`miro: ${errorMessage(fatalError)}\n`);
    return 1;
  }
  // 摘要取会话累计值（sessionTokens / sessionCost），不是提供方最近一次读数；
  // Ctrl+C、`/exit`、裸 `exit` / `quit` 任何一条退出路径都打印同一行，
  // 提供方从未上报用量时整行不打印，不留占位文案。
  // 用量摘要与恢复命令都是离开终端后才写的旁注，压暗即可，不和 transcript 抢注意力。
  // 用 dim 而不是 gray：上面的「Done in 3s」这类系统行走的也是 Ink 的 dimColor
  // （同样落成 SGR 2），两处观感要一致。
  const usageLine = formatSessionTokenUsage(sessionTokens, sessionCost);
  if (usageLine) process.stdout.write(`\n${chalk.dim(usageLine)}\n`);
  if (sessionId) process.stdout.write(`\n${chalk.dim(`Resume this session with:\n  miro -c ${sessionId}`)}\n`);
  return 0;
}
