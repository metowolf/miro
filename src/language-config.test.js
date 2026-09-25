import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_IDS,
  languageDisplayName,
  normalizeLanguage,
} from "./prompts/language.js";
import { initPrompts, promptBundle, reviewPrompts } from "./prompts/index.js";
import { buildInitPrompt, initPromptFor, INIT_PROMPT } from "./prompts.js";
import { buildReviewRequest, reviewPrompt, reviewRubricFor, REVIEW_RUBRIC } from "./review.js";
import {
  isLanguageOption,
  languageConfigOption,
  LANGUAGE_OPTION_ID,
  withLanguageOption,
} from "./language-config.js";
import { configChoices } from "./acp/model.js";
import { matchConfigChoice, matchConfigOption, isConfigOptionLocked } from "./acp/config-options.js";

const CWD = process.cwd();

test("ships English, Chinese and Cantonese with English as the default", () => {
  assert.deepEqual(LANGUAGE_IDS, ["english", "chinese", "cantonese"]);
  assert.deepEqual(
    LANGUAGES.map((item) => item.name),
    ["English", "Chinese", "Cantonese"]
  );
  assert.equal(DEFAULT_LANGUAGE, "english");
});

test("language normalization accepts aliases and falls back to the default on invalid values", () => {
  assert.equal(normalizeLanguage("Chinese"), "chinese");
  assert.equal(normalizeLanguage(" ZH-CN "), "chinese");
  assert.equal(normalizeLanguage("中文"), "chinese");
  assert.equal(normalizeLanguage("en"), "english");
  assert.equal(normalizeLanguage("Cantonese"), "cantonese");
  assert.equal(normalizeLanguage(" YUE "), "cantonese");
  assert.equal(normalizeLanguage("zh-HK"), "cantonese");
  assert.equal(normalizeLanguage("粤语"), "cantonese");
  assert.equal(normalizeLanguage("粵語"), "cantonese");
  for (const bad of [undefined, null, "", "   ", "klingon", 42, {}, []]) {
    assert.equal(normalizeLanguage(bad), DEFAULT_LANGUAGE, `${String(bad)} should fall back to the default language`);
  }
});

test("languageDisplayName provides display names for UI labels", () => {
  assert.equal(languageDisplayName("chinese"), "Chinese");
  assert.equal(languageDisplayName("cantonese"), "Cantonese");
  assert.equal(languageDisplayName("nope"), "English");
});

test("every language prompt bundle exports the same keys", () => {
  for (const id of LANGUAGE_IDS) {
    const bundle = promptBundle(id);
    assert.ok(bundle.init.INIT_PROMPT.length > 0, `${id} is missing INIT_PROMPT`);
    assert.ok(bundle.init.INIT_EXTRA_HEADING.length > 0, `${id} is missing INIT_EXTRA_HEADING`);
    assert.ok(bundle.review.REVIEW_RUBRIC.length > 0, `${id} is missing REVIEW_RUBRIC`);
    assert.ok(bundle.review.UNCOMMITTED_PROMPT.length > 0, `${id} is missing UNCOMMITTED_PROMPT`);
    assert.equal(typeof bundle.review.baseBranchPrompt, "function");
    assert.equal(typeof bundle.review.commitPrompt, "function");
  }
});

test("an invalid language falls back to the default bundle instead of throwing", () => {
  assert.equal(initPrompts("klingon").INIT_PROMPT, initPrompts("english").INIT_PROMPT);
  assert.equal(reviewPrompts(undefined).REVIEW_RUBRIC, reviewPrompts("english").REVIEW_RUBRIC);
});

test("the default /init and review exports are the English originals", () => {
  assert.match(INIT_PROMPT, /Please analyze this codebase/);
  assert.match(REVIEW_RUBRIC, /\*\*Verdict:\*\* patch is correct/);
});

test("buildInitPrompt picks the base prompt by language and appends user instructions", () => {
  const zh = buildInitPrompt("", "chinese");
  assert.equal(zh, initPromptFor("chinese"));
  assert.notEqual(zh, INIT_PROMPT);
  assert.match(zh, /AGENTS\.md/);

  const withArgs = buildInitPrompt("只看 ACP 层", "chinese");
  assert.ok(withArgs.startsWith(zh), "the full Chinese base prompt should be kept");
  assert.ok(withArgs.includes("只看 ACP 层"));
  assert.ok(withArgs.indexOf("只看 ACP 层") > zh.length - 1, "the extra instruction should come after the base prompt");
});

test("Chinese review prompts switch with the language but keep the output skeleton", () => {
  const rubric = reviewRubricFor("chinese");
  assert.notEqual(rubric, REVIEW_RUBRIC);
  // 输出骨架必须与英文版一致，渲染与既有约定才不会漂移。
  assert.match(rubric, /\*\*Verdict:\*\* patch is correct/);
  assert.match(rubric, /## Findings/);
  assert.match(rubric, /No findings\./);
  assert.match(rubric, /\[P0\]/);

  const request = buildReviewRequest("请审查当前改动。", "chinese");
  assert.ok(request.startsWith(rubric));
  assert.match(request, /请审查当前改动。$/);
});

test("Cantonese review prompts switch with the language but keep the output skeleton", () => {
  const rubric = reviewRubricFor("cantonese");
  assert.notEqual(rubric, REVIEW_RUBRIC);
  assert.notEqual(rubric, reviewRubricFor("chinese"));
  // 输出骨架必须与英文版一致，渲染与既有约定才不会漂移。
  assert.match(rubric, /\*\*Verdict:\*\* patch is correct/);
  assert.match(rubric, /## Findings/);
  assert.match(rubric, /No findings\./);
  assert.match(rubric, /\[P0\]/);
});

test("reviewPrompt follows the language for every target kind", async () => {
  const zhUncommitted = await reviewPrompt({ kind: "uncommitted" }, CWD, "chinese");
  assert.equal(zhUncommitted, reviewPrompts("chinese").UNCOMMITTED_PROMPT);
  assert.doesNotMatch(zhUncommitted, /staged, unstaged, and untracked/);

  const zhCommit = await reviewPrompt({ kind: "commit", sha: "abc1234", title: "修复解析" }, CWD, "chinese");
  assert.match(zhCommit, /abc1234/);
  assert.match(zhCommit, /修复解析/);

  // custom 是用户原话，任何语言下都原样透传。
  assert.equal(await reviewPrompt({ kind: "custom", instructions: " check locks " }, CWD, "chinese"), "check locks");
});

test("language is synthesized as a switchable option shaped like an ACP select", () => {
  const option = languageConfigOption("chinese");
  assert.equal(option.id, LANGUAGE_OPTION_ID);
  assert.equal(option.type, "select");
  assert.equal(option.currentValue, "chinese");
  assert.equal(isLanguageOption(option), true);
  assert.equal(isLanguageOption({ id: "model" }), false);

  const choices = configChoices(option);
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["english", "chinese", "cantonese"]
  );
  // 多于一项，因此面板上可切换而不是置灰。
  assert.equal(isConfigOptionLocked(option), false);
  assert.equal(choices.find((choice) => choice.current)?.value, "chinese");
});

test("an invalid stored language shows the default value in the option", () => {
  assert.equal(languageConfigOption("klingon").currentValue, "english");
});

test("withLanguageOption appends at the end and does not override a provider option with the same id", () => {
  const acp = [{ id: "model", type: "select", options: [{ value: "m1" }] }];
  const merged = withLanguageOption(acp, "english");
  assert.deepEqual(
    merged.map((option) => option.id),
    ["model", "language"]
  );
  // 原数组不被修改。
  assert.equal(acp.length, 1);

  const provided = [{ id: "language", type: "select", options: [{ value: "x" }] }];
  assert.equal(withLanguageOption(provided, "chinese"), provided);

  // 没有 ACP 选项时也至少有 language 可用。
  assert.deepEqual(
    withLanguageOption(null, "english").map((option) => option.id),
    ["language"]
  );
});

test("/config language <value> matches by id and display name", () => {
  const options = withLanguageOption([], "english");
  const option = matchConfigOption(options, "language");
  assert.ok(option);
  assert.equal(matchConfigChoice(option, "Chinese")?.value, "chinese");
  assert.equal(matchConfigChoice(option, "chinese")?.value, "chinese");
  assert.equal(matchConfigChoice(option, "Cantonese")?.value, "cantonese");
  assert.equal(matchConfigChoice(option, "klingon"), null);
});

test("/config still works and offers only language when the provider reports no configOptions", () => {
  // App.jsx 因此移除了「无 ACP 选项就拒开面板」的旧防护：合并后至少有一项，
  // 面板与 /config 参数匹配都必须能在这种会话里正常工作。
  for (const empty of [[], null, undefined]) {
    const merged = withLanguageOption(empty, "chinese");
    assert.deepEqual(
      merged.map((option) => option.id),
      ["language"]
    );
    const option = matchConfigOption(merged, "language");
    assert.ok(option, "language still matches with an empty ACP option list");
    assert.equal(isLanguageOption(option), true);
    assert.equal(isConfigOptionLocked(option), false);
    assert.equal(matchConfigChoice(option, "English")?.value, "english");
  }
});

test("the merged list appends the language option last with the session value", () => {
  const acp = [{ id: "model", type: "select", options: [{ value: "m1" }, { value: "m2" }] }];
  const merged = withLanguageOption(acp, "chinese");
  // language 始终在末尾，且当前值随会话内的选择走。
  assert.equal(merged.at(-1).id, "language");
  assert.equal(merged.at(-1).currentValue, "chinese");
});
