import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpOAuthProvider, loginMcp, logoutMcp } from "./mcp-oauth.ts";

test("MCP OAuth credentials are isolated by URL, kept private, and removed on logout", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "miro-oauth-")), "auth.json");
  const first = { url: "https://first.example/mcp", oauth: { clientId: "client", callbackPort: 8766 } };
  const second = { url: "https://second.example/mcp" };
  const one = new McpOAuthProvider(first, { file });
  const two = new McpOAuthProvider(second, { file });
  assert.equal(one.redirectUrl, "http://127.0.0.1:8766/callback");
  assert.equal(one.clientInformation().client_id, "client");
  one.saveTokens({ access_token: "first-token", token_type: "Bearer" });
  two.saveTokens({ access_token: "second-token", token_type: "Bearer" });
  assert.equal(two.tokens().access_token, "second-token");
  assert.equal(statSync(file).mode & 0o077, 0);
  logoutMcp(first, file);
  assert.equal(one.tokens(), undefined);
  assert.equal(two.tokens().access_token, "second-token");
});

test("MCP OAuth completes discovery, registration and browser callback", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "miro-oauth-flow-")), "auth.json");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin;
    const json = (value) => Response.json(value);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/register") return json({ ...(await request.json()), client_id: "miro-test" });
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", "test-code");
      redirect.searchParams.set("state", url.searchParams.get("state"));
      return Response.redirect(redirect.href, 302);
    }
    if (url.pathname === "/token") return json({ access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 3600 });
    return new Response("Not found", { status: 404 });
  } });
  const config = { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: {}, oauth: { callbackPort: server.port + 1 } };
  let opened = 0;
  try {
    await loginMcp(config, { file, print: () => {}, open: (url) => { opened += 1; void fetch(url); } });
    assert.equal(opened, 1);
    assert.equal(new McpOAuthProvider(config, { file }).tokens().access_token, "test-access");
  } finally { await server.stop(true); }
});

async function cancellableOAuth(t, stallPath = null) {
  const directory = mkdtempSync(path.join(tmpdir(), "miro-oauth-cancel-"));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (url.pathname === stallPath) {
      entered.resolve();
      await release.promise;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: url.origin, authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`, registration_endpoint: `${url.origin}/register`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/register") return Response.json({ ...(await request.json()), client_id: "cancel-test" });
    if (url.pathname === "/token") return Response.json({ access_token: "late-token", token_type: "Bearer" });
    return new Response("Not found", { status: 404 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const callbackPort = reservation.port;
  await reservation.stop(true);
  const controller = new AbortController();
  const config = { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, oauth: { callbackPort } };
  const options = { file: path.join(directory, "auth.json"), signal: controller.signal, timeoutMs: 2000,
    print: () => {}, open: () => {} };
  t.after(async () => {
    controller.abort();
    release.resolve();
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });
  const assertCallbackClosed = async () => {
    const replacement = Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response() });
    await replacement.stop(true);
  };
  const completeBrowser = (authorizationUrl) => {
    const url = new URL(authorizationUrl);
    const redirect = new URL(url.searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", "test-code");
    redirect.searchParams.set("state", url.searchParams.get("state"));
    return fetch(redirect).then((response) => response.text());
  };
  return { config, options, controller, entered, release, requests, assertCallbackClosed, completeBrowser };
}

for (const stage of ["/mcp", "/.well-known/oauth-protected-resource/mcp", "/register", "/token"]) {
  test(`MCP OAuth 在 ${stage} 阶段取消会关闭回调且不写入迟到的凭据`, async (t) => {
    const flow = await cancellableOAuth(t, stage);
    let browser;
    const login = loginMcp(flow.config, { ...flow.options,
      open: (url) => { browser = flow.completeBrowser(url); },
    });
    const rejected = assert.rejects(login, { name: "AbortError" });
    await Promise.race([flow.entered.promise, login]);
    assert.equal((await fetch(`http://127.0.0.1:${flow.config.oauth.callbackPort}/probe`)).status, 404);
    flow.controller.abort();
    await rejected;
    await flow.assertCallbackClosed();
    flow.release.resolve();
    await browser;
    assert.equal(new McpOAuthProvider(flow.config, { file: flow.options.file }).tokens(), undefined);
  });
}

test("MCP OAuth 等待浏览器时取消会释放端口并允许再次登录", async (t) => {
  const flow = await cancellableOAuth(t);
  const opened = Promise.withResolvers();
  const login = loginMcp(flow.config, { ...flow.options, open: () => opened.resolve() });
  const rejected = assert.rejects(login, { name: "AbortError" });
  await Promise.race([opened.promise, login]);
  flow.controller.abort();
  await rejected;
  await flow.assertCallbackClosed();
  assert.equal(flow.requests.includes("/token"), false);
  let browser;
  await loginMcp(flow.config, { ...flow.options, signal: undefined,
    open: (url) => { browser = flow.completeBrowser(url); },
  });
  await browser;
  assert.equal(new McpOAuthProvider(flow.config, { file: flow.options.file }).tokens().access_token, "late-token");
  await flow.assertCallbackClosed();
});

test("MCP OAuth 已取消的登录不发请求也不打开浏览器", async (t) => {
  const flow = await cancellableOAuth(t);
  flow.controller.abort();
  await assert.rejects(loginMcp(flow.config, { ...flow.options, open: () => assert.fail("不应打开浏览器") }), { name: "AbortError" });
  assert.deepEqual(flow.requests, []);
  await flow.assertCallbackClosed();
});

test("MCP OAuth 发现阶段也受总超时限制并释放回调端口", async (t) => {
  const flow = await cancellableOAuth(t, "/.well-known/oauth-protected-resource/mcp");
  await assert.rejects(loginMcp(flow.config, { ...flow.options, timeoutMs: 50 }), /sign-in timed out/);
  await flow.assertCallbackClosed();
});

test("MCP OAuth 取消后不再修改凭据或发送重定向", async (t) => {
  const flow = await cancellableOAuth(t);
  const provider = new McpOAuthProvider(flow.config, { file: flow.options.file, signal: flow.controller.signal,
    onRedirect: () => assert.fail("不应重定向"),
  });
  provider.saveTokens({ access_token: "original", token_type: "Bearer" });
  flow.controller.abort();
  assert.throws(() => provider.saveTokens({ access_token: "late" }), { name: "AbortError" });
  assert.throws(() => provider.invalidateCredentials("all"), { name: "AbortError" });
  assert.throws(() => provider.redirectToAuthorization(new URL("https://example.com")), { name: "AbortError" });
  assert.equal(new McpOAuthProvider(flow.config, { file: flow.options.file }).tokens().access_token, "original");
});