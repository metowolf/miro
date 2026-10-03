// 终端显示宽度计算。
//
// 从 markdown.js 抽出为独立模块，供 markdown 表格排版与 latex.js 的
// 纵向公式对齐共用同一套宽度口径，避免两处实现漂移。

const ANSI_PATTERN = /\u001B\[[0-9;]*m|\u001B\]8;;[^\u0007]*\u0007/g;

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

/** 计算终端显示宽度，而不是 JavaScript 字符串长度。 */
export function stringWidth(text) {
  const plain = stripAnsi(text);
  if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") {
    return Bun.stringWidth(plain, { ambiguousIsNarrow: true });
  }

  // Miro 运行在 Bun 上，但保留一个轻量 fallback，方便在 Node 测试或
  // 其他 JS 运行时中复用 markdown / latex 渲染器。
  let width = 0;
  for (const character of plain) {
    const codePoint = character.codePointAt(0);
    if (!codePoint || isZeroWidthCodePoint(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isZeroWidthCodePoint(codePoint) {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff
  );
}

function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
