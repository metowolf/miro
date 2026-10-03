import chalk from "chalk";
import { marked } from "marked";

import { renderLatex } from "./latex.js";
import { stringWidth, stripAnsi } from "./markdown-width.js";

const EOL = "\n";

let markedConfigured = false;

/** 禁用删除线解析（~100 常表示约数），并注册 LaTeX 数学扩展。 */
export function configureMarked() {
  if (markedConfigured) return;
  markedConfigured = true;
  marked.use({
    tokenizer: {
      del() {
        return undefined;
      },
    },
  });
  marked.use({ extensions: [...LATEX_EXTENSIONS] });
}

// ---------------------------------------------------------------------------
// LaTeX 数学：$...$、\(...\) 为行内，$$...$$、\[...\] 为块级。
//
// 流式输出会先到达未闭合的片段，此时标记 pending 并原样显示，等闭合符号
// 到达后再渲染，避免公式在终端里闪烁重排。
// ---------------------------------------------------------------------------

/** 判断 source[index] 处的字符是否被反斜杠转义。 */
function isEscaped(source, index) {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(source, closing, start) {
  let index = source.indexOf(closing, start);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(closing, index + closing.length);
  }
  return index;
}

/** 未闭合的 $ 片段是否像数学公式（否则可能是货币金额）。 */
function looksLikePendingDollarMath(source) {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function tokenizeInlineLatex(source) {
  let opening = "";
  let closing = "";
  if (source.startsWith("$$")) {
    opening = "$$";
    closing = "$$";
  } else if (source.startsWith("\\(")) {
    opening = "\\(";
    closing = "\\)";
  } else if (source.startsWith("\\[")) {
    opening = "\\[";
    closing = "\\]";
  } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
    opening = "$";
    closing = "$";
  } else {
    return undefined;
  }

  const closingIndex = findClosingDelimiter(source, closing, opening.length);
  // 排除误判：$5 000 $、$10 后接数字、$VAR 环境变量、以及内含反引号的片段。
  if (
    closingIndex >= 0 &&
    opening === "$" &&
    (/\s$/.test(source.slice(opening.length, closingIndex)) ||
      /^\d/.test(source.slice(closingIndex + 1)) ||
      (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
        /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
      source.slice(opening.length, closingIndex).includes("`"))
  ) {
    return undefined;
  }

  if (closingIndex < 0) {
    const pendingSource = source.slice(opening.length);
    if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
      return { type: "latex", raw: source, text: pendingSource, pending: true };
    }
    return undefined;
  }

  const text = source.slice(opening.length, closingIndex);
  if (!text || text.includes(EOL)) return undefined;

  return { type: "latex", raw: source.slice(0, closingIndex + closing.length), text };
}

function tokenizeBlockLatex(source) {
  const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
  if (dollarMatch?.[1]) {
    return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
  }

  const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
  if (bracketMatch?.[1]) {
    return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
  }

  const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingBracket) {
    return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
  }
  const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
    return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
  }
  return undefined;
}

const LATEX_EXTENSIONS = [
  {
    name: "latexBlock",
    level: "block",
    start(source) {
      const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
      return match ? match.index + (match[0].startsWith(EOL) ? 1 : 0) : undefined;
    },
    tokenizer: tokenizeBlockLatex,
  },
  {
    name: "latex",
    level: "inline",
    start(source) {
      const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
        (index) => index >= 0
      );
      return indices.length > 0 ? Math.min(...indices) : undefined;
    },
    tokenizer: tokenizeInlineLatex,
  },
];

/** OSC 8 超链接支持探测（保守启发式，仅读一次环境）。 */
function supportsHyperlinks() {
  const env = process.env;
  if (env.FORCE_HYPERLINK === "1") return true;
  if (!process.stdout.isTTY) return false;
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm") return true;
  if (env.TERM_PROGRAM === "vscode" || env.WT_SESSION) return true;
  if (env.VTE_VERSION && Number.parseInt(env.VTE_VERSION, 10) >= 5000) return true;
  if (env.KITTY_WINDOW_ID || env.KONSOLE_VERSION || env.GHOSTTY_RESOURCES_DIR) return true;
  return false;
}

function createHyperlink(url, text = url) {
  if (!supportsHyperlinks()) return text === url ? url : `${text} (${url})`;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

/** 按 Markdown 表格列对齐方式补齐显示宽度（ANSI 样式不参与宽度计算）。 */
export function padAligned(content, displayWidth, targetWidth, align) {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === "center") {
    const leftPadding = Math.floor(padding / 2);
    return " ".repeat(leftPadding) + content + " ".repeat(padding - leftPadding);
  }
  if (align === "right") {
    return " ".repeat(padding) + content;
  }
  return content + " ".repeat(padding);
}

function numberToLetter(n) {
  let result = "";
  while (n > 0) {
    n--;
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const ROMAN_VALUES = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function numberToRoman(n) {
  let result = "";
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral;
      n -= value;
    }
  }
  return result;
}

/** 有序列表编号按嵌套深度轮换：数字 → 数字 → 字母 → 罗马数字。 */
function getListNumber(listDepth, orderedListNumber) {
  switch (listDepth) {
    case 2:
      return numberToLetter(orderedListNumber);
    case 3:
      return numberToRoman(orderedListNumber);
    default:
      return String(orderedListNumber);
  }
}

function formatChildren(tokens, parent = null, listDepth = 0, orderedListNumber = null) {
  return (tokens ?? [])
    .map((child) => formatToken(child, listDepth, orderedListNumber, parent))
    .join("");
}

/** marked token → ANSI 字符串（纯函数，未知类型回退 token.raw）。 */
export function formatToken(token, listDepth = 0, orderedListNumber = null, parent = null) {
  switch (token.type) {
    case "blockquote": {
      const inner = formatChildren(token.tokens);
      const bar = chalk.dim("│");
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL);
    }
    // 代码块原样输出，不做语法高亮：终端里只有一份 ANSI 调色板，染色带来的观感收益
    // 抵不上一条语言包依赖（外加每帧流式渲染的解析成本），而且半截代码块常常解析失败。
    case "code":
      return token.text + EOL;
    case "codespan":
      return chalk.cyan(token.text);
    case "em":
      return chalk.italic(formatChildren(token.tokens, parent));
    case "strong":
      return chalk.bold(formatChildren(token.tokens, parent));
    case "heading": {
      const inner = formatChildren(token.tokens);
      const styled = token.depth === 1 ? chalk.bold.underline(inner) : chalk.bold(inner);
      return styled + EOL + EOL;
    }
    case "hr":
      return "---" + EOL;
    case "image":
      return token.href;
    // 行内公式：不支持的语法或流式未闭合片段回退原始源码。
    case "latex": {
      if (token.pending) return token.raw;
      return renderLatex(token.text) ?? token.raw;
    }
    // 块级公式：允许纵向排版，整体独占若干行。
    // 与代码块、表格一致，末尾补一个空行与后续内容分隔（tokenizer 已吞掉
    // 结尾换行，marked 不会再产生 space token）。
    case "latexBlock": {
      const rendered = token.pending
        ? token.raw.trim()
        : renderLatex(token.text, { display: true }) ?? token.raw.trim();
      return rendered + EOL + EOL;
    }
    case "link": {
      if (token.href.startsWith("mailto:")) return token.href.replace(/^mailto:/, "");
      const linkText = formatChildren(token.tokens, token);
      const plainLinkText = stripAnsi(linkText);
      if (plainLinkText && plainLinkText !== token.href) return createHyperlink(token.href, linkText);
      return createHyperlink(token.href);
    }
    case "list":
      return token.items
        .map((item, index) =>
          formatToken(item, listDepth, token.ordered ? token.start + index : null, token)
        )
        .join("");
    case "list_item":
      return (token.tokens ?? [])
        .map(
          (child) =>
            `${"  ".repeat(listDepth)}${formatToken(child, listDepth + 1, orderedListNumber, token)}`
        )
        .join("");
    case "paragraph":
      return formatChildren(token.tokens) + EOL;
    case "space":
      return EOL;
    case "br":
      return EOL;
    case "text":
      if (parent?.type === "link") return token.text;
      if (parent?.type === "list_item") {
        const marker = orderedListNumber === null ? "-" : `${getListNumber(listDepth, orderedListNumber)}.`;
        const inner = token.tokens
          ? formatChildren(token.tokens, token, listDepth, orderedListNumber)
          : token.text;
        return `${marker} ${inner}${EOL}`;
      }
      return token.tokens ? formatChildren(token.tokens, token) : token.text;
    case "table":
      return renderTable(token);
    case "escape":
      return token.text;
    case "def":
    case "del":
    case "html":
      return "";
    default:
      // 未特殊处理的 token 按原文输出，避免渲染异常时静默丢内容。
      return token.raw ?? "";
  }
}

const TABLE_SAFETY_MARGIN = 4;
const TABLE_MIN_COLUMN_WIDTH = 3;
const TABLE_MAX_ROW_LINES = 4;
const ANSI_BOLD_START = "\u001B[1m";
const ANSI_BOLD_END = "\u001B[22m";

function getTableTerminalWidth() {
  const columns = Number(process.stdout?.columns);
  // Message reserves two columns for its role marker. When running tests or
  // through a pipe there may be no terminal width; in that case keep the
  // complete content instead of arbitrarily wrapping it.
  return Number.isFinite(columns) && columns > 0 ? Math.max(columns - 2, 1) : Infinity;
}

function wrapPlainText(text, width, hard) {
  const lines = [];
  for (const sourceLine of text.split(EOL)) {
    if (sourceLine.length === 0) {
      lines.push("");
      continue;
    }

    let remaining = sourceLine;
    while (stringWidth(remaining) > width) {
      let cut = 0;
      let currentWidth = 0;
      let lastSpace = -1;
      for (const character of remaining) {
        const characterWidth = stringWidth(character);
        if (currentWidth + characterWidth > width) break;
        currentWidth += characterWidth;
        cut += character.length;
        if (/\s/.test(character)) lastSpace = cut;
      }
      if (cut === 0) {
        cut = Math.max(1, Array.from(remaining)[0].length);
      } else if (!hard && lastSpace > 0) {
        cut = lastSpace;
      }
      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

/** ANSI-aware wrapping. */
function wrapTableText(text, width, hard = false) {
  const trimmedText = text.trimEnd();
  if (!Number.isFinite(width) || width <= 0) return [trimmedText];

  let wrapped;
  if (typeof Bun !== "undefined" && typeof Bun.wrapAnsi === "function") {
    wrapped = Bun.wrapAnsi(trimmedText, width, {
      hard,
      trim: false,
      wordWrap: true,
    });
  } else {
    // This path is only for non-Bun consumers; Miro itself requires Bun.
    wrapped = wrapPlainText(stripAnsi(trimmedText), width, hard).join(EOL);
  }
  const lines = wrapped.split(EOL).filter((line) => line.length > 0);
  return lines.length > 0 ? lines : [""];
}

function renderTable(tableToken) {
  const headers = tableToken.header ?? [];
  const rows = tableToken.rows ?? [];
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 0);
  if (columnCount === 0) return "";

  const formatCell = (cell) => formatChildren(cell?.tokens);
  const getPlainText = (cell) => stripAnsi(formatCell(cell));
  const getMinWidth = (cell) => {
    const text = getPlainText(cell);
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return TABLE_MIN_COLUMN_WIDTH;
    return Math.max(...words.map((word) => stringWidth(word)), TABLE_MIN_COLUMN_WIDTH);
  };
  const getIdealWidth = (cell) => Math.max(stringWidth(getPlainText(cell)), TABLE_MIN_COLUMN_WIDTH);

  const minWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
    let width = getMinWidth(headers[columnIndex]);
    for (const row of rows) width = Math.max(width, getMinWidth(row[columnIndex]));
    return width;
  });
  const idealWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
    let width = getIdealWidth(headers[columnIndex]);
    for (const row of rows) width = Math.max(width, getIdealWidth(row[columnIndex]));
    return width;
  });

  const terminalWidth = getTableTerminalWidth();
  const borderOverhead = 1 + columnCount * 3;
  const availableWidth = Number.isFinite(terminalWidth)
    ? Math.max(terminalWidth - borderOverhead - TABLE_SAFETY_MARGIN, columnCount * TABLE_MIN_COLUMN_WIDTH)
    : Infinity;
  const totalMin = minWidths.reduce((sum, width) => sum + width, 0);
  const totalIdeal = idealWidths.reduce((sum, width) => sum + width, 0);

  let needsHardWrap = false;
  let columnWidths;
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, index) => ideal - minWidths[index]);
    const totalOverflow = overflows.reduce((sum, overflow) => sum + overflow, 0);
    columnWidths = minWidths.map((min, index) => {
      if (totalOverflow === 0) return min;
      return min + Math.floor((overflows[index] / totalOverflow) * extraSpace);
    });
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minWidths.map((width) => Math.max(Math.floor(width * scaleFactor), TABLE_MIN_COLUMN_WIDTH));
  }

  const allRows = [headers, ...rows];
  const getRowLines = (cells, isHeader) => {
    const cellLines = Array.from({ length: columnCount }, (_, columnIndex) =>
      wrapTableText(formatCell(cells[columnIndex]), columnWidths[columnIndex], needsHardWrap)
    );
    const maxLines = Math.max(...cellLines.map((lines) => lines.length), 1);
    const verticalOffsets = cellLines.map((lines) => Math.floor((maxLines - lines.length) / 2));
    const result = [];

    for (let lineIndex = 0; lineIndex < maxLines; lineIndex++) {
      let line = "│";
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        const lines = cellLines[columnIndex];
        const contentIndex = lineIndex - verticalOffsets[columnIndex];
        const lineText = contentIndex >= 0 && contentIndex < lines.length ? lines[contentIndex] : "";
        const align = isHeader ? "center" : tableToken.align?.[columnIndex] ?? "left";
        line += ` ${padAligned(lineText, stringWidth(lineText), columnWidths[columnIndex], align)} │`;
      }
      result.push(line);
    }
    return result;
  };

  const maxRowLines = Math.max(
    ...allRows.flatMap((cells) =>
      Array.from({ length: columnCount }, (_, columnIndex) =>
        wrapTableText(formatCell(cells[columnIndex]), columnWidths[columnIndex], needsHardWrap).length
      )
    ),
    1
  );

  const renderBorder = (type) => {
    const borders = {
      top: ["┌", "─", "┬", "┐"],
      middle: ["├", "─", "┼", "┤"],
      bottom: ["└", "─", "┴", "┘"],
    };
    const [left, horizontal, cross, right] = borders[type];
    let line = left;
    columnWidths.forEach((width, index) => {
      line += horizontal.repeat(width + 2);
      line += index < columnWidths.length - 1 ? cross : right;
    });
    return line;
  };

  const renderVertical = () => {
    const safeWidth = Number.isFinite(terminalWidth) ? terminalWidth : 80;
    const separator = "─".repeat(Math.max(1, Math.min(safeWidth - 1, 40)));
    const lines = [];
    for (const [rowIndex, row] of rows.entries()) {
      if (rowIndex > 0) lines.push(separator);
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        const label = getPlainText(headers[columnIndex]) || `Column ${columnIndex + 1}`;
        const value = formatCell(row[columnIndex]).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        const firstWidth = Math.max(safeWidth - stringWidth(label) - 3, 10);
        const continuationWidth = Math.max(safeWidth - 3, 10);
        const firstPass = wrapTableText(value, firstWidth);
        let wrappedValue = firstPass;
        if (firstPass.length > 1 && continuationWidth > firstWidth) {
          const remaining = firstPass.slice(1).map((line) => line.trim()).join(" ");
          wrappedValue = [firstPass[0], ...wrapTableText(remaining, continuationWidth)];
        }
        lines.push(`${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} ${wrappedValue[0] ?? ""}`);
        for (const line of wrappedValue.slice(1)) {
          if (line.trim()) lines.push(`  ${line}`);
        }
      }
    }
    return lines.join(EOL);
  };

  if (maxRowLines > TABLE_MAX_ROW_LINES) return renderVertical();

  const tableLines = [renderBorder("top"), ...getRowLines(headers, true), renderBorder("middle")];
  rows.forEach((row, rowIndex) => {
    tableLines.push(...getRowLines(row, false));
    if (rowIndex < rows.length - 1) tableLines.push(renderBorder("middle"));
  });
  tableLines.push(renderBorder("bottom"));

  const maxLineWidth = Math.max(...tableLines.map((line) => stringWidth(line)), 0);
  if (Number.isFinite(terminalWidth) && maxLineWidth > terminalWidth - TABLE_SAFETY_MARGIN) {
    return renderVertical();
  }
  return tableLines.join(EOL) + EOL;
}

// 快速路径：前 500 字符内无 markdown 特征字符时跳过完整解析。
// `$` 与 `\` 纳入特征集，否则纯公式文本（如 `$x^2$`）会被跳过而不渲染。
const MARKDOWN_SYNTAX_PATTERN = /[*_`#>[\]~|\-$\\]/;

/** 文本是否可能含 markdown 语法（采样前 500 字符）。 */
export function hasMarkdownSyntax(text) {
  return MARKDOWN_SYNTAX_PATTERN.test(text.slice(0, 500));
}

/**
 * 渲染 markdown 为 ANSI 字符串（同步）。
 * 空结果或解析异常时回退原文，保证展示层永不因渲染失败丢内容。
 */
export function renderMarkdown(text) {
  if (!text || text.trim().length === 0) return text;
  if (!hasMarkdownSyntax(text)) return text;
  configureMarked();
  try {
    const rendered = marked
      .lexer(text)
      .map((token) => formatToken(token))
      .join("")
      .trimEnd();
    return rendered.length > 0 ? rendered : text;
  } catch {
    return text;
  }
}
