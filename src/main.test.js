// 入口的依赖面是启动速度的一部分：main.js 会先于一切被求值，任何静态 import
// 都要在 `--help` 这种本可以直接退出的路径上先付掉。这里把那条界线钉成测试，
// 免得以后顺手把重模块挪回入口。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.js"), "utf8");

/** 只允许入口静态依赖解析参数与打印帮助所需的最小集合。 */
const ALLOWED_STATIC_IMPORTS = new Set(["node:process", "./cli.js", "./config.js", "./utils.js"]);

function staticImports() {
  return [...source.matchAll(/^\s*import\s+(?:[^"'`]*?from\s+)?["']([^"']+)["']/gm)].map(
    (match) => match[1],
  );
}

function dynamicImports() {
  return [...source.matchAll(/await\s+import\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1],
  );
}

test("main.js only statically imports the minimal argument/help surface", () => {
  for (const specifier of staticImports()) {
    assert.ok(
      ALLOWED_STATIC_IMPORTS.has(specifier),
      `${specifier} must be a dynamic import: a static one is evaluated before --help can exit`,
    );
  }
});

test("main.js loads the two app entry points on demand", () => {
  const dynamic = dynamicImports();
  for (const specifier of ["./headless.js", "./tui.jsx"]) {
    assert.ok(dynamic.includes(specifier), `${specifier} should be reached through await import()`);
  }
});
