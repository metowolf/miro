/**
 * miro harness 的权限模式。
 *
 * 授权集中在 agent-loop：auto 不询问用户，只自动审查特定 Terminal 调用；
 * manual 对写入与命令逐次确认。
 */

import path from "node:path";

/**
 * 权限模式：auto 自动放行常规操作，manual 对副作用操作请求确认。
 * 默认 auto 省去常规操作的确认；旧配置中的 ask 也按非法值回退到 auto。
 */
export const PERMISSION_MODES = ["auto", "manual"];

export const DEFAULT_PERMISSION_MODE = "auto";

/**
 * 归一化权限模式。与仓库其余配置字段保持一致：非法值降级为默认值，
 * 不抛错——配置文件写错不该让客户端起不来。
 */
export function normalizePermissionMode(value) {
  if (typeof value !== "string") return DEFAULT_PERMISSION_MODE;
  const normalized = value.trim().toLowerCase();
  return PERMISSION_MODES.includes(normalized) ? normalized : DEFAULT_PERMISSION_MODE;
}

/** auto 档位：不产生人工审批。 */
export function isAuto(mode) {
  return normalizePermissionMode(mode) === "auto";
}

/** manual 档位：写入、删除、移动与命令调用均须人工确认。 */
export function isManual(mode) {
  return normalizePermissionMode(mode) === "manual";
}

/**
 * 会话级授权的最小身份。命令要绑定完整文本、工作目录与网络形态；写操作要
 * 绑定目标路径，不能再只按工具名或首个命令词复用。
 */
export function permissionScope({ name, kind, rawInput, cwd }) {
  if (kind === "execute") {
    const command = typeof rawInput?.command === "string" ? rawInput.command.trim() : "";
    const workdir = resolveWorkdir(cwd, rawInput);
    const sandbox = rawInput?.sandbox !== false;
    const domains = Array.isArray(rawInput?.allowedDomains)
      ? rawInput.allowedDomains.filter((domain) => typeof domain === "string").map((domain) => domain.trim()).sort()
      : [];
    return `${name}:${JSON.stringify({ command, workdir, sandbox, domains })}`;
  }
  const target = resolveTargetPath(cwd, rawInput);
  return target == null ? name : `${name}:${path.resolve(target)}`;
}

/** rawInput 里的目标路径；与 tools/shared.js 的 resolveToolPath 同规则。 */
function resolveTargetPath(cwd, rawInput) {
  const raw = typeof rawInput?.path === "string" ? rawInput.path : null;
  if (!raw) return null;
  return raw.startsWith("/") ? raw : `${cwd}/${raw}`.replace(/\/{2,}/g, "/");
}

/** terminal 的 workdir：缺省就是 cwd，相对路径相对工作区解析。 */
export function resolveWorkdir(cwd, rawInput) {
  const raw = typeof rawInput?.workdir === "string" ? rawInput.workdir.trim() : "";
  if (!raw) return cwd;
  return raw.startsWith("/") ? raw : `${cwd}/${raw}`.replace(/\/{2,}/g, "/");
}

/** headless 首次启用 auto 时打到 stderr 的警示。 */
export const AUTO_WARNING = "miro: AUTO mode is on — tools run without user approval. High-risk terminal commands and sandbox opt-outs receive an isolated safety review and are denied when the reviewer cannot approve them.";

/** headless 首次启用 manual 时打到 stderr 的警示。 */
export const MANUAL_WARNING = "miro: MANUAL mode is on — writes, edits, deletes, moves, and commands require approval and are denied in non-interactive mode. Read-only tools run without confirmation.";

/** /permissions 选择器的选项。顺序与 PERMISSION_MODES 一致。 */
export const PERMISSION_MODE_CHOICES = [
  { value: "auto", name: "Auto", description: "Run without prompts; auto-review high-risk or unsandboxed terminal calls" },
  { value: "manual", name: "Manual", description: "Ask before writes, edits, deletes, moves, and commands" },
];

const PERMISSION_MODE_MESSAGES = {
  auto: "Permission mode: Auto — tools run without user prompts; high-risk terminal commands and sandbox opt-outs are reviewed automatically and denied unless approved.",
  manual: "Permission mode: Manual — writes, edits, deletes, moves, and commands require approval; read-only tools run without confirmation. There is no OS sandbox.",
};

/** 与客户端使用同一归一化规则，避免切换成功却回显另一档模式。 */
export function permissionModeMessage(value) {
  return PERMISSION_MODE_MESSAGES[normalizePermissionMode(value)];
}

/** 按 value / name 匹配权限模式；未命中返回 null。 */
export function matchPermissionMode(query) {
  if (query == null) return null;
  const lower = String(query).trim().toLowerCase();
  if (!lower) return null;
  return (
    PERMISSION_MODE_CHOICES.find((choice) => choice.value === lower) ??
    PERMISSION_MODE_CHOICES.find((choice) => choice.name.toLowerCase() === lower) ??
    null
  );
}
