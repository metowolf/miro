/** 探测终端是否支持 DEC 2026 synchronized output。 */

const SYNC_OUTPUT_TERM_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "WarpTerminal",
  "ghostty",
  "contour",
  "vscode",
  "alacritty",
]);

export function isSynchronizedOutputSupported(environment = process.env) {
  if (environment.TMUX !== undefined) return false;

  const termProgram = environment.TERM_PROGRAM;
  const term = environment.TERM;

  if (SYNC_OUTPUT_TERM_PROGRAMS.has(termProgram)) return true;

  if (term?.includes("kitty")) return true;
  if (term === "xterm-ghostty") return true;
  if (term?.startsWith("foot")) return true;
  if (term?.includes("alacritty")) return true;

  if (environment.KITTY_WINDOW_ID) return true;
  if (environment.ZED_TERM) return true;
  if (environment.WT_SESSION) return true;

  // VTE 0.68 起实现 DEC 2026；其版本号格式为 6800、7200 等。
  const vteVersion = Number.parseInt(environment.VTE_VERSION, 10);
  return Number.isFinite(vteVersion) && vteVersion >= 6800;
}

/**
 * 是否应为 Ink 的帧输出加 BSU/ESU 包裹。
 *
 * 默认启用：按终端能力探测，tmux 内与不支持的终端不包裹。
 */
export function shouldWrapSyncOutput(environment = process.env) {
  return isSynchronizedOutputSupported(environment);
}
