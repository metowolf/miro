/**
 * miro LLM 调用的共享常量与估算器。
 *
 * 协议适配已经迁到 pi-ai-backend.js；这里不再手写 SSE。留下的是
 * estimateTokens（无 usage 时的水位估算）以及 withStreamRetry 仍在用的
 * 退避/分类工具——后者只服务自身不带重试的 backend，pi-ai 路径不走这里。
 */

/**
 * 默认重试次数。
 *
 * 取 10 次：共享网关的 QPM 限流常常要等好几轮才让过，5 次（约 31s）不够，
 * 重试预算耗尽后整个回合失败，工具调用的中间结果也一起丢掉。退避封顶在
 * MAX_RETRY_DELAY_MS，所以次数多时最坏等待是线性增长而非指数：第 7 次起
 * 每次都是 60s 上限。
 */
export const DEFAULT_STREAM_MAX_RETRIES = 10;
/** 退避基数。 */
export const DEFAULT_RETRY_BASE_MS = 1_000;
/** 退避上限，避免 429 带来的等待失控。 */
export const MAX_RETRY_DELAY_MS = 60_000;

/**
 * LLM 调用失败的归一化错误。
 *
 * 只有分类信息留在错误对象上（status / retryable / retryAfterMs），
 * 重试策略本身由调用方决定，这样 provider 层不持有循环状态。
 */
export class LlmRequestError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

/**
 * 判断一次失败是否值得重试：
 * 429（限流）、5xx（服务端故障）、以及传输层错误可重试；
 * 其余 4xx 是请求本身的问题，重试只会重复失败。
 */
export function isRetryableError(error) {
  if (!error) return false;
  // 用户主动取消不是失败。
  if (error.name === "AbortError") return false;
  if (error instanceof LlmRequestError) return error.retryable;

  const status = typeof error.status === "number" ? error.status : null;
  if (status != null) return status === 429 || status >= 500;

  // fetch 抛出的网络/超时错误没有 status：归到传输层，可重试。
  return true;
}

/**
 * 解析服务端给出的重试等待时间。
 *
 * 优先 `Retry-After` 头（秒数或 HTTP 日期），其次从错误正文里捞
 * `try again in 1.5s` / `retry after 200ms` 这类文案——部分兼容网关
 * 只在 body 里给提示。
 */
export function parseRetryAfterMs(headers, body = "") {
  const raw = headers?.get?.("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }

  const match = /(?:try again|retry)(?:\s+after)?(?:\s+in)?\s*([\d.]+)\s*(ms|s|seconds?)/i.exec(
    String(body ?? "")
  );
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      const unit = match[2].toLowerCase();
      const millis = unit === "ms" ? value : value * 1000;
      return Math.min(millis, MAX_RETRY_DELAY_MS);
    }
  }
  return null;
}

/**
 * 指数退避 + ±10% 抖动。
 *
 * attempt 从 1 开始：1 → base，2 → 2×base，3 → 4×base …
 * 抖动用于打散并发客户端同时重试造成的二次冲击。
 */
export function backoffDelay(attempt, baseMs = DEFAULT_RETRY_BASE_MS, random = Math.random) {
  const step = Math.max(1, attempt);
  const raw = baseMs * 2 ** (step - 1);
  const jitter = 0.9 + random() * 0.2;
  return Math.min(Math.round(raw * jitter), MAX_RETRY_DELAY_MS);
}

/** 可被 abort 打断的 sleep：重试等待期间用户按 esc 要能立刻退出。 */
export function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** 无 usage 上报时的粗略估算，用于上下文窗口水位。 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
