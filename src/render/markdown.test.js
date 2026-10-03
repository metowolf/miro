import assert from "node:assert/strict";
import test from "node:test";

import chalk from "chalk";

import {
  configureMarked,
  formatToken,
  hasMarkdownSyntax,
  renderMarkdown,
} from "./markdown.js";

// bun test 无 TTY，chalk 会自动禁色；强制开启以便断言 ANSI 样式。
// FORCE_COLOR 要在 markdown.js 首次上色之前生效，两边共享同一个 chalk 单例。
process.env.FORCE_COLOR = "3";
chalk.level = 3;

const ANSI_PATTERN = /\u001B\[[0-9;]*m|\u001B\]8;;[^\u0007]*\u0007/g;
const strip = (text) => text.replace(ANSI_PATTERN, "");

test("renderMarkdown styles bold and inline code", () => {
  const out = renderMarkdown("**bold** and `code`");
  assert.match(out, /\u001B\[1mbold\u001B\[22m/);
  assert.match(out, /\u001B\[36mcode\u001B\[39m/);
  assert.equal(strip(out), "bold and code");
});

test("renderMarkdown keeps plain text untouched (fast path)", () => {
  assert.equal(hasMarkdownSyntax("just words"), false);
  assert.equal(renderMarkdown("just words"), "just words");
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("   "), "   ");
});

test("headings are bold and h1 is underlined", () => {
  const h1 = renderMarkdown("# Title");
  assert.match(h1, /\u001B\[1m/);
  assert.match(h1, /\u001B\[4m/);
  const h2 = renderMarkdown("## Sub");
  assert.match(h2, /\u001B\[1m/);
  assert.doesNotMatch(h2, /\u001B\[4m/);
});

test("lists render markers with indentation", () => {
  const out = strip(renderMarkdown("- a\n- b\n  - c"));
  assert.deepEqual(out.split("\n"), ["- a", "- b", "  - c"]);
  const ordered = strip(renderMarkdown("3. x\n4. y"));
  assert.deepEqual(ordered.split("\n"), ["3. x", "4. y"]);
});

test("blockquote lines get a bar prefix", () => {
  const out = strip(renderMarkdown("> quoted"));
  assert.equal(out, "│ quoted");
});

test("strikethrough is disabled so ~100 stays literal", () => {
  const out = renderMarkdown("costs ~100 or so");
  assert.equal(strip(out), "costs ~100 or so");
});

test("mailto links render as plain email text", () => {
  const out = strip(renderMarkdown("mail [me](mailto:a@b.c) now"));
  assert.equal(out, "mail a@b.c now");
});

test("links without hyperlink support fall back to text (url)", () => {
  const out = strip(renderMarkdown("[docs](https://example.com)"));
  assert.ok(out === "docs (https://example.com)" || out === "docs", `unexpected: ${out}`);
});

test("code blocks render as raw text without any ANSI", () => {
  const out = renderMarkdown("```js\nconst a = 1;\n```");
  assert.equal(strip(out), "const a = 1;");
  assert.equal(out, "const a = 1;");
});

test("code fence language never changes the rendered text", () => {
  const tagged = renderMarkdown("```notalang\nhello world\n```");
  const bare = renderMarkdown("```\nhello world\n```");
  assert.equal(tagged, bare);
  assert.equal(strip(tagged), "hello world");
});

test("unclosed code fence does not throw", () => {
  const out = renderMarkdown("```js\nconst a = 1;");
  assert.equal(strip(out), "const a = 1;");
});

test("tables render with aligned columns and preserve inline styles", () => {
  configureMarked();
  const table = [
    "| Name | Value | Notes |",
    "| :--- | ---: | :---: |",
    "| **one** | 2 | `ok` |",
    "| longer | 10 | yes |",
  ].join("\n");
  const out = strip(renderMarkdown(table));
  assert.equal(
    out,
    [
      "┌────────┬───────┬───────┐",
      "│  Name  │ Value │ Notes │",
      "├────────┼───────┼───────┤",
      "│ one    │     2 │  ok   │",
      "├────────┼───────┼───────┤",
      "│ longer │    10 │  yes  │",
      "└────────┴───────┴───────┘",
    ].join("\n")
  );
  assert.match(renderMarkdown(table), /\u001B\[1mone\u001B\[22m/);
});

test("tables calculate width using terminal cells for CJK text", () => {
  const table = "| 名称 | 值 |\n|---|---|\n| 中文 | 1 |";
  const out = strip(renderMarkdown(table));
  assert.equal(out, "┌──────┬─────┐\n│ 名称 │ 值  │\n├──────┼─────┤\n│ 中文 │ 1   │\n└──────┴─────┘");
});

test("table rows with missing cells stay rectangular", () => {
  const table = "| a | b |\n|---|---|\n| only-a |";
  const out = strip(renderMarkdown(table));
  assert.equal(out, "┌────────┬─────┐\n│   a    │  b  │\n├────────┼─────┤\n│ only-a │     │\n└────────┴─────┘");
});

test("very narrow tables fall back to readable key-value rows", () => {
  const previousColumns = process.stdout.columns;
  let out;
  process.stdout.columns = 20;
  try {
    const table = "| Name | Value |\n|---|---|\n| alpha | a long value that cannot fit |";
    out = strip(renderMarkdown(table));
  } finally {
    process.stdout.columns = previousColumns;
  }
  assert.equal(out, "Name: alpha\nValue: a long \n  value that \n  cannot fit");
});

test("unknown tokens still fall back to their raw source", () => {
  configureMarked();
  assert.equal(formatToken({ type: "custom", raw: "raw token" }), "raw token");
});

test("formatToken returns empty string for html tokens", () => {
  assert.equal(formatToken({ type: "html", raw: "<b>x</b>", text: "<b>x</b>" }), "");
});

test("inline latex renders as unicode math", () => {
  assert.equal(strip(renderMarkdown("质能方程 $E = mc^2$ 很有名")), "质能方程 E = mc² 很有名");
  // 不用 String.raw，否则中文会被转义成 \uXXXX 字面量。
  assert.equal(strip(renderMarkdown("当 \\(x \\in \\mathbb{R}\\) 时")), "当 x ∈ ℝ 时");
});

test("block latex renders with vertical layout", () => {
  const out = strip(renderMarkdown("$$\n\\frac{a}{b}\n$$"));
  assert.deepEqual(out.split("\n"), ["a", "─", "b"]);
});

test("unsupported latex falls back to the raw source", () => {
  const source = "看 $x + \\unknown{y}$ 这里";
  assert.equal(strip(renderMarkdown(source)), source);
});

test("dollar amounts are not treated as math", () => {
  assert.equal(strip(renderMarkdown("成本 $100 和 $200 之间")), "成本 $100 和 $200 之间");
});

test("latex inside code spans and fences stays literal", () => {
  assert.equal(strip(renderMarkdown("`$x^2$`")), "$x^2$");
  assert.equal(strip(renderMarkdown("```\n$x^2$\n```")), "$x^2$");
});

test("streaming unclosed latex is shown raw until it closes", () => {
  // 未闭合片段保持原文，避免公式在流式输出中闪烁重排。
  const pending = "结果是 $\\frac{1}{2";
  assert.equal(strip(renderMarkdown(pending)), pending);
  assert.equal(strip(renderMarkdown("结果是 $\\frac{1}{2}$")), "结果是 1/2");
});
