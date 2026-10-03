import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicMessagesBackend,
  openAICompletionsBackend,
  openAIResponsesBackend,
} from "./pi-ai-backend.js";

function sse(events) {
  return events
    .map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function fakeFetch(body, requests) {
  return async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

/** 按调用次序返回不同响应，用来观察 pi-ai 自己重试了几次。 */
function fakeFetchSequence(responses, requests) {
  return async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const index = Math.min(requests.length - 1, responses.length - 1);
    const { status = 200, headers = {}, body = "" } = responses[index];
    return new Response(body, { status, headers });
  };
}

async function collect(backend, fetchImpl, baseUrl, overrides = {}) {
  const {
    messages = [
      { role: "system", content: "You are concise." },
      { role: "user", content: "Say hello" },
    ],
    tools = [],
    ...rest
  } = overrides;
  const events = [];
  for await (const event of backend.stream({
    baseUrl,
    apiKey: "test-key",
    model: "test-model",
    messages,
    tools,
    effort: null,
    temperature: null,
    contextWindow: 128_000,
    fetchImpl,
    ...rest,
  })) {
    events.push(event);
  }
  return events;
}

test("Anthropic Messages backend translates text, usage and finish events", async () => {
  const requests = [];
  const body = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const events = await collect(
    anthropicMessagesBackend,
    fakeFetch(body, requests),
    "https://anthropic.test/v1",
  );

  assert.equal(requests[0].url, "https://anthropic.test/v1/messages?beta=true");
  assert.equal(requests[0].body.system[0].text, "You are concise.");
  assert.equal(requests[0].body.messages[0].content[0].text, "Say hello");
  assert.deepEqual(events.map((event) => event.type), ["connected", "text", "finish", "usage", "done"]);
  assert.equal(events[1].text, "hello");
  assert.equal(events[3].usage.inputTokens, 3);
  assert.equal(events[3].usage.outputTokens, 2);
  assert.equal(events[3].usage.totalTokens, 5);
  assert.equal(events[3].usage.cacheReadTokens, 0);
  assert.equal(events[3].usage.cost, null);
});

test("OpenAI Responses backend translates text, usage and finish events", async () => {
  const requests = [];
  const body = sse([
    { data: { type: "response.created", response: { id: "resp_1" } } },
    {
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant", content: [] },
      },
    },
    { data: { type: "response.output_text.delta", output_index: 0, delta: "hello" } },
    {
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        },
      },
    },
    {
      data: {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      },
    },
  ]);

  const events = await collect(
    openAIResponsesBackend,
    fakeFetch(body, requests),
    "https://responses.test/v1",
  );

  assert.equal(requests[0].url, "https://responses.test/v1/responses");
  const userInput = requests[0].body.input.find((item) => item.role === "user");
  assert.equal(userInput.content[0].text, "Say hello");
  assert.deepEqual(events.map((event) => event.type), ["connected", "text", "finish", "usage", "done"]);
  assert.equal(events[1].text, "hello");
  assert.equal(events[3].usage.inputTokens, 4);
  assert.equal(events[3].usage.outputTokens, 2);
  assert.equal(events[3].usage.totalTokens, 6);
});

test("OpenAI Responses backend translates function calls and converts miro tool schemas into Responses tools", async () => {
  const requests = [];
  const body = sse([
    { data: { type: "response.created", response: { id: "resp_tool" } } },
    {
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_item",
          call_id: "call_1",
          name: "read_file",
          arguments: "",
        },
      },
    },
    {
      data: {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"path":"a.txt"}',
      },
    },
    {
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_item",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
      },
    },
    {
      data: {
        type: "response.completed",
        response: {
          id: "resp_tool",
          status: "completed",
          output: [],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      },
    },
  ]);

  const events = await collect(
    openAIResponsesBackend,
    fakeFetch(body, requests),
    "https://responses.test/v1",
    {
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      }],
    },
  );

  assert.equal(requests[0].body.tools[0].type, "function");
  assert.equal(requests[0].body.tools[0].name, "read_file");
  const toolEvent = events.find((event) => event.type === "tool_calls");
  assert.deepEqual(toolEvent.calls, [{
    id: "call_1|fc_item",
    name: "read_file",
    arguments: '{"path":"a.txt"}',
  }]);
});

const OK_RESPONSES_SSE = sse([
  { data: { type: "response.created", response: { id: "resp_retry" } } },
  {
    data: {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_retry", role: "assistant", content: [] },
    },
  },
  { data: { type: "response.output_text.delta", output_index: 0, delta: "recovered" } },
  {
    data: {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_retry",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "recovered", annotations: [] }],
      },
    },
  },
  {
    data: {
      type: "response.completed",
      response: {
        id: "resp_retry",
        status: "completed",
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  },
]);

const RATE_LIMIT_429 = {
  status: 429,
  headers: { "content-type": "application/json", "retry-after": "0" },
  body: JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }),
};

test("pi-ai backs off and retries during connect, then yields a single complete stream", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence(
    [RATE_LIMIT_429, { body: OK_RESPONSES_SSE, headers: { "content-type": "text/event-stream" } }],
    requests,
  );

  const events = await collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", {
    maxRetries: 2,
  });

  // 重试发生在 pi-ai 内部：两次 HTTP 请求，但对上层只呈现一条流。
  assert.equal(requests.length, 2);
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => event.text),
    ["recovered"],
  );
  assert.ok(events.some((event) => event.type === "done"));
});

test("pi-ai throws to the caller once the retry budget is exhausted", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence([RATE_LIMIT_429], requests);

  await assert.rejects(
    () =>
      collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", {
        maxRetries: 1,
      }),
    /429|rate limited/i,
  );

  // 1 次首发 + 1 次重试。
  assert.equal(requests.length, 2);
});

test("pi-ai does not retry request errors: 401 sends exactly one request", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence(
    [
      {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: { message: "Incorrect API key provided", type: "invalid_request_error" },
        }),
      },
    ],
    requests,
  );

  await assert.rejects(
    () =>
      collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", {
        maxRetries: 3,
      }),
    /401|Incorrect API key/i,
  );

  // 401 是凭据问题，重试只会重复失败。分类权在握有真实 HTTP status 的
  // pi-ai 手里，所以这里不会退化成「无 status 一律当传输层错误重试」。
  assert.equal(requests.length, 1);
});

test("with maxRetries 0 pi-ai does not retry and rethrows immediately", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence([RATE_LIMIT_429], requests);

  await assert.rejects(
    () =>
      collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", {
        maxRetries: 0,
      }),
    /429|rate limited/i,
  );

  assert.equal(requests.length, 1);
});

/**
 * 兼容网关把限流标成鉴权错误：status 是 429，但 type 写着 requestAuthError
 * 且没有 retryable 字段，错误文案还是中文。照抄上游分类会把它当凭据问题
 * 一次性抛掉，用户看到的就是「429 却没重试」。
 */
const MISLABELED_429 = {
  status: 429,
  headers: { "content-type": "application/json", "retry-after": "0" },
  body: JSON.stringify({
    type: "error",
    error: {
      message: "该 API key 已达到该模型每分钟请求数(QPM)上限，请稍后再试或申请提额。",
      type: "requestAuthError",
      code: "429",
      ret_code: 429,
    },
  }),
};

test("a gateway labelling 429 as requestAuthError still retries as rate limiting", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence(
    [MISLABELED_429, { body: OK_RESPONSES_SSE, headers: { "content-type": "text/event-stream" } }],
    requests,
  );

  const events = await collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", {
    maxRetries: 2,
  });

  // 分类看 status 而不是 type：重试发生了，上层只看到一条完整流。
  assert.equal(requests.length, 2);
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => event.text),
    ["recovered"],
  );
});

test("OpenAI Completions backend translates text, usage and finish events", async () => {
  const requests = [];
  const body = sse([
    { data: { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: "hello" } }] } },
    {
      data: {
        id: "chatcmpl_1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    },
  ]);

  const events = await collect(
    openAICompletionsBackend,
    fakeFetch(body, requests),
    "https://openai.test/v1",
  );

  assert.equal(requests[0].url, "https://openai.test/v1/chat/completions");
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.messages.at(-1).content, "Say hello");
  assert.equal("store" in requests[0].body, false);
  assert.ok(events.some((event) => event.type === "text" && event.text === "hello"));
  const usage = events.find((event) => event.type === "usage")?.usage;
  assert.equal(usage.inputTokens, 4);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.totalTokens, 6);
});

test("OpenAI Completions backend maps effort through thinkingLevelMap", async () => {
  const requests = [];
  const body = sse([
    { data: { id: "chatcmpl_effort", choices: [{ index: 0, delta: { content: "ok" } }] } },
    { data: { id: "chatcmpl_effort", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
  ]);

  await collect(
    openAICompletionsBackend,
    fakeFetch(body, requests),
    "https://reasoning.test/v1",
    {
      effort: "max",
      reasoning: true,
      thinkingLevelMap: { max: "upstream-max" },
    },
  );

  assert.equal(requests[0].body.reasoning_effort, "upstream-max");
});

test("OpenAI Completions backend translates function calls", async () => {
  const requests = [];
  const body = sse([
    {
      data: {
        id: "chatcmpl_tool",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            }],
          },
        }],
      },
    },
    {
      data: {
        id: "chatcmpl_tool",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    },
  ]);

  const events = await collect(
    openAICompletionsBackend,
    fakeFetch(body, requests),
    "https://openai.test/v1",
    {
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      }],
    },
  );

  assert.equal(requests[0].body.tools[0].function.name, "read_file");
  const toolEvent = events.find((event) => event.type === "tool_calls");
  assert.deepEqual(toolEvent.calls[0], {
    id: "call_1",
    name: "read_file",
    arguments: '{"path":"a.txt"}',
  });
});

test("Anthropic keeps thinking signatures verbatim for same-model history", async () => {
  const requests = [];
  const body = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  await collect(
    anthropicMessagesBackend,
    fakeFetch(body, requests),
    "https://anthropic.test/v1",
    {
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "working",
          thinking_blocks: [{ thinking: "plan it", thinkingSignature: "sig_abc" }],
          pi_api: "anthropic-messages",
          pi_provider: "anthropic",
          pi_model: "test-model",
        },
        { role: "user", content: "continue" },
      ],
    },
  );

  const thinking = requests[0].body.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "thinking");
  assert.equal(thinking.thinking, "plan it");
  assert.equal(thinking.signature, "sig_abc");
});

test("switching to Anthropic rewrites illegal Responses tool ids into short ids", async () => {
  const requests = [];
  const body = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_3",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const longId = "call_1|fc_item_that_is_not_anthropic_safe";
  await collect(
    anthropicMessagesBackend,
    fakeFetch(body, requests),
    "https://anthropic.test/v1",
    {
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "working",
          pi_api: "openai-responses",
          pi_provider: "openai",
          pi_model: "gpt-test",
          tool_calls: [{
            id: longId,
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
          }],
        },
        { role: "tool", tool_call_id: longId, content: "file contents" },
        { role: "user", content: "continue" },
      ],
    },
  );

  const payload = requests[0].body;
  const toolUse = payload.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_use");
  assert.match(toolUse.id, /^id_[a-f0-9]+$/);
  assert.notEqual(toolUse.id, longId);

  const toolResult = payload.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result");
  assert.equal(toolResult.tool_use_id, toolUse.id);
});

test("Anthropic thinking_end carries the signature to the agent loop", async () => {
  const requests = [];
  const body = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_think",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_live" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  const events = await collect(
    anthropicMessagesBackend,
    fakeFetch(body, requests),
    "https://anthropic.test/v1",
  );

  assert.ok(events.some((event) => event.type === "reasoning" && event.text === "hmm"));
  const ended = events.find((event) => event.type === "reasoning_end");
  assert.equal(ended.thinkingSignature, "sig_live");
  assert.equal(ended.thinking, "hmm");
});

/**
 * 超窗被上游标成可重试：原样重发的请求还是同样长，重试只会把预算烧完。
 * 必须打上 contextOverflow 让 agent-loop 去压缩，而不是盲目重试。
 */
const RETRYABLE_OVERFLOW = {
  status: 400,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    error: {
      message: "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  }),
};

test("context overflow is not retried and is flagged with contextOverflow", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence(
    [RETRYABLE_OVERFLOW, { body: OK_RESPONSES_SSE, headers: { "content-type": "text/event-stream" } }],
    requests,
  );

  let captured = null;
  await assert.rejects(
    collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", { maxRetries: 2 }).catch((error) => {
      captured = error;
      throw error;
    }),
    /context length|context_length_exceeded/i,
  );

  // 只发了一次：没有把重试预算浪费在必然同样失败的请求上。
  assert.equal(requests.length, 1);
  assert.equal(captured.contextOverflow, true);
  assert.equal(captured.retryable, false);
});

test("token 限流保留重试分类，不误标为上下文超窗", async () => {
  const requests = [];
  const fetchImpl = fakeFetchSequence([{
    status: 429,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: {
      message: "Rate limit reached: too many tokens; retry later",
      type: "rate_limit_error",
    } }),
  }], requests);
  await assert.rejects(
    collect(openAIResponsesBackend, fetchImpl, "https://responses.test/v1", { maxRetries: 0 }),
    (error) => {
      assert.match(error.message, /429.*too many tokens/);
      assert.notEqual(error.retryable, false);
      assert.notEqual(error.contextOverflow, true);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});