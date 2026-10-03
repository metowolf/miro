/**
 * 登录交互的两条 abort 路径必须分开。回归点是第二条：
 *
 *   1. 用户按 Esc → 整个登录取消；
 *   2. pi-ai 在 finally 里 abort 自己的 per-request signal（成功、超时、回调报错都
 *      会走）→ 只是这条提示没人要了，登录结果另有定论，不能算用户取消。
 *
 * 早前把 (2) 当 (1)，于是「粘贴内容里没有 code」「token 交换失败」「授权被拒」
 * 「等待超时」全被改写成 "Login cancelled."，把真正的失败原因吃掉。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createLoginInteraction } from "./login-interaction.js";

/** 只记录「当前 overlay」的最小替身，够验证开关与身份判断。 */
function fakeOverlays() {
  const state = { overlay: null };
  return {
    state,
    setOverlay: (overlay) => {
      state.overlay = overlay;
    },
    currentOverlay: () => state.overlay,
  };
}

const manualRequest = (signal) => ({
  type: "manual_code",
  message: "paste the code here",
  signal,
});

test("提交内容会 resolve 提示并关掉自己那个 overlay", async () => {
  const ui = fakeOverlays();
  const login = createLoginInteraction(ui);

  const pending = login.prompt(manualRequest(new AbortController().signal));
  assert.equal(ui.state.overlay.kind, "oauth-input");
  assert.equal(ui.state.overlay.secret, false);

  ui.state.overlay.onSubmit("http://127.0.0.1:1/oauth/callback/x?code=abc");
  assert.equal(await pending, "http://127.0.0.1:1/oauth/callback/x?code=abc");
  assert.equal(ui.state.overlay, null);
  assert.equal(login.cancelled(), false);
});

test("pi-ai 收尾 abort per-request signal 不算用户取消", async () => {
  const ui = fakeOverlays();
  const login = createLoginInteraction(ui);
  const manual = new AbortController();

  const pending = login.prompt(manualRequest(manual.signal));
  manual.abort();

  await assert.rejects(pending, /Login cancelled/);
  // 关键断言：真实失败要留给调用方照实上报，不能被改写成「用户取消」。
  assert.equal(login.cancelled(), false);
  assert.equal(login.signal.aborted, false);
  assert.equal(ui.state.overlay, null);
});

test("Esc 才是用户取消：标记取消并作废整个登录 signal", async () => {
  const ui = fakeOverlays();
  const login = createLoginInteraction(ui);

  const pending = login.prompt(manualRequest(new AbortController().signal));
  ui.state.overlay.onCancel();

  await assert.rejects(pending, /Login cancelled/);
  assert.equal(login.cancelled(), true);
  assert.equal(login.signal.aborted, true);
  assert.equal(ui.state.overlay, null);
});

test("picker 型提示按 Esc（resolve(null)）同样算取消", async () => {
  const ui = fakeOverlays();
  const login = createLoginInteraction(ui);

  const pending = login.prompt({
    type: "select",
    message: "pick an account",
    options: [{ id: "a", label: "Account A", description: "free" }],
    signal: new AbortController().signal,
  });
  assert.deepEqual(ui.state.overlay.items, [{ value: "a", label: "Account A", right: "free" }]);

  ui.state.overlay.resolve(ui.state.overlay.escapeValue);
  await assert.rejects(pending, /Login cancelled/);
  assert.equal(login.cancelled(), true);
});

test("picker 型提示选中值只 resolve，不算取消", async () => {
  const ui = fakeOverlays();
  const login = createLoginInteraction(ui);

  const pending = login.prompt({
    type: "select",
    message: "pick an account",
    options: [{ id: "a", label: "Account A" }],
    signal: new AbortController().signal,
  });
  ui.state.overlay.resolve("a");

  assert.equal(await pending, "a");
  assert.equal(ui.state.overlay, null);
  assert.equal(login.cancelled(), false);
});

test("收尾 abort 不会把登录成功后弹出的新面板一起关掉", async () => {
  const ui = fakeOverlays();
  const login = createLoginInteraction(ui);
  const manual = new AbortController();

  const pending = login.prompt(manualRequest(manual.signal));
  const nextPanel = { kind: "oauth", title: "Select model" };
  ui.setOverlay(nextPanel);

  manual.abort();
  await assert.rejects(pending, /Login cancelled/);
  assert.equal(ui.state.overlay, nextPanel);
});
