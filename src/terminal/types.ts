/** Ink 支持普通 Writable；真实 TTY 才提供尺寸，因此尺寸必须可选。 */
export type TerminalOutput = NodeJS.WritableStream & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};
