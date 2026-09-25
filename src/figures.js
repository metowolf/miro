/** 终端字形常量：集中收口，避免各组件硬编码不同字符导致宽度与字形不一致。 */

// 启动头部的三行像素图，行首与行内空格都是图案的一部分。
export const MIRO_LOGO = "▝▖ ▗▟███▜▌▸\n  ▝██  ▄█▘\n    ▝▀▀▘";

// ⏺ (U+23FA) 垂直居中对齐更好，但 Windows/Linux 上通常缺字形，
// 会掉进 emoji 字体回退 —— 字号偏大、基线偏移、宽度还可能算成 2 列。
// 故非 macOS 一律降级为几何图形区的 ● (U+25CF)。
export const BLACK_CIRCLE = process.platform === "darwin" ? "\u23fa" : "\u25cf";

// 导出为纯文本时不随平台变化：同一份 transcript 在任何机器上导出结果都应一致。
export const BLACK_CIRCLE_PLAIN = "\u25cf";
export const TREE_LAST_PLAIN = "\u2514";

// 子行的树形标记。⎿ (U+23BF) 属于「杂项技术」区的电话/键盘制表零件，
// 多数等宽字体没有该字形，会掉进回退字体 —— 字重与基线都和相邻行对不上。
// 制表符区的 └ (U+2514) / ├ (U+251C) 是等宽字体的必备字形，宽度稳定为 1 列。
export const TREE_LAST = "\u2514";
export const TREE_MID = "\u251c";

// 同一条内容被折成多行时的续行标记。用 │ 而不是 └：后者宣称「最后一个子项」，
// 而折行出来的每一行都还是同一件事，下面通常还跟着输出行。
export const TREE_VERTICAL = "\u2502";

// 子行左栏固定 5 列：两格缩进 + 标记 + 空格，以及无标记时的纯缩进。
export const TREE_LAST_PREFIX = `  ${TREE_LAST} `;
export const TREE_MID_PREFIX = `  ${TREE_MID} `;
export const TREE_VERTICAL_PREFIX = `  ${TREE_VERTICAL} `;
export const TREE_BLANK_PREFIX = "    ";
