/**
 * 内置提示词的多语言入口。
 *
 * 目录约定：src/commands/prompts/<language>/{init,review,simplify,commit}.js
 * 每个语言目录导出同样的键，因此新增一门语言只需要建一个目录、
 * 在 language.ts 的 LANGUAGES 里登记，再在这里挂上即可。
 *
 * 这里用静态 import 而非动态加载：编译版（bun build --compile）不能依赖
 * 运行时按路径读文件，所有语言必须在打包时就进入 bundle。
 */

import * as englishInit from "./english/init.ts";
import * as englishReview from "./english/review.ts";
import * as englishSimplify from "./english/simplify.ts";
import * as englishCommit from "./english/commit.ts";
import * as chineseInit from "./chinese/init.ts";
import * as chineseReview from "./chinese/review.ts";
import * as chineseSimplify from "./chinese/simplify.ts";
import * as chineseCommit from "./chinese/commit.ts";
import * as cantoneseInit from "./cantonese/init.ts";
import * as cantoneseReview from "./cantonese/review.ts";
import * as cantoneseSimplify from "./cantonese/simplify.ts";
import * as cantoneseCommit from "./cantonese/commit.ts";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "./language.ts";

const BUNDLES = {
  english: {
    init: englishInit,
    review: englishReview,
    simplify: englishSimplify,
    commit: englishCommit,
  },
  chinese: {
    init: chineseInit,
    review: chineseReview,
    simplify: chineseSimplify,
    commit: chineseCommit,
  },
  cantonese: {
    init: cantoneseInit,
    review: cantoneseReview,
    simplify: cantoneseSimplify,
    commit: cantoneseCommit,
  },
};

/** 取某语言的提示词包；语言不存在时回落到默认语言。 */
export function promptBundle(language) {
  const id = normalizeLanguage(language);
  return BUNDLES[id] ?? BUNDLES[DEFAULT_LANGUAGE];
}

export function initPrompts(language) {
  return promptBundle(language).init;
}

export function reviewPrompts(language) {
  return promptBundle(language).review;
}

export function simplifyPrompts(language) {
  return promptBundle(language).simplify;
}

export function commitPrompts(language) {
  return promptBundle(language).commit;
}
