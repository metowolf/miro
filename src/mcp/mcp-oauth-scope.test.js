import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adaptOAuthProvider, authorizeMcp } from "@earendil-works/pi-mcp/oauth";
import { McpOAuthProvider, loginMcp, mcpOAuthFetch } from "./mcp-oauth.js";
import { McpRuntime } from "./mcp-runtime.js";

const gatewayScopes = ["openid", "profile", "offline", "offline_access"];

async function gateway(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "miro-oauth-scope-"));
  const requests = [];
  const registrations = [];
  const tokenRequests = [];
  let discovery;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    if (url.pathname === "/mcp") return new Response(null, { status: 401, headers: {
      "www-authenticate": `Bearer resource_metadata="${url.origin}/metadata?resource=${encodeURIComponent(`${url.origin}/mcp`)}"${options.challengeScope ? `, scope="${options.challengeScope}"` : ""}`,
    } });
    if (url.pathname === "/metadata" && url.searchParams.get("resource") === `${url.origin}/mcp`) {
      return Response.json(discovery.resourceMetadata);
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/oauth2") return Response.json(discovery.authorizationServerMetadata);
    if (url.pathname === "/register") {
      registrations.push(await request.json());
      return Response.json({ ...registrations.at(-1), client_id: "gateway-client" });
    }
    if (url.pathname === "/token") {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return Response.json(options.token ?? { access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", scope: "" },
        { status: options.tokenStatus ?? 200 });
    }
    return new Response("missing resource parameter", { status: 400 });
  } });
  const origin = server.url.origin;
  discovery = {
    authorizationServerUrl: `${origin}/oauth2`,
    authorizationServerMetadata: { issuer: `${origin}/oauth2`, authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] },
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [`${origin}/oauth2`],
      ...(options.resourceFields ?? { resource_scopes: gatewayScopes }) },
  };
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const callbackPort = reservation.port;
  await reservation.stop(true);
  t.after(async () => { await server.stop(true); rmSync(directory, { recursive: true, force: true }); });
  const config = { type: "http", url: `${origin}/mcp`, headers: {}, oauth: { callbackPort, ...options.oauth } };
  const file = path.join(directory, "auth.json");
  const provider = new McpOAuthProvider(config, { file });
  const messages = [];
  let authorization;
  let browser;
  const login = () => loginMcp(config, { file, timeoutMs: 2000, print: (text) => messages.push(text), open: (value) => {
    authorization = new URL(value);
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    if (options.callbackError) {
      callback.searchParams.set("error", options.callbackError);
      callback.searchParams.set("error_description", "secret-description");
    } else callback.searchParams.set("code", "test-code");
    browser = fetch(callback).then((response) => response.text()).catch(() => {});
  } }).finally(async () => { await browser; });
  return { config, file, provider, discovery, requests, registrations, tokenRequests, messages, login,
    authorization: () => authorization };
}

for (const cached of [false, true]) {
  test(`MCP OAuth ${cached ? "旧发现缓存" : "首次登录"}使用 401 地址与 resource_scopes，兼容空令牌 scope`, async (t) => {
    const flow = await gateway(t);
    if (cached) {
      flow.provider.saveDiscoveryState({ ...flow.discovery, authorizationServerUrl: "http://127.0.0.1:1/stale",
        authorizationServerMetadata: { ...flow.discovery.authorizationServerMetadata, authorization_endpoint: "http://127.0.0.1:1/wrong" } });
      flow.provider.saveClientInformation({ client_id: "existing-client", scope: gatewayScopes.join(" ") });
    }
    await flow.login();
    assert.equal(flow.authorization().searchParams.get("scope"), gatewayScopes.join(" "));
    assert.equal(flow.authorization().searchParams.get("prompt"), "consent");
    assert.equal(flow.authorization().origin, new URL(flow.config.url).origin);
    assert.ok(flow.requests.some((url) => url.startsWith("/metadata?resource=")));
    assert.equal(flow.requests.some((url) => url.includes("oauth-protected-resource")), false);
    assert.equal(flow.registrations.length, cached ? 0 : 1);
    if (!cached) assert.equal(flow.registrations[0].scope, gatewayScopes.join(" "));
    assert.equal(flow.provider.tokens().access_token, "test-access");
    assert.equal(flow.provider.tokens().scope, undefined);
    assert.equal(flow.tokenRequests.length, 1);
    assert.equal(flow.tokenRequests[0].resource, flow.config.url);
    assert.equal(flow.messages.at(-1), "MCP OAuth sign-in completed.");
  });
}

for (const [label, options, expected] of [
  ["标准资源字段优先", { resourceFields: { scopes_supported: ["standard"], resource_scopes: ["legacy"] } }, "standard"],
  ["挑战权限优先", { challengeScope: "challenge", resourceFields: { scopes_supported: ["standard"] } }, "challenge"],
  ["配置权限优先", { oauth: { scope: "explicit profile" }, challengeScope: "challenge", resourceFields: { scopes_supported: ["standard"] } }, "explicit profile"],
]) {
  test(`MCP OAuth scope ${label}`, async (t) => {
    const flow = await gateway(t, options);
    await flow.login();
    assert.equal(flow.authorization().searchParams.get("scope"), expected);
    assert.equal(flow.registrations[0].scope, expected);
  });
}

test("MCP OAuth 旧缓存可回退到已注册客户端 scope，且不发送网络请求", async (t) => {
  const flow = await gateway(t, { resourceFields: {} });
  flow.provider.saveDiscoveryState(flow.discovery);
  flow.provider.saveClientInformation({ client_id: "cached", scope: "registered" });
  let authorization;
  flow.provider.onRedirect = (value) => { authorization = new URL(value); };
  await authorizeMcp(flow.provider, { serverUrl: flow.config.url, fetch: () => assert.fail("不应发网络请求") });
  assert.equal(authorization.searchParams.get("scope"), "registered");
});

for (const status of [200, 400]) {
  test(`MCP OAuth 保留 HTTP ${status} 的真实 invalid_scope，不输出远端描述`, async (t) => {
    const flow = await gateway(t, { tokenStatus: status,
      token: { error: "invalid_scope", error_description: "MCP OAuth secret-description", scope: "", access_token: "secret-token", token_type: "Bearer" } });
    await assert.rejects(flow.login(), (error) => {
      assert.equal(error.code, "invalid_scope");
      assert.match(error.message, /token exchange failed \(OAuthError: invalid_scope\)/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.equal(flow.provider.tokens(), undefined);
    assert.equal(flow.tokenRequests.length, 1);
  });
}

test("MCP OAuth 非字符串 token scope 保留 SDK 校验错误和换码阶段", async (t) => {
  const flow = await gateway(t, { token: { access_token: "test", token_type: "Bearer", scope: null } });
  await assert.rejects(flow.login(), /token exchange failed \(Error: Invalid scope\)/);
  assert.equal(flow.provider.tokens(), undefined);
});

test("MCP OAuth 回调错误显示阶段与错误码，不尝试换码", async (t) => {
  const flow = await gateway(t, { callbackError: "invalid_scope" });
  await assert.rejects(flow.login(), /authorization callback failed \(OAuthError: invalid_scope\)/);
  assert.equal(flow.tokenRequests.length, 0);
});

test("MCP OAuth 空 scope 兼容只修改成功的 token POST 响应", async (t) => {
  const flow = await gateway(t);
  flow.provider.saveDiscoveryState(flow.discovery);
  const value = { access_token: "fake", token_type: "Bearer", scope: "" };
  for (const [url, method] of [[flow.config.url, "POST"], [flow.discovery.authorizationServerMetadata.token_endpoint, "GET"]]) {
    const response = Response.json(value);
    const request = mcpOAuthFetch(flow.provider, async () => response);
    assert.equal(await request(url, { method }), response);
    assert.deepEqual(await response.json(), value);
  }
});

test("MCP 运行时 OAuth 刷新复用空 scope 兼容，不要求再次登录", async (t) => {
  const flow = await gateway(t);
  flow.provider.saveDiscoveryState(flow.discovery);
  flow.provider.saveClientInformation({ client_id: "cached" });
  flow.provider.saveTokens({ access_token: "expired", refresh_token: "refresh", token_type: "Bearer" });
  const runtime = new McpRuntime();
  t.after(() => runtime.close());
  const adapted = runtime.oauthProvider(flow.config, (provider) => {
    provider.file = flow.file;
    return adaptOAuthProvider(provider);
  });
  await adapted.onUnauthorized({ serverUrl: flow.config.url, token: "expired", response: new Response(null, { status: 401 }), fetch });
  assert.equal(flow.tokenRequests[0].grant_type, "refresh_token");
  assert.equal(await adapted.token(), "test-access");
  assert.equal(flow.provider.tokens().scope, undefined);
});
