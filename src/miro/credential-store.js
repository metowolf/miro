/** miro 自己的 OAuth 凭据仓库：不兼容也不触碰其它 CLI 的凭据文件。 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MIRO_DIR, readJsonObject } from "../settings-file.js";

export const AUTH_FILE = path.join(MIRO_DIR, "auth.json");

function credentialsOf(file) {
  const parsed = readJsonObject(file);
  return parsed.credentials && typeof parsed.credentials === "object" && !Array.isArray(parsed.credentials)
    ? parsed.credentials
    : {};
}

/**
 * pi-ai 要求 modify 是每个 provider 的串行 read-modify-write。单个 miro
 * 进程内的 promise 链已覆盖 token refresh 和再次登录的竞争；文件写入仍原子。
 */
export class MiroCredentialStore {
  constructor(file = AUTH_FILE) {
    this.file = file;
    // 单个 auth.json 是共享的 read-modify-write 资源；跨 provider 也必须串行，
    // 否则两条各自正确的原子 rename 仍会造成最后一次覆盖前一次的更新。
    this.chain = Promise.resolve();
  }

  async read(providerId) {
    const value = credentialsOf(this.file)[providerId];
    return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : undefined;
  }

  async list() {
    return Object.entries(credentialsOf(this.file))
      .filter(([, value]) => value && typeof value === "object" && (value.type === "oauth" || value.type === "api_key"))
      .map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  enqueue(providerId, operation) {
    const previous = this.chain;
    // 链中任何一次失败都不能阻塞后续 refresh / re-login；但同一 provider 的
    // operation 一定等前一项 settled 后才开始。
    const next = previous.then(operation, operation);
    const tail = next.catch(() => {});
    this.chain = tail;
    return next;
  }

  write(credentials) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ credentials }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.file);
  }

  modify(providerId, fn) {
    return this.enqueue(providerId, async () => {
      const credentials = credentialsOf(this.file);
      const next = await fn(credentials[providerId] ? structuredClone(credentials[providerId]) : undefined);
      if (next === undefined) return credentials[providerId];
      credentials[providerId] = structuredClone(next);
      this.write(credentials);
      return structuredClone(next);
    });
  }

  delete(providerId) {
    return this.enqueue(providerId, async () => {
      const credentials = credentialsOf(this.file);
      delete credentials[providerId];
      this.write(credentials);
    });
  }
}

export function storedCredentialProviderIds(file = AUTH_FILE) {
  return Object.entries(credentialsOf(file))
    .filter(([, credential]) => credential?.type === "oauth")
    .map(([providerId]) => providerId);
}
