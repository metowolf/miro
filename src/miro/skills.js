import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isMap, parseDocument } from "yaml";

/**
 * Agent Skills（`SKILL.md` 规范）的发现、校验与注入。
 *
 * 这里只放纯逻辑：扫目录、解析 frontmatter、拼 system prompt 片段、展开
 * `/skill:<name>`。接进会话的活留给 agent-client.js —— 它是 miro 这条
 * 线上唯一同时被 TUI 与 headless 走过的地方，逻辑放那里两条路径天然一致。
 *
 * 与 ACP 的分工：ACP provider 自己管 skill，miro 既无法也不该替它写系统
 * 提示（pi-acp 会把 `skill:<name>` 通过 available_commands_update 广播出来，
 * miro 已经原样转发）。所以本模块只在内置 agent 生效。
 */

/** 承载元数据的文件名。大小写固定，写错就等于声明「我本该是 skill」却没成。 */
export const SKILL_FILE = "SKILL.md";

/** 规范对 name 的约束：小写字母数字与单个连字符，不能首尾或连续。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * frontmatter 的字节上限。
 *
 * 目录是直接拼进 system prompt 的，所以扫描必须有一道硬闸门：一个手滑写坏
 * 的 SKILL.md 不该把整条 prompt 顶爆（fx 的 max_frontmatter_bytes 同理）。
 */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

/**
 * 一次会话最多吃进的 skill 数。
 *
 * 目录的成本是 O(n) 的 prompt 体积而不是能力，超过这个量级模型也挑不过来。
 * 取 64 与 fx 的 SDK 上限一致；超出只保留先扫到的，并记一条诊断。
 */
export const MAX_SKILLS = 64;

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function realPathOf(target) {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function warn(code, file, message) {
  return { level: "warn", code, ...(file == null ? {} : { path: file }), message };
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

/**
 * 拆出 frontmatter 与正文。
 *
 * `present` 用来区分两种「没有元数据」：普通 markdown 文件（静默忽略）与
 * 真的写坏了的 SKILL.md（要报诊断）。扫描时这个区别就是全部的信息量。
 */
export function parseSkillFrontmatter(text) {
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return { present: false, data: {}, body: normalized.trim() };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    // 缩进的分隔符可能是块标量正文，不应提前结束 frontmatter。
    const trimmed = lines[i].trimEnd();
    if (trimmed === "---" || trimmed === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return { present: false, data: {}, body: normalized.trim() };

  const raw = lines.slice(1, end).join("\n");
  if (Buffer.byteLength(raw, "utf8") > MAX_FRONTMATTER_BYTES) {
    return { present: true, data: {}, body: "", tooLarge: true };
  }
  const body = lines.slice(end + 1).join("\n").trim();
  try {
    // 保留结束分隔符前的换行，让块标量的 chomping 按 YAML 标准处理。
    // 只接受 core schema；未知标签、重复键与非标量键均作为诊断，不做宽松回退。
    const doc = parseDocument(`${raw}\n`, {
      schema: "core",
      merge: false,
      resolveKnownTags: false,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
    });
    const issue = doc.errors[0] ?? doc.warnings[0];
    if (issue) throw issue;
    if (doc.contents != null && !isMap(doc.contents)) {
      throw new Error("frontmatter must be a YAML mapping");
    }
    // 字节上限之外再限制别名展开，防止小文件通过嵌套引用耗尽资源。
    const data = doc.toJS({ maxAliasCount: 100 }) ?? {};
    return { present: true, data, body };
  } catch (error) {
    return { present: true, data: {}, body, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** `~/x` 与相对路径都按「用户输入」处理：相对于 cwd 展开。 */
function resolveRoot(value, { cwd, home }) {
  const trimmed = value.trim();
  const expanded = trimmed === "~"
    ? home
    : trimmed.startsWith("~/") || trimmed.startsWith(`~${path.sep}`)
      ? path.join(home, trimmed.slice(2))
      : trimmed;
  return path.resolve(cwd, expanded);
}

/**
 * 默认扫描的根目录，从低优先级到高优先级（后面的同名 skill 覆盖前面的）。
 *
 * - 只收 miro 自己的目录与跨 harness 的 `~/.agents/skills`，不去自动吃
 *   `.claude/skills` / `.codex/skills`：目录内容会被拼进 system prompt，
 *   等于第三方 prompt 注入面。想共用就显式写进 settings 的 skills 数组。
 * - 项目级排在用户级之后：与 AGENTS.md 的拼装顺序一致（用户在前、项目在后），
 *   仓库里固定的同名 skill 能压过全局那份。
 */
export function skillRoots({ cwd = process.cwd(), home = os.homedir(), extraPaths = [] } = {}) {
  const roots = [
    { dir: path.join(home, ".miro", "skills"), source: "user" },
    { dir: path.join(home, ".agents", "skills"), source: "user-shared" },
    { dir: path.join(cwd, ".miro", "skills"), source: "project" },
    { dir: path.join(cwd, ".agents", "skills"), source: "project-shared" },
  ];
  for (const entry of Array.isArray(extraPaths) ? extraPaths : []) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    roots.push({ dir: resolveRoot(entry, { cwd, home }), source: "path" });
  }
  return roots;
}

function entryKind(entry, full) {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return "other";
  // 跟着符号链接：dotfiles 用户常把 skill 目录软链进 dotfiles 仓库。
  try {
    return statSync(full).isDirectory() ? "dir" : "file";
  } catch {
    return "other";
  }
}

function readSkill(file, source, diagnostics) {
  const basename = path.basename(file);
  const isSkillFile = basename === SKILL_FILE;
  const text = readText(file);
  if (text == null) {
    diagnostics.push(warn("unreadable", file, "skill file could not be read; skill skipped"));
    return null;
  }

  const parsed = parseSkillFrontmatter(text);
  if (parsed.tooLarge) {
    diagnostics.push(warn("frontmatter-too-large", file, `frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes; skill skipped`));
    return null;
  }
  if (!parsed.present) {
    // 普通 markdown 不是 skill，静默跳过；只有 SKILL.md 这个文件名本身是
    // 「我本该是 skill」的声明，缺 frontmatter 才值得报。
    if (isSkillFile) diagnostics.push(warn("missing-frontmatter", file, "SKILL.md has no frontmatter; skill skipped"));
    return null;
  }
  if (parsed.error) {
    diagnostics.push(warn("invalid-frontmatter", file, `invalid YAML frontmatter: ${parsed.error}; skill skipped`));
    return null;
  }

  const description = asString(parsed.data.description);
  if (description.length === 0) {
    if (isSkillFile) diagnostics.push(warn("missing-description", file, "frontmatter has no description; skill skipped"));
    return null;
  }

  // 规范里 name 必填；缺省时退化成目录名（SKILL.md）或文件名（裸 .md），
  // 校验失败只警告不丢弃：一个大小写不对的名字不该让 skill 整个不可用。
  const declared = asString(parsed.data.name);
  const fallback = isSkillFile ? path.basename(path.dirname(file)) : basename.replace(/\.md$/i, "");
  const name = declared.length > 0 ? declared : fallback;
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    diagnostics.push(warn(
      "invalid-name",
      file,
      `name "${name}" should be at most ${MAX_NAME_LENGTH} characters of lowercase letters, digits and single hyphens`,
    ));
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push(warn(
      "description-too-long",
      file,
      `description is ${description.length} characters; the spec recommends at most ${MAX_DESCRIPTION_LENGTH}`,
    ));
  }

  return {
    name,
    description,
    filePath: file,
    baseDir: path.dirname(file),
    source,
    // 只是不进模型目录，`/skill:<name>` 仍然能显式拉到它。
    disableModelInvocation: parsed.data["disable-model-invocation"] === true,
  };
}

function addSkill(file, source, state) {
  const skill = readSkill(file, source, state.diagnostics);
  if (skill == null) return;

  const existing = state.skills.get(skill.name);
  if (existing != null) {
    // 后面的来源更具体（项目 > 用户、显式路径 > 默认根），同名让它覆盖；
    // 先 delete 再 set 是为了让它在目录里也排到最后，与来源顺序一致。
    state.skills.delete(skill.name);
    state.diagnostics.push(warn(
      "name-collision",
      skill.filePath,
      `skill "${skill.name}" also exists at ${existing.filePath}; the later one wins`,
    ));
  }

  if (state.skills.size >= state.maxSkills) {
    state.truncated = true;
    return;
  }
  state.skills.set(skill.name, skill);
}

function scanDir(dir, source, state) {
  if (state.truncated) return;
  const real = realPathOf(dir);
  // 用 realpath 去重：软链回自身或回父目录的目录树会在这里被切断。
  if (real == null || state.seenDirs.has(real)) return;
  state.seenDirs.add(real);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // readdirSync 的顺序由文件系统决定，排一下让诊断与目录顺序可复现。
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (entries.some((entry) => entry.name === SKILL_FILE && entryKind(entry, path.join(dir, SKILL_FILE)) === "file")) {
    // 目录里有 SKILL.md，这里就是这个 skill 的家：references/、scripts/
    // 都只是它的资源，不再往下扫，免得把资源文件当成独立 skill 广告出去。
    addSkill(path.join(dir, SKILL_FILE), source, state);
    return;
  }

  for (const entry of entries) {
    if (state.truncated) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const kind = entryKind(entry, full);
    if (kind === "dir") {
      scanDir(full, source, state);
      continue;
    }
    // 裸 .md 也算 skill，前提是它自带合法 frontmatter（见 readSkill）。
    if (kind === "file" && entry.name.toLowerCase().endsWith(".md")) addSkill(full, source, state);
  }
}

/**
 * 扫出本次会话可用的 skill。
 *
 * 返回 `{ skills, diagnostics }`，两个都是纯数据：诊断只在这里攒着，是否
 * 呈现给用户由调用方决定（会话中途才发现写错的文件，也没法回到上面去提示）。
 */
export function loadSkills({ cwd = process.cwd(), home = os.homedir(), extraPaths = [], maxSkills = MAX_SKILLS } = {}) {
  const state = {
    diagnostics: [],
    skills: new Map(),
    seenDirs: new Set(),
    maxSkills: Number.isFinite(maxSkills) && maxSkills > 0 ? Math.floor(maxSkills) : MAX_SKILLS,
    truncated: false,
  };

  for (const root of skillRoots({ cwd, home, extraPaths })) {
    if (state.truncated) break;
    scanDir(root.dir, root.source, state);
  }

  if (state.truncated) {
    state.diagnostics.push(warn("too-many-skills", null, `more than ${state.maxSkills} skills found; the rest were skipped`));
  }
  return { skills: [...state.skills.values()], diagnostics: state.diagnostics };
}

/** 从 settings 里取显式路径；`skills: false` 是关闭整个能力的开关。 */
export function skillsFromSettings(settings) {
  const raw = settings?.skills;
  if (raw === false) return { disabled: true, paths: [] };
  return { disabled: false, paths: Array.isArray(raw) ? raw : [] };
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 拼成系统提示里的 `<available_skills>` 目录。
 *
 * 只给名字、描述与位置，正文留给模型自己用 read_file 读：几十个 skill 的
 * 正文全塞进来会直接吃掉上下文，而这正是渐进式披露的意义。
 * `disable-model-invocation` 的条目只从目录里去掉，`/skill:` 依然可用。
 */
export function formatSkillsForPrompt(skills, { readTool = "read_file" } = {}) {
  const visible = (skills ?? []).filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    `Use the ${readTool} tool to load a skill's file when the task matches its description.`,
    "When a skill file references a relative path, resolve it against that skill's directory and pass the absolute path to your tools.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** `/skill:<name> [args]`；不匹配返回 null。 */
export function parseSkillCommand(text) {
  const match = /^\/skill:([A-Za-z0-9_.-]+)(?:[ \t]+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const args = (match[2] ?? "").trim();
  return { name: match[1], args: args.length > 0 ? args : null };
}

/**
 * 把 `/skill:<name>` 展开成一段强制注入的内容。
 *
 * 目录靠模型自觉（描述对不上就不会去读），这条路径是给用户的「就是它」，
 * 把正文整份放进本轮用户消息，而不是只放路径。
 * 返回 null 表示这不该由我们处理（不是 skill 命令 / 没这个 skill / 文件读不到），
 * 调用方照原样发出去即可 —— 宁可让模型看到原文，也不要静默吞掉用户输入。
 */
export function expandSkillCommand(text, skills) {
  const parsed = parseSkillCommand(text);
  if (parsed == null) return null;
  const skill = (skills ?? []).find((entry) => entry.name === parsed.name);
  if (skill == null) return null;
  const raw = readText(skill.filePath);
  if (raw == null) return null;

  const frontmatter = parseSkillFrontmatter(raw);
  // 文件可能在发现后被改坏；交回调用方按原消息处理，不注入无效 skill。
  if (!frontmatter.present || frontmatter.tooLarge || frontmatter.error) return null;
  const body = frontmatter.body;
  const block = [
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">`,
    `References are relative to ${skill.baseDir}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
  return parsed.args == null ? block : `${block}\n\n${parsed.args}`;
}
