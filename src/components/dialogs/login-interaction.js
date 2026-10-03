/**
 * pi-ai OAuth 交互（picker / 文本输入）到 miro overlay 的适配层。
 *
 * 这里必须把两种 abort 分开：
 *
 *   1. 用户取消：在提示上按 Esc（picker 上是 Esc 选中 escapeValue）→ 整个登录取消；
 *   2. pi-ai 收尾：它在 finally 里总会 abort 自己那个 per-request signal（成功、
 *      等待超时、回调报错、授权被拒都会走这条路）→ 只表示这条提示已经没人要了，
 *      登录结果另有定论。
 *
 * 之前把 (2) 也当成 (1)：per-request signal 一 abort 就 abort 掉共享的登录
 * controller，调用方再按 controller.signal.aborted 选文案，于是「粘贴内容里没有
 * code」「token 交换失败」「授权被拒」「等待超时」这些真实失败全被改写成
 * "Login cancelled."。取消与否只能由 (1) 决定。
 */
export function createLoginInteraction({ setOverlay, currentOverlay = () => null } = {}) {
  const controller = new AbortController();
  let userCancelled = false;

  const close = (overlay) => {
    // 只关自己弹出的那一个：登录成功后 App 会接着弹选模型面板，
    // 收尾时晚到的 abort 不能把新面板一起关掉。
    if (overlay && currentOverlay() === overlay) setOverlay(null);
  };

  const prompt = (request) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let overlay = null;
      const settle = (done, value) => {
        if (settled) return;
        settled = true;
        close(overlay);
        done(value);
      };
      const cancel = () => {
        userCancelled = true;
        // 先作废 controller：pi-ai 那边正在等的回调服务器/手动提示都靠它收尾。
        controller.abort();
        settle(reject, new Error("Login cancelled"));
      };
      request.signal?.addEventListener("abort", () => settle(reject, new Error("Login cancelled")), { once: true });

      if (request.type === "select") {
        overlay = {
          kind: "oauth",
          title: request.message,
          items: request.options.map((item) => ({ value: item.id, label: item.label, right: item.description ?? "" })),
          escapeValue: null,
          resolve: (value) => (value == null ? cancel() : settle(resolve, value)),
        };
      } else {
        overlay = {
          kind: "oauth-input",
          title: request.message,
          value: "",
          secret: request.type === "secret",
          hint: "Enter to continue · Esc to cancel",
          onSubmit: (value) => settle(resolve, value),
          onCancel: cancel,
        };
      }
      setOverlay(overlay);
    });

  return {
    signal: controller.signal,
    prompt,
    /** 只有用户主动取消（Esc / Ctrl+C）才为真；真实失败要留给调用方照实上报。 */
    cancelled: () => userCancelled,
  };
}
