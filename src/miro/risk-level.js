/** terminal 的模型自评风险等级。 */

/** Auto 只把 high 交给独立审查模型；low / medium 直接执行。 */
export const RISK_LEVELS = ["low", "medium", "high"];

/** 模型没报或报了非法值时按 medium 处理。 */
export const DEFAULT_RISK_LEVEL = "medium";

/**
 * 归一化风险等级。与仓库其余配置字段一致：非法值降级为默认值，不抛错——
 * 模型给出 "LOW"、"low risk"、undefined 都不该让整轮调用失败。
 */
export function normalizeRiskLevel(value) {
  if (typeof value !== "string") return DEFAULT_RISK_LEVEL;
  const normalized = value.trim().toLowerCase();
  return RISK_LEVELS.includes(normalized) ? normalized : DEFAULT_RISK_LEVEL;
}

/** schema 里给模型的等级说明。措辞要具体到命令类别，否则模型会一律报 low。 */
export const RISK_LEVEL_DESCRIPTION = [
  "Your own assessment of command risk. In Auto mode, high-risk commands receive an isolated safety review; low and medium commands run directly.",
  '"low": read-only inspection with no side effects (ls, cat, grep, pwd, git status, git log, git diff, running a test suite that only reads).',
  '"medium": creates or modifies files inside the workspace or a remote service, installs project dependencies, or makes otherwise reversible changes (git commit, opening a pull request with gh or glab, npm install, writing a file).',
  '"high": deletes data, changes sensitive state outside the workspace, needs sudo, or is otherwise hard to undo (rm, git push --force, chmod -R, systemctl).',
  'Be honest: label side effects accurately. Manual requests approval for commands. When unsure, use "medium".',
].join(" ");
