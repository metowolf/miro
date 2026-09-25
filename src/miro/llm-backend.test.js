import assert from "node:assert/strict";
import test from "node:test";

import {
  LlmRequestTimeoutError,
  assertLlmBackend,
  backendForProtocol,
  chatCompletionsBackend,
  withRequestTimeout,
  withStreamRetry,
} from "./llm-backend.js";
import { PI_AI_PROTOCOLS } from "./pi-ai-backend.js";

async function drain(stream, requestOptions) {
  const events = [];
  for await (const event of stream(requestOptions)) events.push(event);
  return events;
}

test("chatCompletionsBackend keeps the stream / estimateTokens contract and defaults to pi-ai Completions", () => {
  assert.equal(chatCompletionsBackend.id, "pi-ai:openai-completions");
  assert.equal(typeof chatCompletionsBackend.stream, "function");
  assert.equal(typeof chatCompletionsBackend.estimateTokens, "function");
  // 退避与错误分类不再进入契约。
  assert.equal(chatCompletionsBackend.backoffDelay, undefined);
  assert.equal(chatCompletionsBackend.isRetryableError, undefined);
  assert.equal(chatCompletionsBackend.sleep, undefined);
});

test("assertLlmBackend rejects implementations missing stream or estimateTokens", () => {
  assert.throws(() => assertLlmBackend(null), /must provide a stream/);
  assert.throws(() => assertLlmBackend({}), /must provide a stream/);
  assert.throws(() => assertLlmBackend({ stream() {} }), /estimateTokens/);
  const backend = { stream() {}, estimateTokens: () => 0 };
  assert.equal(assertLlmBackend(backend), backend);
});

test("backendForProtocol picks the implementation per protocol and keeps Chat Completions for unknown values", () => {
  assert.equal(backendForProtocol("chat-completions"), chatCompletionsBackend);
  assert.equal(backendForProtocol(PI_AI_PROTOCOLS.OPENAI_COMPLETIONS), chatCompletionsBackend);
  assert.equal(backendForProtocol(PI_AI_PROTOCOLS.ANTHROPIC_MESSAGES).id, "pi-ai:anthropic-messages");
  assert.equal(backendForProtocol(PI_AI_PROTOCOLS.OPENAI_RESPONSES).id, "pi-ai:openai-responses");
  assert.equal(backendForProtocol("unknown"), chatCompletionsBackend);
});

test("retryable errors reconnect automatically after backoff and report progress to the UI", async () => {
  const retries = [];
  let calls = 0;
  const error = Object.assign(new Error("upstream 503"), { status: 503 });

  const events = await drain(
    withStreamRetry(async function* () {
      calls += 1;
      if (calls <= 2) throw error;
      yield { type: "text", text: "recovered" };
    }),
    { maxRetries: 3, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) },
  );

  assert.equal(calls, 3);
  // 正文只出现一次，重试没有造成重复输出。
  assert.deepEqual(events, [{ type: "text", text: "recovered" }]);
  // 两次失败各上报一次进度，最后一次成功后清空提示。
  assert.equal(retries.length, 3);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].maxRetries, 3);
  assert.equal(retries[0].status, 503);
  assert.equal(retries[1].attempt, 2);
  assert.equal(retries[2], null);
});

test("after recovery the notice clears on the first event, not at stream end", async () => {
  const retries = [];
  let requests = 0;
  let noticeBeforeStreamEnd;
  const error = Object.assign(new Error("rate limited"), { status: 429 });

  await drain(
    withStreamRetry(async function* () {
      requests += 1;
      if (requests === 1) throw error;
      // 非提交型事件（connected）也必须收起提示：清理只看「有没有发过事件」，与类型无关。
      yield { type: "connected" };
      // 在生成器继续吐后续内容前检查，避免只验证整轮结束后的状态。
      noticeBeforeStreamEnd = retries.at(-1);
      yield { type: "text", text: "done" };
    }),
    { maxRetries: 5, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) },
  );

  assert.equal(requests, 2);
  assert.equal(retries[0].status, 429);
  assert.equal(noticeBeforeStreamEnd, null);
  assert.equal(retries.length, 2, "the recovery notice is cleared once and not re-reported with every delta");
});

test("reconnect resets the retry budget so a later disconnect restarts from the first retry", async () => {
  const retries = [];
  let requests = 0;
  const error = Object.assign(new Error("connection lost before output"), { status: 503 });

  await drain(
    withStreamRetry(async function* () {
      requests += 1;
      if (requests <= 2) throw error;
      yield { type: "connected" };
      // 已恢复但未输出内容时又断连，应重新获得完整的重试额度。
      if (requests <= 4) throw error;
      yield { type: "text", text: "recovered" };
    }),
    { maxRetries: 2, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) },
  );

  assert.equal(requests, 5);
  assert.deepEqual(retries.map((notice) => notice?.attempt ?? null), [1, 2, null, 1, null, 1, null]);
});

test("repeated failures after a reconnect reset are still capped by maxRetries", async () => {
  const retries = [];
  let requests = 0;
  const error = Object.assign(new Error("connection lost before output"), { status: 503 });

  await assert.rejects(
    () =>
      drain(
        withStreamRetry(async function* () {
          requests += 1;
          // 用有限脚本兜底，错误地取消上限也不会让测试无限重试。
          if (requests > 5) throw Object.assign(new Error("retry limit ignored"), { status: 400 });
          if (requests === 3) yield { type: "connected" };
          throw error;
        }),
        { maxRetries: 2, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) },
      ),
    /connection lost before output/,
  );

  assert.equal(requests, 5);
  assert.deepEqual(retries.map((notice) => notice?.attempt ?? null), [1, 2, null, 1, 2, null]);
});

test("non-retryable errors throw immediately without a pointless wait", async () => {
  const retries = [];
  const error = Object.assign(new Error("invalid api key"), { status: 401 });

  await assert.rejects(
    () =>
      drain(
        withStreamRetry(async function* () {
          throw error;
        }),
        { maxRetries: 3, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) },
      ),
    /invalid api key/,
  );

  // 401 不该产生任何重试尝试。
  assert.deepEqual(retries.filter(Boolean), []);
});

test("exhausted retries throw the last error to the caller", async () => {
  const retries = [];
  const error = Object.assign(new Error("upstream 502"), { status: 502 });

  await assert.rejects(
    () =>
      drain(
        withStreamRetry(async function* () {
          throw error;
        }),
        { maxRetries: 2, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) },
      ),
    /upstream 502/,
  );

  // 2 次重试尝试 + 最终失败时清空提示。
  assert.equal(retries.filter(Boolean).length, 2);
  assert.equal(retries.at(-1), null);
});

test("a mid-stream failure after content was emitted is not retried to avoid duplicate output", async () => {
  const retries = [];
  const error = new Error("stream broke mid-flight");

  const events = [];
  await assert.rejects(
    async () => {
      for await (const event of withStreamRetry(async function* () {
        yield { type: "text", text: "partial" };
        throw error;
      })({ maxRetries: 3, retryBaseDelayMs: 0, onRetry: (payload) => retries.push(payload) })) {
        events.push(event);
      }
    },
    /stream broke mid-flight/,
  );

  assert.deepEqual(events, [{ type: "text", text: "partial" }]);
  assert.deepEqual(retries.filter(Boolean), []);
});

test("server Retry-After wins over the local backoff", async () => {
  const retries = [];
  const controller = new AbortController();
  const error = Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 1234 });
  let calls = 0;

  // 只关心上报的等待时长，不让测试真的睡 1.2s：
  // 拿到第一次重试上报后立刻取消，退避 sleep 会被打断。
  const events = await drain(
    withStreamRetry(async function* () {
      calls += 1;
      if (calls === 1) throw error;
      yield { type: "text", text: "ok" };
    }),
    {
      maxRetries: 2,
      retryBaseDelayMs: 0,
      signal: controller.signal,
      onRetry: (payload) => {
        if (payload) {
          retries.push(payload);
          controller.abort();
        }
      },
    },
  );

  // 服务端指定的等待时间必须原样采纳，而不是被本地退避（此处为 0）覆盖。
  assert.equal(retries[0].delayMs, 1234);
  assert.equal(retries[0].status, 429);
  // sleep 被打断后不再继续重连。
  assert.deepEqual(events, []);
});

test("cancelling during a retry stops further reconnects", async () => {
  const controller = new AbortController();
  const retries = [];
  const error = Object.assign(new Error("upstream 503"), { status: 503 });
  let calls = 0;

  const events = await drain(
    withStreamRetry(async function* () {
      calls += 1;
      // 第一次失败前先请求取消：退避 sleep 会立刻被打断。
      controller.abort();
      throw error;
    }),
    {
      maxRetries: 5,
      retryBaseDelayMs: 10_000,
      signal: controller.signal,
      onRetry: (payload) => retries.push(payload),
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(retries, []);
});

test("request timeout bounds the whole stream and reaches the backend options", async () => {
  let seenTimeout = null;
  const stream = withRequestTimeout(async function* (options) {
    seenTimeout = options.timeoutMs;
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    throw options.signal.reason;
  });

  await assert.rejects(() => drain(stream, { requestTimeoutMs: 10 }), (error) => {
    assert.ok(error instanceof LlmRequestTimeoutError);
    assert.equal(error.retryable, false);
    assert.equal(error.timeoutMs, 10);
    return true;
  });
  assert.equal(seenTimeout, 10);
});

test("external cancellation remains cancellation instead of becoming a timeout", async () => {
  const controller = new AbortController();
  const stream = withRequestTimeout(async function* (options) {
    controller.abort();
    if (options.signal.aborted) return;
    yield { type: "text", text: "unreachable" };
  });

  assert.deepEqual(await drain(stream, { requestTimeoutMs: 1000, signal: controller.signal }), []);
});
