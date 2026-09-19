/** pi-ai 内置、可直接由 miro 登录的静态 OAuth provider。 */
import { createModels } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

import { catalogKey } from "./models-file.js";

// pi-ai 默认通过 bundler 无法追踪的动态 import 加载 OAuth 实现；独立 Bun
// 二进制里没有旁路文件，必须改用它提供的静态 loader 才能把流程嵌进产物。
registerBunOAuthFlows();

export const OAUTH_PROVIDERS = Object.freeze([
  { id: "openai-codex", name: "ChatGPT / Codex", description: "ChatGPT Plus / Pro" },
  { id: "anthropic", name: "Claude", description: "Claude Pro / Max" },
  { id: "github-copilot", name: "GitHub Copilot", description: "GitHub subscription" },
  { id: "openrouter", name: "OpenRouter", description: "OpenRouter OAuth" },
  { id: "kimi-coding", name: "Kimi Coding", description: "Kimi subscription" },
  { id: "xai", name: "xAI", description: "SuperGrok / X Premium" },
]);

const factories = [anthropicProvider, githubCopilotProvider, kimiCodingProvider, openaiCodexProvider, openrouterProvider, xaiProvider];

export function createOAuthModels(credentials) {
  const models = createModels({ credentials });
  for (const factory of factories) models.setProvider(factory());
  return models;
}

function catalogEntryFromOAuthModel(model) {
  return {
    id: model.id,
    key: catalogKey(model.provider, model.id),
    name: model.name ?? model.id,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning === true,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    samplingParams: model.samplingParams ?? null,
    compat: model.compat ?? null,
    cost: model.cost ?? null,
    fromCatalog: true,
    oauth: true,
  };
}

export function oauthCatalogForCredentialIds(models, credentialIds = []) {
  const enabled = new Set(credentialIds);
  return models.getModels().filter((model) => enabled.has(model.provider)).map(catalogEntryFromOAuthModel);
}

/** 只在已认证时注入 picker，避免把没有凭据的订阅模型伪装为可用。 */
export async function oauthCatalog(models) {
  return (await models.getAvailable()).map(catalogEntryFromOAuthModel);
}
