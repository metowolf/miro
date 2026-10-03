import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * 读取并组合 ~/.miro/AGENTS.md 与 ./AGENTS.md。
 * 用户级在前、项目级在后；读失败或空白则跳过。
 */

function readTextFile(file) {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** 返回 { contextText, files }；内容相同的文件只保留一份。 */
export function loadAgentsContext({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const candidates = [path.join(home, ".miro", "AGENTS.md"), path.join(cwd, "AGENTS.md")];

  const files = [];
  const sections = [];
  const seen = new Set();

  for (const file of candidates) {
    const text = readTextFile(file);
    if (text == null || seen.has(text)) continue;
    seen.add(text);
    files.push(file);
    sections.push(
      `<memory>\nThe following rules are from ${file} (AGENTS.md). Follow them in this session:\n\n${text}\n</memory>`,
    );
  }

  return { contextText: sections.length > 0 ? sections.join("\n\n") : null, files };
}

/**
 * 组装首轮注入的上下文。恢复会话只跳过 AGENTS.md——已有会话里重复注入
 * 只会让历史里出现第二份同样的规则；首条请求失败后由调用方还原重试。
 */
export function loadStartupContext({ cwd, home, resumed = false } = {}) {
  const agents = resumed ? { contextText: null, files: [] } : loadAgentsContext({ cwd, home });
  return { contextText: agents.contextText, files: agents.files };
}

/** 把路径缩成适合提示的形式。 */
export function describeAgentsFiles(files, { cwd = process.cwd(), home = os.homedir() } = {}) {
  return files
    .map((file) => {
      if (file.startsWith(cwd + path.sep)) return `./${path.relative(cwd, file)}`;
      if (file.startsWith(home + path.sep)) return `~/${path.relative(home, file)}`;
      return file;
    })
    .join(", ");
}
