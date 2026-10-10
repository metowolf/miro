/**
 * 真实终端光标的形状（DECSCUSR）。
 *
 * 光标闪烁是终端自己的事：帧率再低、位置再准，默认的闪烁块依旧会在输入格上
 * 一亮一灭。定位与形状是两件互不干扰的事 —— 这里只改形状，不动位置，输入法的
 * 预编辑串与候选框照样认那个真实光标。
 *
 * 稳定条而不是稳定块：块会盖住光标所在的字符（Ink 已不再自绘反显块），
 * 条状只标记插入点，对正文无干扰。不支持的终端（或没开透传的 tmux）直接忽略
 * 这两条私有模式序列，不会有副作用。
 */
export const STEADY_BAR_CURSOR = "\x1b[6 q";

/** 归还终端自己的光标形状，退出与失焦时都要写。 */
export const DEFAULT_CURSOR = "\x1b[0 q";

/** 写一条光标形状序列；非 TTY（print 模式、管道、CI）下什么都不做。 */
export function writeCursorShape(stream, sequence) {
  if (!stream?.isTTY || typeof stream.write !== "function") return;
  stream.write(sequence);
}
