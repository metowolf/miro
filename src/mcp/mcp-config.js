import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MIRO_DIR, readSystemSettings, writeSystemSettings } from "../config/settings-file.js";

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const stringMap = (value) => isObject(value) && Object.values(value).every((entry) => typeof entry === "string");

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_REQUEST_TIMEOUT_MS = 60_000;
export const MCP_PROJECT_FILE = ".miro/mcp.json";
const TRUST_FILE = path.join(MIRO_DIR, "mcp-trust.json");

export function projectMcpPath(cwd) { return path.join(cwd, MCP_PROJECT_FILE); }

const contentDigest = (content) => createHash("sha256").update(content).digest("hex");

// 校验与解析共享同一份内容，避免校验后再次读取到未经授权的版本。
function readProjectMcp(cwd, trustFile) {
  const file = projectMcpPath(cwd);
  let content;
  try { content = readFileSync(file, "utf8"); } catch (error) {
    return { state: { file, exists: error.code !== "ENOENT", trusted: false,
      ...(error.code !== "ENOENT" ? { diagnostic: `Cannot read project MCP configuration: ${file}` } : {}) } };
  }
  const digest = contentDigest(content);
  let trusted = false;
  try { trusted = JSON.parse(readFileSync(trustFile, "utf8"))[path.resolve(cwd)] === digest; } catch {}
  return { state: { file, exists: true, trusted, digest }, content };
}

export function projectMcpTrust(cwd, trustFile = TRUST_FILE) {
  return readProjectMcp(cwd, trustFile).state;
}

function saveProjectTrust(cwd, digest, trustFile) {
  let grants = {};
  try {
    const saved = JSON.parse(readFileSync(trustFile, "utf8"));
    if (isObject(saved)) grants = saved;
  } catch {}
  grants[path.resolve(cwd)] = digest;
  mkdirSync(path.dirname(trustFile), { recursive: true });
  writeFileSync(trustFile, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
  chmodSync(trustFile, 0o600);
}

export function trustProjectMcp(cwd, trustFile = TRUST_FILE) {
  const state = projectMcpTrust(cwd, trustFile);
  if (state.diagnostic) throw new Error(state.diagnostic);
  if (!state.exists) throw new Error(`No MCP configuration at ${state.file}`);
  saveProjectTrust(cwd, state.digest, trustFile);
  return state;
}

export function loadMcpServers(settings, cwd, { trustFile = TRUST_FILE } = {}) {
  const global = settings?.mcpServers ?? {};
  const { state: trust, content } = readProjectMcp(cwd, trustFile);
  let project = {};
  const diagnostics = [];
  if (trust.diagnostic) diagnostics.push(trust.diagnostic);
  else if (trust.exists && !trust.trusted) diagnostics.push(`Project MCP configuration requires trust: ${trust.file}`);
  if (trust.trusted) {
    try {
      const parsed = JSON.parse(content);
      if (!isObject(parsed) || !isObject(parsed.mcpServers)) throw new Error("expected an mcpServers object");
      project = parsed.mcpServers;
    } catch { diagnostics.push(`Invalid project MCP configuration: ${trust.file}`); }
  }
  if (!isObject(global)) diagnostics.push("mcpServers must be an object keyed by server name");
  const validProject = {};
  for (const [name, entry] of Object.entries(project)) {
    const checked = parseMcpServers({ [name]: entry });
    if (checked.diagnostics.length) diagnostics.push(...checked.diagnostics.map((message) => `${trust.file}: ${message}`));
    else validProject[name] = entry;
  }
  const merged = { ...(isObject(global) ? global : {}), ...validProject };
  const parsed = parseMcpServers(merged);
  const source = (name) => Object.hasOwn(validProject, name) ? trust.file : "global";
  const projectVersion = (name) => Object.hasOwn(validProject, name) ? { projectDigest: trust.digest } : {};
  const configured = Object.entries(merged).map(([name, entry]) => ({ name, source: source(name), ...projectVersion(name),
    type: entry?.type ?? (entry?.url ? "http" : "stdio"),
    enabled: entry?.disabled !== true && entry?.enabled !== false }));
  return { servers: parsed.servers.map((server) => ({ ...server, source: source(server.name), ...projectVersion(server.name) })),
    configured, diagnostics: [...diagnostics, ...parsed.diagnostics], trust };
}

export function updateMcpServerSetting(server, key, value, cwd, {
  trustFile = TRUST_FILE, readSettings = readSystemSettings, writeSettings = writeSystemSettings,
} = {}) {
  if (key !== "enabled") throw new Error("Unsupported MCP setting");
  const changed = () => new Error("MCP server configuration changed; reload and trust it first.");
  const update = (entry) => {
    if (!isObject(entry)) throw changed();
    const next = { ...entry, [key]: value };
    if (key === "enabled") delete next.disabled;
    return next;
  };
  if (server.source === "global") {
    const settings = readSettings();
    writeSettings({ ...settings, mcpServers: {
      ...settings.mcpServers,
      [server.name]: update(settings.mcpServers?.[server.name]),
    } });
    return;
  }
  const { state, content } = readProjectMcp(cwd, trustFile);
  if (!state.trusted || state.digest !== server.projectDigest || state.file !== server.source) throw changed();
  const parsed = JSON.parse(content);
  parsed.mcpServers[server.name] = update(parsed.mcpServers?.[server.name]);
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  writeFileSync(state.file, next);
  // 只授权刚刚生成的内容；写入后若外部再次修改，新的内容仍须显式授权。
  saveProjectTrust(cwd, contentDigest(next), trustFile);
}

function expandEnv(value) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (process.env[name] == null) throw new Error("missing environment variable");
    return process.env[name];
  });
}

/** 只读取系统设置；无效条目单独报错，不能拖垮其它服务，也不回显凭据。 */
export function parseMcpServers(value) {
  const servers = [];
  const diagnostics = [];
  if (value == null) return { servers, diagnostics };
  if (!isObject(value)) return { servers, diagnostics: ["mcpServers must be an object keyed by server name"] };
  for (const [name, entry] of Object.entries(value)) {
    const invalid = (reason) => diagnostics.push(`MCP ${JSON.stringify(name)}: ${reason}`);
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !isObject(entry)) { invalid("expected a server name using letters, digits, _ or -"); continue; }
    if (entry.disabled === true || entry.enabled === false) continue;
    const type = entry.type ?? (entry.url != null ? "http" : "stdio");
    if (type !== "stdio" && type !== "http" && type !== "streamable-http") { invalid("type must be stdio or http"); continue; }
    const timeoutKeys = ["connectTimeoutMs", "timeoutMs"];
    if (timeoutKeys.some((key) => entry[key] != null && (!Number.isSafeInteger(entry[key]) || entry[key] < 1 || entry[key] > 2_147_483_647))) {
      invalid("timeouts must be positive integer milliseconds (at most 2147483647)"); continue;
    }
    const common = {
      name, type,
      connectTimeoutMs: entry.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      timeoutMs: entry.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
    };
    if (type === "stdio") {
      if (!nonempty(entry.command) || entry.url != null || entry.headers != null ||
          (entry.args != null && (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string"))) ||
          (entry.env != null && !stringMap(entry.env))) {
        invalid("stdio requires command, optional string args and string-valued env; url/headers are not supported"); continue;
      }
      try {
        servers.push({ ...common, command: expandEnv(entry.command), args: (entry.args ?? []).map(expandEnv), env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, expandEnv(value)])) });
      } catch { invalid("unresolved environment variable"); }
    } else {
      let url;
      try { url = new URL(expandEnv(entry.url)); } catch { /* 统一在下面返回不含原始值的诊断。 */ }
      const oauth = entry.oauth;
      let callbackUrl;
      try { if (oauth?.callbackUrl != null) callbackUrl = new URL(oauth.callbackUrl); } catch {}
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
          entry.command != null || entry.args != null || entry.env != null ||
          (entry.headers != null && !stringMap(entry.headers)) ||
          (oauth != null && (!isObject(oauth) ||
            (oauth.clientId != null && !nonempty(oauth.clientId)) ||
            (oauth.clientSecret != null && typeof oauth.clientSecret !== "string") ||
            (oauth.scope !== undefined && (typeof oauth.scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(oauth.scope))) ||
            (oauth.callbackPort != null && (!Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535)) ||
            (oauth.callbackUrl != null && (!callbackUrl || callbackUrl.protocol !== "http:" ||
              !["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname) || callbackUrl.search || callbackUrl.hash))))) {
        invalid("http requires an http(s) url without userinfo/fragment and optional string-valued headers; command/args/env are not supported"); continue;
      }
      try {
        servers.push({ ...common, type: "http", url: url.href, headers: Object.fromEntries(Object.entries(entry.headers ?? {}).map(([key, value]) => [key, expandEnv(value)])), oauth: oauth ? { ...oauth, ...(oauth.clientSecret ? { clientSecret: expandEnv(oauth.clientSecret) } : {}) } : null });
      } catch { invalid("unresolved environment variable"); }
    }
  }
  return { servers, diagnostics };
}

/** ACP 的 stdio 类型没有 type 字段，env/headers 使用 name/value 数组。 */
export function toAcpMcpServers(servers) {
  const pairs = (value) => Object.entries(value).map(([name, value]) => ({ name, value }));
  return servers.map((server) => server.type === "http"
    ? { type: "http", name: server.name, url: server.url, headers: pairs(server.headers) }
    : { name: server.name, command: server.command, args: server.args, env: pairs(server.env) });
}
