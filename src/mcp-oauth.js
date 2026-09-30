import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MIRO_DIR } from "./settings-file.js";
import { openUrl } from "./open-browser.js";

export const MCP_AUTH_FILE = path.join(MIRO_DIR, "mcp-auth.json");

function readStore(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

function writeStore(file, all) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function updateStore(file, url, update) {
  const all = readStore(file);
  all[url] = update({ ...(all[url] ?? {}) });
  writeStore(file, all);
}

/** pi-mcp 的 OAuthClientProvider；凭据按服务 URL 隔离。 */
export class McpOAuthProvider {
  constructor(config, { file = MCP_AUTH_FILE, onRedirect = () => {}, signal } = {}) {
    this.config = config;
    this.file = file;
    this.signal = signal;
    this.onRedirect = onRedirect;
    this.url = config.url;
    this.callbackPort = config.oauth?.callbackUrl ? Number(new URL(config.oauth.callbackUrl).port || config.oauth.callbackPort || 8765)
      : config.oauth?.callbackPort ?? 8765;
  }
  get redirectUrl() { return configRedirect(this.config, this.callbackPort); }
  get clientMetadata() {
    const row = this.record();
    const resource = row.discoveryState?.resourceMetadata;
    // 部分网关使用 resource_scopes；SDK 保存发现结果后才读取这里，首次登录和旧缓存都能回退。
    const scopes = resource?.scopes_supported ?? resource?.resource_scopes;
    const scope = this.config.oauth?.scope ?? (Array.isArray(scopes) && scopes.every((item) => typeof item === "string")
      ? scopes.join(" ") : undefined) ?? row.clientInformation?.scope;
    return {
      client_name: "Miro", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}),
    };
  }
  record() { this.signal?.throwIfAborted(); return readStore(this.file)[this.url] ?? {}; }
  update(change) { this.signal?.throwIfAborted(); updateStore(this.file, this.url, change); }
  state() { const value = randomUUID(); this.update((row) => ({ ...row, state: value })); return value; }
  clientInformation() { return this.record().clientInformation ?? (this.config.oauth?.clientId
    ? { client_id: this.config.oauth.clientId, ...(this.config.oauth.clientSecret ? { client_secret: this.config.oauth.clientSecret } : {}) }
    : undefined); }
  saveClientInformation(value) { this.update((row) => ({ ...row, clientInformation: value })); }
  tokens() { return this.record().tokens; }
  saveTokens(value) { this.update((row) => ({ ...row, tokens: value })); }
  redirectToAuthorization(url) { this.signal?.throwIfAborted(); this.onRedirect(url.href); }
  saveCodeVerifier(value) { this.update((row) => ({ ...row, codeVerifier: value })); }
  codeVerifier() { return this.record().codeVerifier; }
  saveDiscoveryState(value) { this.update((row) => ({ ...row, discoveryState: value })); }
  discoveryState() { return this.record().discoveryState; }
  invalidateCredentials(scope) { this.update((row) => {
    if (scope === "all" || scope === "client") delete row.clientInformation;
    if (scope === "all" || scope === "tokens") delete row.tokens;
    if (scope === "all" || scope === "verifier") delete row.codeVerifier;
    if (scope === "all" || scope === "discovery") delete row.discoveryState;
    return row;
  }); }
}

function tokenEndpoint(provider) {
  const state = provider.discoveryState();
  return state?.authorizationServerMetadata?.token_endpoint ??
    (state?.authorizationServerUrl ? new URL("/token", state.authorizationServerUrl).href : undefined);
}

/** 只兼容成功令牌响应中的空 scope，不改 MCP 业务响应，也不吞掉服务端 OAuth 错误。 */
export function mcpOAuthFetch(provider, fetchImpl = globalThis.fetch) {
  return async (input, init) => {
    provider.signal?.throwIfAborted();
    const signal = provider.signal
      ? (init?.signal ? AbortSignal.any([provider.signal, init.signal]) : provider.signal) : init?.signal;
    const response = await fetchImpl(input, { ...init, ...(signal ? { signal } : {}) });
    provider.signal?.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    if (!response.ok || (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST" ||
        url !== tokenEndpoint(provider)) return response;
    let value;
    try { value = await response.clone().json(); } catch { return response; }
    provider.signal?.throwIfAborted();
    if (!value || typeof value !== "object" || value.error !== undefined || value.scope !== "" ||
        typeof value.access_token !== "string" || typeof value.token_type !== "string") return response;
    delete value.scope;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    void response.body?.cancel().catch(() => {});
    return new Response(JSON.stringify(value), { status: response.status, statusText: response.statusText, headers });
  };
}

function oauthFailure(stage, error) {
  // 远端错误描述可能夹带凭据；只展示阶段、受控错误类型与协议错误码。
  const type = ["OAuthError", "OAuthRegistrationError", "OAuthIssuerMismatchError", "OAuthInsecureEndpointError", "TypeError"]
    .includes(error?.name) ? error.name : "Error";
  const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : undefined;
  const detail = code ?? (/^Invalid [a-z_]+$/.test(error?.message ?? "") ? error.message : undefined);
  const failure = new Error(`MCP OAuth ${stage} failed (${type}${detail ? `: ${detail}` : ""})`, { cause: error });
  if (code) failure.code = code;
  return failure;
}

function configRedirect(config, port) {
  if (!config.oauth?.callbackUrl) return `http://127.0.0.1:${port}/callback`;
  const url = new URL(config.oauth.callbackUrl);
  if (!url.port) url.port = String(port);
  return url.href;
}

export function logoutMcp(config, file = MCP_AUTH_FILE) {
  if (!existsSync(file)) return;
  const all = readStore(file);
  delete all[config.url];
  writeStore(file, all);
}

export async function loginMcp(config, { file = MCP_AUTH_FILE, print = (text) => process.stderr.write(`${text}\n`),
  open = openUrl, signal, timeoutMs = 180_000 } = {}) {
  if (config.type !== "http" || Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
    throw new Error("Only HTTP MCP servers without an Authorization header use OAuth.");
  }
  signal?.throwIfAborted();
  const { authorizeMcp, parseWwwAuthenticate } = await import("@earendil-works/pi-mcp/oauth");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const loginSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let authorizationUrl;
  const provider = new McpOAuthProvider(config, { file, signal: loginSignal, onRedirect: (url) => { authorizationUrl = url; } });
  let finish;
  const callback = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  // 回调可能早于发现阶段结束到达，先接住拒绝，再由下面的流程统一处理。
  void callback.catch(() => {});
  const redirect = new URL(provider.redirectUrl);
  const host = redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname.replace(/^\[|\]$/g, "");
  let server;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(loginSignal.reason);
    loginSignal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error("MCP OAuth sign-in timed out")), timeoutMs);
  let stage = "callback listener";
  try {
    server = Bun.serve({ hostname: host, port: provider.callbackPort, fetch(request) {
      if (loginSignal.aborted) return new Response("Sign-in cancelled", { status: 410 });
      const url = new URL(request.url);
      if (url.pathname !== redirect.pathname) return new Response("Not found", { status: 404 });
      if (url.searchParams.get("state") !== provider.record().state) {
        finish.reject(new Error("MCP OAuth state mismatch"));
        return new Response("Invalid OAuth state", { status: 400 });
      }
      const error = url.searchParams.get("error");
      if (error) {
        finish.reject(Object.assign(new Error("Authorization rejected"), { name: "OAuthError", code: error }));
        return new Response("MCP OAuth authorization rejected", { status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) { finish.reject(new Error("MCP OAuth did not return an authorization code")); return new Response("No code", { status: 400 }); }
      finish.resolve(code);
      return new Response("Authorization code received. Check the Miro terminal for the sign-in result.");
    } });
    // 直接 login 也先读取 401 挑战，不能假定默认 well-known 路径适用于所有网关。
    stage = "discovery";
    const request = mcpOAuthFetch(provider);
    const challenge = await Promise.race([(async () => {
      const response = await request(config.url, { method: "GET", redirect: "manual",
        headers: { ...config.headers, Accept: "application/json, text/event-stream" } });
      const value = [401, 403].includes(response.status) ? parseWwwAuthenticate(response.headers.get("www-authenticate")) : {};
      await response.body?.cancel();
      return value;
    })(), aborted]);
    if (challenge.resourceMetadataUrl && provider.discoveryState()?.resourceMetadataUrl !== challenge.resourceMetadataUrl.href) {
      provider.invalidateCredentials("discovery");
    }
    // 发现、注册、刷新和换码共用取消信号；配置优先于挑战，再由 SDK 和 provider 回退到资源权限。
    const options = { serverUrl: config.url, resourceMetadataUrl: challenge.resourceMetadataUrl,
      scope: config.oauth?.scope ?? challenge.scope, fetch: (input, init) => {
        stage = init?.method?.toUpperCase() !== "POST" ? "discovery" : String(input) !== tokenEndpoint(provider)
          ? "client registration" : init.body?.get?.("grant_type") === "authorization_code" ? "token exchange" : "token refresh";
        return request(input, init);
      } };
    const authorize = async (extra) => {
      await Promise.race([authorizeMcp(provider, { ...options, ...extra }), aborted]);
      loginSignal.throwIfAborted();
    };
    await authorize();
    if (!authorizationUrl) { print("MCP OAuth credentials are already valid."); return; }
    print(`Open this URL to sign in: ${authorizationUrl}`);
    stage = "authorization callback";
    open(authorizationUrl);
    const code = await Promise.race([callback, aborted]);
    loginSignal.throwIfAborted();
    stage = "token exchange";
    await authorize({ authorizationCode: code });
    print("MCP OAuth sign-in completed.");
  } catch (error) {
    loginSignal.throwIfAborted();
    if (stage === "callback listener" || (stage === "authorization callback" && error?.name === "Error" &&
        ["MCP OAuth state mismatch", "MCP OAuth did not return an authorization code"].includes(error.message))) throw error;
    throw oauthFailure(stage, error);
  } finally {
    clearTimeout(timer);
    loginSignal.removeEventListener("abort", onAbort);
    controller.abort();
    await server?.stop(true);
  }
}
