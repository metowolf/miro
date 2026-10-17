import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { MIRO_DIR, readJsonObject } from "./settings-file.ts";

/**
 * ACP provider 配置：~/.miro/acp.json
 *
 * 顶层直接是 provider id → 定义的表，形如
 * {"cursor":{"command":"cursor-agent","args":["acp"],"model":"sonnet"}}。
 * 它决定启动哪个二进制（以及该 provider 上次选的 model / effort），
 * 因此与 settings.json 里的用户偏好分开存放。
 */

export const ACP_FILE = path.join(MIRO_DIR, "acp.json");

/** 读取 ~/.miro/acp.json；文件缺失、非法或顶层不是普通对象时视为空表。 */
export function readAcpProviders(file = ACP_FILE) {
  return readJsonObject(file);
}

/** 原子写：先写临时文件再 rename，避免读到半截 JSON。 */
export function writeAcpProviders(providers, file = ACP_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(providers, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}
