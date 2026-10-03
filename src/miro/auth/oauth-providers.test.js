import assert from "node:assert/strict";
import test from "node:test";

import { oauthCatalogForCredentialIds } from "./oauth-providers.js";

test("oauthCatalogForCredentialIds writes provider/id keys and skips unsigned-in providers", () => {
  const models = {
    getModels: () => [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      },
      {
        id: "claude-opus",
        name: "Opus",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
    ],
  };

  const catalog = oauthCatalogForCredentialIds(models, ["openai-codex"]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].key, "openai-codex/gpt-5.6-luna");
  assert.equal(catalog[0].id, "gpt-5.6-luna");
  assert.equal(catalog[0].oauth, true);
  assert.deepEqual(oauthCatalogForCredentialIds(models, []), []);
});
