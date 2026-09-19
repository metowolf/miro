import { appendFile, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".miro", "sessions");
const ACP_RAW_DIR = path.join("acp", "raw");

/**
 * 把 cwd 拍平成单层目录名：所有非字母数字字符（含路径分隔符、`.`、`_`）一律折成连字符。
 *
 * 刻意不做长度截断 + 哈希兜底：目录名要能一眼读出是哪个项目，
 * 掺进哈希就退回了「父目录是一串看不懂的字符」这个我们要修掉的问题。
 */
export function projectDirectoryName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

export function sessionLogPath(cwd, sessionId, root = DEFAULT_SESSIONS_ROOT) {
  const fileName = `${encodeURIComponent(String(sessionId))}.jsonl`;
  return path.join(root, projectDirectoryName(cwd), ACP_RAW_DIR, fileName);
}

/** 按到达顺序记录双向 ACP NDJSON；拿到 sessionId 后再落盘。 */
export class AcpSessionRecorder {
  constructor({
    cwd,
    root = DEFAULT_SESSIONS_ROOT,
    now = () => new Date().toISOString(),
    onError,
    recordRawThinking = false,
  } = {}) {
    this.cwd = path.resolve(cwd ?? process.cwd());
    this.root = root;
    this.now = now;
    this.onError = onError ?? (() => {});
    this.recordRawThinking = recordRawThinking;
    this.buffer = [];
    this.pendingStream = null;
    this.pendingToolUpdate = null;
    this.sequence = 0;
    this.file = null;
    this.active = false;
    this.disabled = false;
    this.startPromise = null;
    this.writeQueue = Promise.resolve();
  }

  record(direction, message) {
    if (this.disabled) return;
    if (!this.recordRawThinking && isThoughtMessage(message)) {
      // 仍把它当作顺序边界，避免前后的普通消息 chunk 被错误合并。
      this.flushPendingStream();
      this.flushPendingToolUpdate();
      return;
    }
    const entry = {
      timestamp: this.now(),
      direction,
      message: omitConfigOptions(message),
    };

    if (isMergeableMessage(entry)) {
      this.flushPendingToolUpdate();
      if (this.pendingStream && canMergeStream(this.pendingStream, entry)) {
        this.pendingStream.message.params.update.content.text += entry.message.params.update.content.text;
        return;
      }
      this.flushPendingStream();
      this.pendingStream = entry;
      return;
    }

    if (isMergeableToolUpdate(entry)) {
      this.flushPendingStream();
      if (this.pendingToolUpdate && canMergeToolUpdate(this.pendingToolUpdate, entry)) {
        this.pendingToolUpdate = entry;
        return;
      }
      this.flushPendingToolUpdate();
      this.pendingToolUpdate = entry;
      return;
    }

    this.flushPendingStream();
    this.flushPendingToolUpdate();
    this.enqueueOrBuffer(entry);
  }

  flushPendingStream() {
    if (!this.pendingStream) return;
    const entry = this.pendingStream;
    this.pendingStream = null;
    this.enqueueOrBuffer(entry);
  }

  flushPendingToolUpdate() {
    if (!this.pendingToolUpdate) return;
    const entry = this.pendingToolUpdate;
    this.pendingToolUpdate = null;
    this.enqueueOrBuffer(entry);
  }

  enqueueOrBuffer(entry) {
    if (!this.active) {
      this.buffer.push(entry);
      return;
    }
    this.enqueue(entry);
  }

  recordLine(direction, line) {
    const text = String(line).trim();
    if (!text) return;
    try {
      this.record(direction, JSON.parse(text));
    } catch {
      this.record(direction, { raw: text });
    }
  }

  start(sessionId) {
    if (this.startPromise) return this.startPromise;
    this.file = sessionLogPath(this.cwd, sessionId, this.root);
    this.startPromise = this.activate();
    return this.startPromise;
  }

  async activate() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      this.sequence = await nextSequence(this.file);
      while (this.buffer.length > 0 || this.pendingStream || this.pendingToolUpdate) {
        this.flushPendingStream();
        this.flushPendingToolUpdate();
        if (this.buffer.length === 0) continue;
        const batch = this.buffer.splice(0).map((entry) => this.serialize(entry)).join("");
        await appendFile(this.file, batch, "utf8");
      }
      this.active = true;
    } catch (error) {
      this.fail(error);
    }
  }

  serialize(entry) {
    return `${JSON.stringify({ ...entry, sequence: this.sequence++ })}\n`;
  }

  enqueue(entry) {
    const line = this.serialize(entry);
    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.file, line, "utf8"))
      .catch((error) => this.fail(error));
  }

  fail(error) {
    if (this.disabled) return;
    this.disabled = true;
    this.active = false;
    this.buffer = [];
    this.onError(error);
  }

  async close() {
    if (this.startPromise) await this.startPromise;
    this.flushPendingStream();
    this.flushPendingToolUpdate();
    await this.writeQueue;
  }
}

function omitConfigOptions(message) {
  // 配置快照体积大且频繁重复；只裁剪日志副本，保留协议事件与运行时配置。
  if (message?.result && Object.hasOwn(message.result, "configOptions")) {
    const { configOptions, ...result } = message.result;
    message = { ...message, result };
  }
  const update = message?.params?.update;
  if (message?.method === "session/update" && update?.sessionUpdate === "config_option_update") {
    const { configOptions, ...rest } = update;
    message = { ...message, params: { ...message.params, update: rest } };
  }
  return message;
}

function isThoughtMessage(message) {
  return message?.method === "session/update" &&
    message.params?.update?.sessionUpdate === "agent_thought_chunk";
}

function isMergeableMessage(entry) {
  const update = entry.message?.params?.update;
  return (
    entry.message?.method === "session/update" &&
    (update?.sessionUpdate === "agent_message_chunk" ||
      update?.sessionUpdate === "user_message_chunk" ||
      update?.sessionUpdate === "agent_thought_chunk") &&
    typeof update.content?.text === "string"
  );
}

function canMergeStream(previous, next) {
  const oldUpdate = previous.message.params.update;
  const newUpdate = next.message.params.update;
  return (
    previous.direction === next.direction &&
    previous.message.params.sessionId === next.message.params.sessionId &&
    oldUpdate.sessionUpdate === newUpdate.sessionUpdate &&
    oldUpdate.messageId === newUpdate.messageId
  );
}

function isMergeableToolUpdate(entry) {
  const update = entry.message?.params?.update;
  return (
    entry.message?.method === "session/update" &&
    update?.sessionUpdate === "tool_call_update" &&
    update.status === "in_progress" &&
    typeof update.toolCallId === "string" &&
    update.toolCallId.length > 0
  );
}

function canMergeToolUpdate(previous, next) {
  const oldParams = previous.message.params;
  const newParams = next.message.params;
  return (
    previous.direction === next.direction &&
    oldParams.sessionId === newParams.sessionId &&
    oldParams.update.toolCallId === newParams.update.toolCallId
  );
}

async function nextSequence(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    if (size === 0) return 0;

    let position = size;
    let tail = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      tail = Buffer.concat([chunk, tail]);
      const text = tail.toString("utf8").trimEnd();
      const lines = text.split("\n");
      const complete = position > 0 ? lines.slice(1) : lines;
      for (let index = complete.length - 1; index >= 0; index -= 1) {
        try {
          const sequence = JSON.parse(complete[index]).sequence;
          if (Number.isSafeInteger(sequence)) return sequence + 1;
        } catch {
          // ignore
        }
      }
    }
    return 0;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function createRecordingTransform(recorder, direction) {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  return new Transform({
    transform(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const lines = (pending + decoder.write(data)).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) recorder.recordLine(direction, line);
      callback(null, data);
    },
    flush(callback) {
      pending += decoder.end();
      if (pending) recorder.recordLine(direction, pending);
      callback();
    },
  });
}
