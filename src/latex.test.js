import assert from "node:assert/strict";
import test from "node:test";

import { renderLatex } from "./latex.js";

// 行内模式：压成单行，分式退化为 a/b。

test("renders greek letters and common symbols", () => {
  assert.equal(renderLatex(String.raw`\alpha + \beta = \gamma`), "α + β = γ");
  assert.equal(renderLatex(String.raw`x \in \mathbb{R}`), "x ∈ ℝ");
  assert.equal(renderLatex(String.raw`\pi\cdot\frac{1}{\pi}`), "π · 1/π");
  assert.equal(renderLatex(String.raw`\infty \neq 0`), "∞ ≠ 0");
});

test("renders sub and superscripts as unicode when possible", () => {
  assert.equal(renderLatex("x^2"), "x²");
  assert.equal(renderLatex("x_i"), "xᵢ");
  assert.equal(renderLatex("x_{i=0}"), "xᵢ₌₀");
  // 无对应 Unicode 字形时退化为 ^(...) 形式。
  assert.equal(renderLatex("x^{QQ}"), "x^(QQ)");
});

test("renders roots, fractions and binomials inline", () => {
  assert.equal(renderLatex(String.raw`\sqrt{2}`), "√2");
  assert.equal(renderLatex(String.raw`\sqrt[3]{x}`), "∛x");
  assert.equal(renderLatex(String.raw`\frac{x^2+1}{x-1}`), "(x²+1)/(x-1)");
  assert.equal(renderLatex(String.raw`\tfrac{1}{2}`), "1/2");
  assert.equal(renderLatex(String.raw`\binom{n}{k}`), "(n choose k)");
});

test("named operators get context-aware spacing", () => {
  assert.equal(renderLatex(String.raw`\sin\theta`), "sin θ");
  assert.equal(renderLatex(String.raw`\sin^2 x`), "sin² x");
  assert.equal(renderLatex(String.raw`-\sin\theta`), "-sin θ");
  assert.equal(renderLatex(String.raw`i\sin\theta`), "i sin θ");
  assert.equal(renderLatex(String.raw`\det(A)`), "det(A)");
});

test("negations prefer precomposed glyphs", () => {
  assert.equal(renderLatex(String.raw`A\not\subseteq B,\quad x\not\in X`), "A ⊈ B, x ∉ X");
});

test("renders relational algebra join operators", () => {
  assert.equal(renderLatex(String.raw`R\bowtie S,\quad R\Join S`), "R ⋈ S, R ⋈ S");
  assert.equal(renderLatex(String.raw`R\ltimes S,\quad R\rtimes S`), "R ⋉ S, R ⋊ S");
  assert.equal(
    renderLatex(String.raw`R\leftouterjoin S,\quad R\rightouterjoin S,\quad R\fullouterjoin S`),
    "R ⟕ S, R ⟖ S, R ⟗ S",
  );
});

test("modular arithmetic and text wrappers", () => {
  assert.equal(renderLatex(String.raw`a\bmod n,\quad a\equiv b\pmod n`), "a mod n, a ≡ b (mod n)");
  assert.equal(renderLatex(String.raw`\text{hello}+\mbox{world}`), "hello+world");
});

test("collapses spacing commands and control-space line breaks", () => {
  assert.equal(renderLatex(String.raw`a\,b\;c\quad d`), "a b c d");
  // 反斜杠后紧跟换行是被折行切断的控制空格。
  assert.equal(renderLatex("a\\\r\nb"), "a b");
});

test("cases environment renders with brace delimiters", () => {
  assert.equal(
    renderLatex(String.raw`\begin{cases}a & x<0 \\ b & x=0 \\ c & x>0\end{cases}`),
    ["⎧ a if x < 0", "⎨ b if x = 0", "⎩ c if x > 0"].join("\n")
  );
});

test("aligned environment renders one line per row", () => {
  assert.equal(
    renderLatex(String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`),
    ["a = b", "c = d"].join("\n")
  );
});

test("pmatrix renders with stacked bracket delimiters", () => {
  assert.equal(
    renderLatex(String.raw`\begin{pmatrix}1&200\\3000&4\end{pmatrix}`),
    ["⎛ 1    │ 200 ⎞", "⎝ 3000 │ 4   ⎠"].join("\n")
  );
});

// display 模式：允许纵向排版。

test("display mode stacks fractions vertically", () => {
  assert.equal(renderLatex(String.raw`\frac{x^2+1}{x-1}`, { display: true }), "x²+1\n────\nx-1");
  assert.equal(renderLatex("\\frac{1}\n{2}", { display: true }), "1\n─\n2");
});

test("display mode places operator limits above and below", () => {
  assert.equal(renderLatex(String.raw`\sum_{i=0}^n x_i`, { display: true }), " n\n ∑  xᵢ\ni=0");
  assert.equal(renderLatex(String.raw`\min_{x\in X} f(x)`, { display: true }), "min f(x)\nx∈X");
  assert.equal(renderLatex(String.raw`\int\nolimits_0^1 f(x)\,dx`, { display: true }), "∫₀¹ f(x) dx");
});

test("fractions nested in scripts stay inline even in display mode", () => {
  assert.equal(renderLatex(String.raw`e^{\frac{1}{2}}`, { display: true }), "e^(1/2)");
});

test("returns undefined for unsupported or malformed input", () => {
  assert.equal(renderLatex(String.raw`x + \unknown{y}`), undefined);
  assert.equal(renderLatex(String.raw`\frac{1}`), undefined);
  assert.equal(renderLatex("x}"), undefined);
  assert.equal(renderLatex(String.raw`\begin{matrix}1&2`), undefined);
});
