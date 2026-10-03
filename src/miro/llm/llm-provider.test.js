import assert from "node:assert/strict";
import test from "node:test";

import {
  LlmRequestError,
  backoffDelay,
  estimateTokens,
  isRetryableError,
  parseRetryAfterMs,
} from "./llm-provider.js";

test("isRetryableError only lets through 429 / 5xx / transport errors", () => {
  assert.equal(isRetryableError(new LlmRequestError("rate", { status: 429, retryable: true })), true);
  assert.equal(isRetryableError(new LlmRequestError("boom", { status: 503, retryable: true })), true);
  // 4xx 是请求本身的问题，重试只会重复失败。
  assert.equal(isRetryableError(new LlmRequestError("bad key", { status: 401 })), false);
  assert.equal(isRetryableError(new LlmRequestError("bad req", { status: 400 })), false);
  // 裸的网络错误没有 status，按传输层处理。
  assert.equal(isRetryableError(new TypeError("fetch failed")), true);

  // 用户取消不是失败。
  const abort = new Error("Aborted");
  abort.name = "AbortError";
  assert.equal(isRetryableError(abort), false);
});

test("parseRetryAfterMs supports seconds, HTTP dates and body hints", () => {
  const headers = new Headers({ "retry-after": "2" });
  assert.equal(parseRetryAfterMs(headers), 2000);

  const future = new Date(Date.now() + 5000).toUTCString();
  const dated = parseRetryAfterMs(new Headers({ "retry-after": future }));
  assert.ok(dated > 3000 && dated <= 5000, `unexpected delay: ${dated}`);

  // 没有头时退回正文里的限流提示。
  assert.equal(parseRetryAfterMs(new Headers(), "Rate limit reached, try again in 1.5s"), 1500);
  assert.equal(parseRetryAfterMs(new Headers(), "please retry after 250ms"), 250);
  assert.equal(parseRetryAfterMs(new Headers(), "no hint here"), null);
});

test("backoffDelay grows exponentially and is capped", () => {
  // 固定 jitter=1.0（random()=0.5）以便断言基准值。
  const fixed = () => 0.5;
  assert.equal(backoffDelay(1, 1000, fixed), 1000);
  assert.equal(backoffDelay(2, 1000, fixed), 2000);
  assert.equal(backoffDelay(3, 1000, fixed), 4000);
  // 上限封顶，避免等待失控。
  assert.equal(backoffDelay(20, 1000, fixed), 60_000);

  // jitter 落在 ±10% 内。
  assert.equal(backoffDelay(1, 1000, () => 0), 900);
  assert.ok(backoffDelay(1, 1000, () => 0.999) <= 1100);
});

test("estimateTokens roughly counts characters and returns 0 for an empty string", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});
