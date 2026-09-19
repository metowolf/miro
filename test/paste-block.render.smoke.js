/**
 * Composer 粘贴折叠的渲染验证脚本（非 bun test 用例，手动运行）：
 *   bun test/paste-block.render.smoke.js
 *
 * 用 Ink 的 renderToString 直接渲染 Composer，并向它派发一个 bracketed paste
 * 序列，确认输入框里只出现一行占位标记（而不是几十行原文）。
 */
import { render } from "ink";
import { EventEmitter } from "node:events";
import React from "react";
import { PassThrough } from "node:stream";

import { Composer } from "../src/components/Composer.jsx";
import { InputHistory } from "../src/input-history.js";

const COLUMNS = 80;

/** 伪造一个可写 TTY，收集 Ink 的输出帧。 */
function makeStdout() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = COLUMNS;
  stream.rows = 30;
  const frames = [];
  stream.on("data", (chunk) => frames.push(String(chunk)));
  return { stream, frames };
}

/** 伪造一个可读 TTY，支持 Ink 的 readable 读取路径。 */
function makeStdin() {
  const stream = new EventEmitter();
  let buffer = "";
  stream.isTTY = true;
  stream.setEncoding = () => {};
  stream.setRawMode = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => {
    if (!buffer) return null;
    const out = buffer;
    buffer = "";
    return out;
  };
  stream.push = (data) => {
    buffer += data;
    stream.emit("readable");
  };
  return stream;
}

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const { stream: stdout, frames } = makeStdout();
const stdin = makeStdin();
const submitted = [];
const inputHistory = new InputHistory();

// 显式 interactive：Ink 默认取 `!isInCi && stdout.isTTY`，而 `is-in-ci` 只看环境里有没有
// CI / CONTINUOUS_INTEGRATION。命中就只刷 <Static>、动态区整个不渲染，这里的断言读的正是
// 动态区那一帧，于是本地全绿、CI 上成片报红。假 TTY 是脚本自己造的，交互与否不该外部说了算。
const app = render(
  React.createElement(Composer, {
    disabled: false,
    onSubmit: (text, display) => submitted.push({ text, display }),
    inputHistory,
  }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true }
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
/**
 * 取最近一帧「有实际画面」的输出：Ink 会单独发出只含控制序列的帧
 * （开关 bracketed paste 的 `?2004h`、同步刷新的 `?2026l` 等），
 * 这些帧不含输入框，不能拿来断言。以提示符 ❯ 作为画面标记。
 */
const plain = () => {
  for (let i = frames.length - 1; i >= 0; i--) {
    const text = stripAnsi(frames[i]);
    if (text.includes("❯") || text.includes("!")) return text;
  }
  return "";
};

await wait(60);
check("the initial render shows the prompt", plain().includes("❯"), plain().slice(0, 120));

// 同一个 stdin chunk 内先收到普通输入、再收到 bracketed paste 时，React 可能
// 尚未来得及重渲染。paste 必须基于同步镜像追加，不能覆盖刚输入的前缀。
const mergedBody = "first\nsecond";
stdin.push(`before \u001B[200~${mergedBody}\u001B[201~`);
await wait(80);
check("the merged event keeps the text typed before the paste", plain().includes("before [Pasted text #1 +1 lines]"));
stdin.push("\r");
await wait(80);
check(
  "the merged event submits the full content",
  submitted[0]?.text === `before ${mergedBody}`,
  JSON.stringify(submitted).slice(0, 120)
);
submitted.length = 0;

// 40 行原文，走 bracketed paste 通道
const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
stdin.push(`\u001B[200~${body}\u001B[201~`);
await wait(80);

const afterPaste = plain();
check("the composer shows the placeholder block", afterPaste.includes("[Pasted text #1 +39 lines]"), afterPaste.slice(0, 200));
check("the pasted text is not laid out in the composer", !afterPaste.includes("line 20"));
check(
  "the composer still holds a single line of text",
  afterPaste.split("\n").filter((line) => line.includes("line")).length <= 1
);

// 在块后追加文字，再回车提交
stdin.push(" 请解释");
await wait(60);
check("typing can continue after the block", plain().includes("[Pasted text #1 +39 lines] 请解释"));

stdin.push("\r");
await wait(80);

check("one message was submitted", submitted.length === 1, JSON.stringify(submitted).slice(0, 120));
const sent = submitted[0] ?? {};
check("the sent content is the expanded original text", String(sent.text).includes("line 40"));
check("the sent content holds all 40 lines", String(sent.text).split("\n").length === 40);
check("the display text is still the placeholder block", sent.display === "[Pasted text #1 +39 lines] 请解释");
check("the composer is cleared after submit", plain().includes("❯"));

// 再粘一次并用退格整块删除
stdin.push(`\u001B[200~${body}\u001B[201~`);
await wait(80);
check("the second paste restarts numbering at 1", plain().includes("[Pasted text #1 +39 lines]"));
stdin.push("\u007F");
await wait(80);
check("one backspace deletes the whole block", plain().includes("❯"), plain().slice(0, 200));

// 短文本粘贴仍应内联
stdin.push("\u001B[200~short paste\u001B[201~");
await wait(80);
check("a short paste stays inline without collapsing", plain().includes("short paste") && !plain().includes("[Pasted text"));

// 清空输入框，验证不带 bracketed paste 的兜底路径
stdin.push("\u0015");
await wait(60);

// 终端不支持 bracketed paste 时，粘贴以裸多字符 chunk 走 useInput 进来
stdin.push(body);
await wait(80);
check("a bare chunk paste collapses the same way", plain().includes("[Pasted text #2 +39 lines]"), plain().slice(0, 200));

submitted.length = 0;
stdin.push("\r");
await wait(80);
check("the fallback path still submits the original text", String(submitted[0]?.text).split("\n").length === 40);

// 回归：快速打字后紧跟回车会合并成一个 chunk，不能被误判为粘贴
submitted.length = 0;
stdin.push("hello world\r");
await wait(80);
check(
  "typing followed by Enter is not mistaken for a paste",
  submitted.length === 1 && submitted[0].text === "hello world",
  JSON.stringify(submitted).slice(0, 120)
);

// 历史应保留粘贴 registry；两次上键回到上一条粘贴消息，再提交仍发送原文。
stdin.push("\u001B[A\u001B[A");
await wait(80);
check("the up arrow browses back to history with paste blocks", plain().includes("[Pasted text #2 +39 lines]"));
submitted.length = 0;
stdin.push("\r");
await wait(80);
check("recalled paste history still submits the original text", String(submitted[0]?.text).split("\n").length === 40);

// 草稿不仅保存文本，也保存原光标位置。
stdin.push("draft\u001B[D\u001B[D\u001B[A");
await wait(80);
stdin.push("\u001B[BX\r");
await wait(80);
check("leaving history restores the draft cursor", submitted.at(-1)?.text === "draXft", submitted.at(-1)?.text);

app.unmount();
await wait(30);

// 同一个历史实例跨 Composer 卸载继续存在，实际默认实例还会落盘。
const remounted = render(
  React.createElement(Composer, {
    disabled: false,
    onSubmit: (text, display) => submitted.push({ text, display }),
    inputHistory,
  }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true }
);
await wait(60);
stdin.push("\u001B[A");
await wait(80);
check("history survives a Composer remount", plain().includes("draXft"));
remounted.unmount();
await wait(30);

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
