// LaTeX 数学表达式 → 终端友好 Unicode 文本渲染器。
//
// 不引入 KaTeX 之类的重型依赖，只做「能可靠渲染的子集」，遇到不支持或
// 残缺的语法时返回 undefined，由调用方回退显示原始 LaTeX 源码。
//
// 设计要点：
// - 行内模式（display=false）压成单行，分式退化为 a/b；
// - 块级模式（display=true）允许纵向排版：分式上下堆叠、∑/∫ 的上下限
//   放到符号上下方、矩阵多行对齐；
// - 纵向排版通过「布局占位符」两阶段完成：解析阶段先输出私有区标记，
//   最后由 renderLayout 把标记展开成多行并按基线对齐。

import { stringWidth } from "./markdown-width.js";

/** 命令名 → Unicode 符号。 */
const SYMBOLS = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  varkappa: "ϰ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  pm: "±",
  mp: "∓",
  times: "×",
  div: "÷",
  cdot: "·",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "•",
  oplus: "⊕",
  ominus: "⊖",
  otimes: "⊗",
  oslash: "⊘",
  odot: "⊙",
  bigcirc: "○",
  dagger: "†",
  ddagger: "‡",
  amalg: "⨿",
  uplus: "⊎",
  sqcap: "⊓",
  sqcup: "⊔",
  bowtie: "⋈",
  Join: "⋈",
  ltimes: "⋉",
  rtimes: "⋊",
  leftouterjoin: "⟕",
  rightouterjoin: "⟖",
  fullouterjoin: "⟗",
  triangleleft: "◁",
  triangleright: "▷",
  wr: "≀",
  cap: "∩",
  cup: "∪",
  bigcap: "⋂",
  bigcup: "⋃",
  bigwedge: "⋀",
  bigvee: "⋁",
  bigsqcup: "⨆",
  biguplus: "⨄",
  bigoplus: "⨁",
  bigotimes: "⨂",
  bigodot: "⨀",
  setminus: "∖",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  supset: "⊃",
  subseteq: "⊆",
  supseteq: "⊇",
  sqsubset: "⊏",
  sqsupset: "⊐",
  sqsubseteq: "⊑",
  sqsupseteq: "⊒",
  prec: "≺",
  preceq: "≼",
  succ: "≻",
  succeq: "≽",
  ll: "≪",
  gg: "≫",
  le: "≤",
  leq: "≤",
  leqslant: "≤",
  ge: "≥",
  geq: "≥",
  geqslant: "≥",
  ne: "≠",
  neq: "≠",
  equiv: "≡",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  asymp: "≍",
  doteq: "≐",
  propto: "∝",
  parallel: "∥",
  perp: "⊥",
  mid: "∣",
  vdash: "⊢",
  dashv: "⊣",
  models: "⊨",
  Vdash: "⊩",
  Vvdash: "⊪",
  nvdash: "⊬",
  nvDash: "⊭",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  neg: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  to: "→",
  rightarrow: "→",
  longrightarrow: "→",
  leftarrow: "←",
  longleftarrow: "←",
  gets: "←",
  leftrightarrow: "↔",
  longleftrightarrow: "↔",
  hookleftarrow: "↩",
  hookrightarrow: "↪",
  twoheadleftarrow: "↞",
  twoheadrightarrow: "↠",
  leftharpoonup: "↼",
  leftharpoondown: "↽",
  rightharpoonup: "⇀",
  rightharpoondown: "⇁",
  rightleftharpoons: "⇌",
  leftrightharpoons: "⇋",
  nearrow: "↗",
  searrow: "↘",
  swarrow: "↙",
  nwarrow: "↖",
  rightsquigarrow: "⇝",
  leadsto: "⇝",
  Rightarrow: "⇒",
  Longrightarrow: "⇒",
  Leftarrow: "⇐",
  Longleftarrow: "⇐",
  Leftrightarrow: "⇔",
  Longleftrightarrow: "⇔",
  implies: "⇒",
  iff: "⇔",
  mapsto: "↦",
  longmapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  partial: "∂",
  nabla: "∇",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  sum: "∑",
  prod: "∏",
  coprod: "∐",
  infty: "∞",
  emptyset: "∅",
  varnothing: "∅",
  angle: "∠",
  therefore: "∴",
  because: "∵",
  aleph: "ℵ",
  beth: "ℶ",
  gimel: "ℷ",
  daleth: "ℸ",
  top: "⊤",
  bot: "⊥",
  triangle: "△",
  square: "□",
  lozenge: "◊",
  checkmark: "✓",
  complement: "∁",
  wp: "℘",
  prime: "′",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  vdots: "⋮",
  ddots: "⋱",
  ell: "ℓ",
  hbar: "ℏ",
  Im: "ℑ",
  Re: "ℜ",
  langle: "⟨",
  rangle: "⟩",
  vert: "|",
  lvert: "|",
  rvert: "|",
  Vert: "‖",
  lVert: "‖",
  rVert: "‖",
  lbrace: "{",
  rbrace: "}",
  backslash: "\\",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  colon: ":",
};

/** 直接按名字输出的函数名（sin、log…），两侧按需补空格。 */
const NAMED_OPERATORS = new Set([
  "arccos", "arcsin", "arctan", "arg", "cos", "cosh", "cot", "coth", "csc", "deg",
  "det", "dim", "exp", "gcd", "hom", "inf", "ker", "lg", "lim", "liminf", "limsup",
  "ln", "log", "max", "min", "Pr", "sec", "sin", "sinh", "sup", "tan", "tanh",
]);

/** 上下限写在符号上下方的算子（display 模式生效）。 */
const LIMIT_OPERATORS = new Set([
  "argmax", "argmin", "inf", "injlim", "lim", "liminf", "limsup", "max", "min",
  "projlim", "sup",
]);

/** display 模式下上下限纵向排布的大符号。 */
const DISPLAY_LIMIT_SYMBOLS = new Set([
  "bigcap", "bigcup", "bigodot", "bigoplus", "bigotimes", "bigsqcup", "biguplus",
  "bigvee", "bigwedge", "coprod", "int", "iint", "iiint", "oint", "prod", "sum",
]);

/** 关系符号：两侧留空格。 */
const RELATION_COMMANDS = new Set([
  "Leftarrow", "Leftrightarrow", "Longleftarrow", "Longleftrightarrow", "Longrightarrow",
  "Rightarrow", "Join", "Vdash", "Vvdash", "approx", "asymp", "bowtie", "cong", "dashv",
  "fullouterjoin", "doteq", "downarrow", "equiv", "ge", "geq", "geqslant", "gets", "gg",
  "hookleftarrow", "hookrightarrow", "iff", "implies", "in", "leadsto", "le", "leftarrow",
  "leftharpoondown", "leftharpoonup", "leftouterjoin", "leftrightarrow", "leftrightharpoons",
  "leq", "leqslant", "ll", "longleftarrow", "longleftrightarrow", "longmapsto", "ltimes",
  "longrightarrow", "mapsto", "mid", "models", "ne", "nearrow", "neq", "ni", "notin",
  "nvdash", "nvDash", "nwarrow", "parallel", "perp", "prec", "preceq", "propto",
  "rightharpoondown", "rightharpoonup", "rightouterjoin", "rightleftharpoons",
  "rightarrow", "rightsquigarrow", "rtimes", "searrow", "sim", "simeq", "sqsubset",
  "sqsubseteq", "sqsupset", "sqsupseteq", "subset",
  "subseteq", "succ", "succeq", "supset", "supseteq", "swarrow", "to", "triangleleft",
  "triangleright", "twoheadleftarrow", "twoheadrightarrow", "uparrow", "vdash",
]);

/** \not 的预组合否定形式，优先于组合用斜线 U+0338。 */
const NEGATED_SYMBOLS = {
  "<": "≮",
  ">": "≯",
  "=": "≠",
  "∈": "∉",
  "∋": "∌",
  "∣": "∤",
  "∥": "∦",
  "∼": "≁",
  "≃": "≄",
  "≅": "≇",
  "≈": "≉",
  "≡": "≢",
  "≤": "≰",
  "≥": "≱",
  "≺": "⊀",
  "≻": "⊁",
  "⊂": "⊄",
  "⊃": "⊅",
  "⊆": "⊈",
  "⊇": "⊉",
  "⊢": "⊬",
  "⊨": "⊭",
  "↔": "↮",
  "←": "↚",
  "→": "↛",
  "⇒": "⇏",
  "⇐": "⇍",
  "⇔": "⇎",
  "≼": "⋠",
  "≽": "⋡",
};

/** \mathbb 黑板粗体。 */
const BLACKBOARD = {
  C: "ℂ",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};

const SUPERSCRIPTS = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷",
  "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ",
  k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ",
  v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};

const SUBSCRIPTS = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇",
  "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ",
  p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

/** 渲染成一个普通空格的间距命令。 */
const SPACING_COMMANDS = new Set([
  ",", ":", ";", " ", ">", "enspace", "enskip", "medspace", "quad", "qquad",
  "thickspace", "thinspace",
]);

/** 负间距命令：吞掉前面已产生的空格。 */
const NEGATIVE_SPACING_COMMANDS = new Set(["!", "negmedspace", "negthickspace", "negthinspace"]);
const NEGATIVE_SPACE = "\u0000";

/** 纯排版指令，终端下无意义，直接丢弃。 */
const IGNORED_COMMANDS = new Set([
  "displaystyle", "limits", "nolimits", "scriptstyle", "scriptscriptstyle", "textstyle",
]);

/** 括号放大命令，终端下无法体现，直接丢弃。 */
const SIZE_COMMANDS = new Set([
  "big", "Big", "bigg", "Bigg", "bigl", "Bigl", "biggl", "Biggl",
  "bigr", "Bigr", "biggr", "Biggr",
]);

/** 只取参数内容、不额外装饰的包装命令。 */
const PLAIN_WRAPPERS = new Set([
  "emph", "mathcal", "mathbf", "mathfrak", "mathit", "mathrm", "mathnormal", "mathscr",
  "mathsf", "mathtt", "mathup", "mbox", "overbrace", "pmb", "smash", "substack", "text",
  "textbf", "textit", "textmd", "textnormal", "textrm", "textsc", "textsf", "textsl",
  "texttt", "textup", "underbrace", "bm", "boldsymbol",
]);

/** 重音符：Unicode 组合字符，附加在单个字符之后。 */
const ACCENTS = {
  acute: "\u0301",
  bar: "\u0305",
  breve: "\u0306",
  check: "\u030c",
  ddot: "\u0308",
  dot: "\u0307",
  grave: "\u0300",
  hat: "\u0302",
  mathring: "\u030a",
  overleftarrow: "\u20d6",
  overleftrightarrow: "\u20e1",
  overline: "\u0305",
  overrightarrow: "\u20d7",
  tilde: "\u0303",
  underline: "\u0332",
  vec: "\u20d7",
  widehat: "\u0302",
  widetilde: "\u0303",
};

/** 逐字符替换；任一字符无对应映射时返回 undefined（表示无法用 Unicode 表达）。 */
function replaceCharacters(value, replacements) {
  let result = "";
  for (const character of value) {
    const replacement = replacements[character];
    if (replacement === undefined) return undefined;
    result += replacement;
  }
  return result;
}

/** 上/下标：能整体转 Unicode 就转，否则退化为 ^(...) / _(...)。 */
function formatScript(value, kind) {
  value = value.trim();
  const replacements = kind === "sub" ? SUBSCRIPTS : SUPERSCRIPTS;
  const unicode = replaceCharacters(value.replace(/\s*([=+-])\s*/g, "$1"), replacements);
  if (unicode !== undefined) return unicode;

  const prefix = kind === "sub" ? "_" : "^";
  if (Array.from(value).length === 1 || (kind === "sub" && /^[A-Za-z]+$/.test(value))) {
    return `${prefix}${value}`;
  }
  return `${prefix}(${value})`;
}

/** 行内分式：简单项直接 a/b，复杂项加括号避免歧义。 */
function formatFraction(numerator, denominator) {
  numerator = numerator.trim();
  denominator = denominator.trim();
  const simpleNumerator = /^[\p{L}\p{N}.]+$/u.test(numerator);
  const simpleDenominator = /^[\p{N}.]+$/u.test(denominator) || Array.from(denominator).length === 1;
  return `${simpleNumerator ? numerator : `(${numerator})`}/${simpleDenominator ? denominator : `(${denominator})`}`;
}

function formatRoot(value, symbol = "√") {
  value = value.trim();
  return /^[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`;
}

// 函数名两侧的空格需要「按上下文」决定（如 i\sin θ → i sin θ，但 -\sin θ → -sin θ），
// 因此先用私有区标记包裹，最后统一处理。
const NAMED_OPERATOR_START = "\u{f0004}";
const NAMED_OPERATOR_END = "\u{f0005}";
const NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
const NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;

/** 清理内部标记、压缩空白，并丢弃首尾空行。 */
function normalizeOutput(value) {
  return value
    .replace(NAMED_OPERATOR_LEFT_SPACING_PATTERN, " ")
    .replaceAll(NAMED_OPERATOR_START, "")
    .replace(NAMED_OPERATOR_RIGHT_SPACING_PATTERN, " ")
    .replaceAll(NAMED_OPERATOR_END, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join("\n")
    .trim();
}

// 纵向布局占位符：解析阶段插入 \u{f0000}<index>\u{f0001}，
// renderLayout 再按 index 取回节点展开成多行。
const LAYOUT_MARKER_START = "\u{f0000}";
const LAYOUT_MARKER_END = "\u{f0001}";
const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
// 矩阵列对齐用的空格不能被 normalizeOutput 压缩，先用私有区字符占位。
const PROTECTED_SPACE = "\u{f0002}";

function padLayoutLine(line, width, centered = false) {
  const padding = Math.max(0, width - stringWidth(line));
  const left = centered ? Math.floor(padding / 2) : 0;
  return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
}

/** 多个子布局按基线水平拼接。 */
function joinLayouts(layouts) {
  if (layouts.length === 0) return { lines: [""], width: 0, baseline: 0 };

  const baseline = Math.max(...layouts.map((layout) => layout.baseline));
  const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
  const lines = [];
  for (let row = 0; row <= baseline + below; row++) {
    let line = "";
    for (const layout of layouts) {
      const sourceRow = row - baseline + layout.baseline;
      line +=
        sourceRow >= 0 && sourceRow < layout.lines.length
          ? padLayoutLine(layout.lines[sourceRow] ?? "", layout.width)
          : " ".repeat(layout.width);
    }
    lines.push(line.trimEnd());
  }
  return {
    lines,
    width: layouts.reduce((width, layout) => width + layout.width, 0),
    baseline,
  };
}

/** 把带布局标记的字符串展开为按基线对齐的多行文本。 */
function renderLayout(source, nodes) {
  const renderedLines = [];
  let firstBaseline = 0;
  for (const sourceLine of source.split("\n")) {
    const layouts = [];
    let position = 0;
    let previousNode;
    for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
      const index = match.index;
      const node = nodes[Number(match[1])];
      if (!node) continue;

      if (index > position) {
        const sliced = sourceLine.slice(position, index);
        const trimmed = (previousNode ? sliced.trimStart() : sliced).trimEnd();
        // 矩阵与相邻文本之间的单个空格需要保留，否则会粘在括号上。
        const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(sliced);
        const preserveTrailingSpace = node.type === "matrix" && /\s$/.test(sliced);
        const text = trimmed
          ? `${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}`
          : preserveLeadingSpace || preserveTrailingSpace
            ? " "
            : "";
        layouts.push({ lines: [text], width: stringWidth(text), baseline: 0 });
      }

      if (node.type === "fraction") {
        const numerator = renderLayout(node.numerator, nodes);
        const denominator = renderLayout(node.denominator, nodes);
        const contentWidth = Math.max(numerator.width, denominator.width, 1);
        const width = contentWidth + 2;
        layouts.push({
          lines: [
            ...numerator.lines.map((line) => padLayoutLine(line, width, true)),
            ` ${"─".repeat(contentWidth)} `,
            ...denominator.lines.map((line) => padLayoutLine(line, width, true)),
          ],
          width,
          baseline: numerator.lines.length,
        });
      } else if (node.type === "operator") {
        const contentWidth = Math.max(
          stringWidth(node.operator),
          node.lower === undefined ? 0 : stringWidth(node.lower),
          node.upper === undefined ? 0 : stringWidth(node.upper)
        );
        const lines = [];
        if (node.upper !== undefined) lines.push(`${padLayoutLine(node.upper, contentWidth, true)} `);
        lines.push(`${padLayoutLine(node.operator, contentWidth, true)} `);
        if (node.lower !== undefined) lines.push(`${padLayoutLine(node.lower, contentWidth, true)} `);
        layouts.push({
          lines,
          width: contentWidth + 1,
          baseline: node.upper === undefined ? 0 : 1,
        });
      } else {
        const width = Math.max(0, ...node.lines.map((line) => stringWidth(line)));
        layouts.push({
          lines: node.lines.map((line) => padLayoutLine(line, width)),
          width,
          baseline: node.baseline,
        });
      }
      position = index + match[0].length;
      previousNode = node;
    }

    if (position < sourceLine.length) {
      const sliced = sourceLine.slice(position);
      const trimmed = previousNode ? sliced.trimStart() : sliced;
      const text = previousNode?.type === "matrix" && /^\s/.test(sliced) ? ` ${trimmed}` : trimmed;
      layouts.push({ lines: [text], width: stringWidth(text), baseline: 0 });
    }

    const lineLayout = joinLayouts(layouts);
    if (renderedLines.length === 0) firstBaseline = lineLayout.baseline;
    renderedLines.push(...lineLayout.lines);
  }
  return {
    lines: renderedLines,
    width: Math.max(0, ...renderedLines.map((line) => stringWidth(line))),
    baseline: firstBaseline,
  };
}

/**
 * 递归下降解析器。任何不认识的命令都会把 supported 置为 false，
 * 最终 render() 返回 undefined，让调用方保留原始 LaTeX 文本。
 */
class LatexParser {
  constructor(source, layoutNodes, display) {
    this.source = source;
    this.layoutNodes = layoutNodes;
    this.display = display;
    this.position = 0;
    this.supported = true;
    this.stackFractions = true;
  }

  render() {
    const rendered = this.parseSequence();
    // 未消费完输入（例如多余的 `}`）同样视为不支持。
    if (!this.supported || this.position !== this.source.length) return undefined;
    return normalizeOutput(rendered);
  }

  parseSequence(endCharacter) {
    let result = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (endCharacter && character === endCharacter) {
        this.position++;
        return result;
      }

      if (character === "}") {
        this.supported = false;
        return result;
      }

      if (character === "{") {
        this.position++;
        result += this.parseSequence("}");
        continue;
      }

      if (character === "\\") {
        const command = this.parseCommand();
        if (command === NEGATIVE_SPACE) {
          result = result.trimEnd();
          if (result.endsWith(NAMED_OPERATOR_END)) {
            result = result.slice(0, -NAMED_OPERATOR_END.length);
          }
        } else {
          result += command;
        }
        continue;
      }

      if (character === "^" || character === "_") {
        this.position++;
        result = result.trimEnd();
        const script = formatScript(this.parseRequiredArgument(false), character === "_" ? "sub" : "sup");
        // 上下标要写进函数名标记内部，保证 \sin^2 x 渲染成 sin² x。
        if (result.endsWith(NAMED_OPERATOR_END)) {
          result = `${result.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
        } else {
          result += script;
        }
        continue;
      }

      if (/\s/.test(character)) {
        result += this.parseWhitespace();
        continue;
      }

      if (character === "=" || character === "<" || character === ">") {
        result = `${result.trimEnd()} ${character} `;
        this.position++;
        continue;
      }

      // 对齐标记在终端里没有意义。
      if (character === "&") {
        this.position++;
        continue;
      }

      if (character === "~") {
        this.position++;
        result += " ";
        continue;
      }

      // 紧跟矩阵的句号（公式收尾）应贴在矩阵最后一行，而不是另起一行。
      if (character === ".") {
        const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
        const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
        if (node?.type === "matrix") {
          const lastLine = node.lines.length - 1;
          node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
          this.position++;
          continue;
        }
      }

      result += character;
      this.position++;
    }

    // 期待闭合符号却读到结尾。
    if (endCharacter) this.supported = false;
    return result;
  }

  parseWhitespace() {
    while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    return " ";
  }

  parseCommand() {
    this.position++;
    if (this.position >= this.source.length) {
      this.supported = false;
      return "";
    }

    let command = "";
    const first = this.source[this.position] ?? "";
    // 反斜杠 + 换行是被折行切断的控制空格，等价于一个空格。
    if (first === "\n" || first === "\r") {
      this.position++;
      if (first === "\r" && this.source[this.position] === "\n") this.position++;
      return " ";
    }
    if (/[A-Za-z]/.test(first)) {
      const start = this.position;
      while (this.position < this.source.length && /[A-Za-z]/.test(this.source[this.position] ?? "")) {
        this.position++;
      }
      command = this.source.slice(start, this.position);
    } else {
      command = first;
      this.position++;
    }

    if (command === "\\") return "\n";
    if (SPACING_COMMANDS.has(command)) return " ";
    if (NEGATIVE_SPACING_COMMANDS.has(command)) return NEGATIVE_SPACE;
    if (IGNORED_COMMANDS.has(command)) return "";
    if (
      command === "{" ||
      command === "}" ||
      command === "$" ||
      command === "%" ||
      command === "#" ||
      command === "_" ||
      command === "&"
    ) {
      return command;
    }
    if (command === "|") return "‖";

    if (command === "not") {
      const value = this.parseRequiredArgument(false).trim();
      const negated = NEGATED_SYMBOLS[value];
      if (negated !== undefined) return ` ${negated} `;
      const characters = Array.from(value);
      if (characters.length === 0) {
        this.supported = false;
        return "";
      }
      // 没有预组合字形时退化为组合用长斜线。
      return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
    }

    if (LIMIT_OPERATORS.has(command)) {
      return this.parseOperator(command, "bracket", true, true);
    }

    const symbol = SYMBOLS[command];
    if (symbol !== undefined) {
      if (DISPLAY_LIMIT_SYMBOLS.has(command)) return this.parseOperator(symbol, "script", true);
      return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command)
        ? ` ${symbol} `
        : symbol;
    }

    if (NAMED_OPERATORS.has(command)) {
      return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
    }
    if (SIZE_COMMANDS.has(command)) return "";

    // \left. / \right. 的点号不是内容。
    if (command === "left" || command === "middle" || command === "right") {
      if (this.source[this.position] === ".") this.position++;
      return "";
    }

    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      // \tfrac 与嵌套在上下标里的分式始终走行内形式。
      const shouldStack = this.display && this.stackFractions && command !== "tfrac";
      const numerator = this.parseRequiredArgument(!shouldStack);
      const denominator = this.parseRequiredArgument(!shouldStack);
      if (shouldStack) {
        const index =
          this.layoutNodes.push({
            type: "fraction",
            numerator: normalizeOutput(numerator),
            denominator: normalizeOutput(denominator),
          }) - 1;
        return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
      }
      return formatFraction(numerator, denominator);
    }

    if (command === "sqrt") {
      const degree = this.parseOptionalArgument()?.trim();
      const value = this.parseRequiredArgument();
      if (degree === undefined || degree === "2") return formatRoot(value);
      if (degree === "3") return formatRoot(value, "∛");
      if (degree === "4") return formatRoot(value, "∜");
      return `${formatScript(degree, "sup")}${formatRoot(value)}`;
    }

    if (command === "boxed" || command === "fbox") {
      return `[${this.parseRequiredArgument().trim()}]`;
    }
    if (command === "binom" || command === "dbinom" || command === "tbinom") {
      return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
    }

    const accent = ACCENTS[command];
    if (accent !== undefined) {
      const value = this.parseRequiredArgument();
      // 组合字符只能挂在单个字符上，多字符时保留命令名以免产生乱码。
      return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
    }

    if (command === "mathbb") {
      const value = this.parseRequiredArgument();
      return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
    }

    if (command === "operatorname") {
      const starred = this.source[this.position] === "*";
      if (starred) this.position++;
      const operator = normalizeOutput(this.parseRequiredArgument()).trim();
      return this.parseOperator(operator, "bracket", starred, true);
    }

    if (command === "mod" || command === "bmod") return " mod ";
    if (command === "pmod" || command === "pod") {
      const value = this.parseRequiredArgument().trim();
      return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
    }

    if (command === "overset" || command === "stackrel") {
      const upper = this.parseRequiredArgument();
      const value = this.parseRequiredArgument().trim();
      return `${value}${formatScript(upper, "sup")}`;
    }
    if (command === "underset") {
      const lower = this.parseRequiredArgument();
      const value = this.parseRequiredArgument().trim();
      return `${value}${formatScript(lower, "sub")}`;
    }

    if (PLAIN_WRAPPERS.has(command)) {
      const value = this.parseRequiredArgument();
      // \text{...} 内的空格是有意义的排版内容，不能 trim。
      return command.startsWith("text") || command === "mbox" ? value : value.trim();
    }

    if (command === "begin") return this.parseEnvironment();
    if (command === "end") {
      this.supported = false;
      return "";
    }

    this.supported = false;
    return `\\${command}`;
  }

  /** 解析算子及其上下限；display 模式下生成纵向布局节点。 */
  parseOperator(operator, inlineLowerStyle, displayLimits, spaced = false) {
    let useDisplayLimits = displayLimits;
    let modifierPosition = this.position;
    while (modifierPosition < this.source.length && /[ \t]/.test(this.source[modifierPosition] ?? "")) {
      modifierPosition++;
    }
    const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
    if (modifier) {
      useDisplayLimits = modifier[1] === "limits";
      this.position = modifierPosition + modifier[0].length;
    }

    let lower;
    let upper;
    while (true) {
      let scriptPosition = this.position;
      while (scriptPosition < this.source.length && /[ \t]/.test(this.source[scriptPosition] ?? "")) {
        scriptPosition++;
      }
      const kind = this.source[scriptPosition];
      if (kind !== "_" && kind !== "^") break;
      this.position = scriptPosition + 1;
      const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
      if (kind === "_") {
        if (lower !== undefined) this.supported = false;
        lower = value;
      } else {
        if (upper !== undefined) this.supported = false;
        upper = value;
      }
    }

    if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
      const index = this.layoutNodes.push({ type: "operator", operator, lower, upper }) - 1;
      return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
    }

    let rendered = operator;
    if (lower !== undefined) {
      rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
    }
    if (upper !== undefined) rendered += formatScript(upper, "sup");
    return spaced ? ` ${rendered} ` : rendered;
  }

  parseRequiredArgument(stackFractions = true) {
    const previousStackFractions = this.stackFractions;
    this.stackFractions = previousStackFractions && stackFractions;
    const value = this.parseRequiredArgumentValue();
    this.stackFractions = previousStackFractions;
    return value;
  }

  parseRequiredArgumentValue() {
    // 必需参数允许以换行分隔（流式输出常见）。
    while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    if (this.position >= this.source.length) {
      this.supported = false;
      return "";
    }
    if (this.source[this.position] === "{") {
      this.position++;
      return this.parseSequence("}");
    }
    if (this.source[this.position] === "\\") return this.parseCommand();
    const value = this.source[this.position] ?? "";
    this.position++;
    return value;
  }

  parseOptionalArgument() {
    while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    if (this.source[this.position] !== "[") return undefined;
    const end = this.source.indexOf("]", this.position + 1);
    if (end < 0) {
      this.supported = false;
      return undefined;
    }
    const value = this.source.slice(this.position + 1, end);
    this.position = end + 1;
    return this.renderNested(value);
  }

  /** 读取未解析的原始 `{...}`（用于 \begin{env} 的环境名）。 */
  readRawGroup() {
    while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    if (this.source[this.position] !== "{") {
      this.supported = false;
      return undefined;
    }

    const start = ++this.position;
    let depth = 1;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (character === "\\") {
        this.position += 2;
        continue;
      }
      if (character === "{") depth++;
      if (character === "}") depth--;
      if (depth === 0) {
        const value = this.source.slice(start, this.position);
        this.position++;
        return value;
      }
      this.position++;
    }
    this.supported = false;
    return undefined;
  }

  /** 按 `\\`（含可选行距参数）拆分环境行。 */
  splitEnvironmentRows(body) {
    return body.split(/\\\\(?:\[[^\]\n]*\])?/);
  }

  parseEnvironment() {
    const environment = this.readRawGroup();
    if (!environment) return "";
    const endMarker = `\\end{${environment}}`;
    const end = this.source.indexOf(endMarker, this.position);
    if (end < 0) {
      this.supported = false;
      return "";
    }
    const body = this.source.slice(this.position, end);
    this.position = end + endMarker.length;

    if (environment === "equation" || environment === "equation*" || environment === "displaymath") {
      return this.renderNested(body).trim();
    }

    if (
      environment === "aligned" ||
      environment === "align" ||
      environment === "align*" ||
      environment === "alignedat" ||
      environment === "alignat" ||
      environment === "alignat*" ||
      environment === "gather" ||
      environment === "gathered" ||
      environment === "multline" ||
      environment === "multline*" ||
      environment === "split"
    ) {
      const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
      // alignedat 的首个 {n} 是列数参数，不是内容。
      const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
      return this.splitEnvironmentRows(alignedBody)
        .map((row) => {
          const cells = row.split("&");
          const source = alignedAt
            ? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
                cells.slice(index * 2, index * 2 + 2).join("")
              ).join(" ")
            : cells.join("");
          return this.renderNested(source).trim();
        })
        .filter(Boolean)
        .join("\n");
    }

    if (environment === "cases" || environment === "cases*") {
      const rows = this.splitEnvironmentRows(body)
        .map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
        .filter((row) => row.some(Boolean));
      return rows
        .map((row, index) => {
          const value = (row[0] ?? "").replace(/,\s*$/, "");
          const condition = row[1] ?? "";
          const delimiter = index === 0 ? "⎧" : index === rows.length - 1 ? "⎩" : "⎨";
          // 条件本身已带 if/when 之类的引导词时不再补 "if"。
          const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
          return `${delimiter} ${value}${condition ? `${conditionPrefix}${condition}` : ""}`;
        })
        .join("\n");
    }

    if (
      ["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(
        environment
      )
    ) {
      const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
      return this.renderMatrix(environment, matrixBody);
    }

    this.supported = false;
    return body;
  }

  renderMatrix(environment, body) {
    const matrix = this.splitEnvironmentRows(body)
      .map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
      .filter((row) => row.some(Boolean));
    const columnCount = Math.max(0, ...matrix.map((row) => row.length));
    const columnWidths = Array.from({ length: columnCount }, (_, column) =>
      Math.max(0, ...matrix.map((row) => stringWidth(row[column] ?? "")))
    );
    const rows = matrix.map((row) =>
      Array.from({ length: columnCount }, (_, column) => {
        const cell = row[column] ?? "";
        return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - stringWidth(cell)))}`;
      }).join(" │ ")
    );

    let lines;
    if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
      lines = rows;
    } else {
      const delimiters = {
        pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
        bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
        Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
        vmatrix: ["│", "│", "│", "│", "│", "│"],
        Vmatrix: ["║", "║", "║", "║", "║", "║"],
      };
      const delimiter = delimiters[environment];
      if (!delimiter) {
        this.supported = false;
        return rows.join("\n");
      }
      lines = rows.map((row, index) => {
        const left = index === 0 ? delimiter[0] : index === rows.length - 1 ? delimiter[4] : delimiter[2];
        const right = index === 0 ? delimiter[1] : index === rows.length - 1 ? delimiter[5] : delimiter[3];
        return `${left} ${row} ${right}`;
      });
    }

    if (lines.length <= 1) return lines[0] ?? "";
    const index = this.layoutNodes.push({ type: "matrix", lines, baseline: 0 }) - 1;
    return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
  }

  /** 用同一份 layoutNodes 解析子表达式，失败时向上传播不支持状态。 */
  renderNested(source, stackFractions = true) {
    const rendered = new LatexParser(source, this.layoutNodes, this.display && stackFractions).render();
    if (rendered === undefined) {
      this.supported = false;
      return source;
    }
    return rendered;
  }
}

/**
 * 把基础 LaTeX 数学表达式渲染为终端友好的 Unicode 文本。
 * `options.display` 为 true 时允许纵向排版（块级公式）。
 * 表达式含不支持或残缺语法时返回 undefined，调用方应回退原文。
 */
export function renderLatex(source, options = {}) {
  const layoutNodes = [];
  const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
  if (rendered === undefined) return undefined;
  if (layoutNodes.length === 0) return rendered.replaceAll(PROTECTED_SPACE, " ");

  const lines = renderLayout(rendered, layoutNodes).lines;
  // 纵向排版可能整体缩进，去掉公共前导空格让公式贴左。
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length)
  );
  return lines
    .map((line) => line.slice(indentation).trimEnd())
    .join("\n")
    .trimEnd()
    .replaceAll(PROTECTED_SPACE, " ");
}
