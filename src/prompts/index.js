/**
 * 内置提示词的多语言入口。
 *
 * 目录约定：src/prompts/<language>/{init,review,simplify,commit}.js
 * 每个语言目录导出同样的键，因此新增一门语言只需要建一个目录、
 * 在 language.js 的 LANGUAGES 里登记，再在这里挂上即可。
 *
 * 这里用静态 import 而非动态加载：编译版（bun build --compile）不能依赖
 * 运行时按路径读文件，所有语言必须在打包时就进入 bundle。
 */

import * as englishInit from "./english/init.js";
import * as englishReview from "./english/review.js";
import * as englishSimplify from "./english/simplify.js";
import * as englishCommit from "./english/commit.js";
import * as chineseInit from "./chinese/init.js";
import * as chineseReview from "./chinese/review.js";
import * as chineseSimplify from "./chinese/simplify.js";
import * as chineseCommit from "./chinese/commit.js";
import * as cantoneseInit from "./cantonese/init.js";
import * as cantoneseReview from "./cantonese/review.js";
import * as cantoneseSimplify from "./cantonese/simplify.js";
import * as cantoneseCommit from "./cantonese/commit.js";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "./language.js";

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
