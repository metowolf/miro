import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MiroCredentialStore } from "./credential-store.js";

test("credential store isolates providers and serializes concurrent modifications", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miro-auth-test-"));
  const store = new MiroCredentialStore(path.join(dir, "auth.json"));
  await Promise.all([
    store.modify("openai-codex", async () => ({ type: "oauth", access: "one", refresh: "r1", expires: 1 })),
    store.modify("openai-codex", async (current) => ({ ...current, access: `${current.access}-two` })),
    store.modify("anthropic", async () => ({ type: "oauth", access: "three", refresh: "r3", expires: 3 })),
  ]);

  assert.equal((await store.read("openai-codex")).access, "one-two");
  assert.equal((await store.read("anthropic")).access, "three");
  assert.deepEqual(await store.list(), [
    { providerId: "openai-codex", type: "oauth" },
    { providerId: "anthropic", type: "oauth" },
  ]);
  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
});

test("credential store treats malformed files as empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miro-auth-test-"));
  const file = path.join(dir, "auth.json");
  await writeFile(file, "not json");
  const store = new MiroCredentialStore(file);
  assert.equal(await store.read("openai-codex"), undefined);
});
