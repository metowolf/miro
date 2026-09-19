import os from "node:os";
import path from "node:path";

/**
 * 状态栏指标注册表。
 *
 * id 使用 kebab-case，保留部分 legacy 别名；取值函数返回 null 表示该项当前
 * 不可用，渲染时直接跳过（不占位、不显示 0）。
 */

/** 把绝对路径里的 home 前缀缩写成 ~。 */
function shortenHome(dir) {
  const home = os.homedir();
  if (!dir) return null;
  if (dir === home) return "~";
  return dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
}

/** 数字千分位紧凑格式：1234 → 1.2k，1234567 → 1.2M。 */
export function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 只认正数读数；未上报、非法值与 0 一律按 0 计。 */
function positiveOrZero(count) {
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * 会话累计成本 → 摘要末段：`$0.002`。
 *
 * 小额多留几位小数，大额少留：退出摘要里的成本常年是分级（一次会话通常不到一分
 * 钱），一律砍成两位会把 `$0.002` 写成 `$0.00`，等于没印；而几元的会长会话又不需
 * 要第三位。临界值再往下留一位，避免真实读数被四舍五入成看起来像零的 `$0.000`。
 * 非 USD 的货币在读数值后面带 ISO 代码。
 *
 * @returns {string|null} 有可印读数时是成本段，否则 null。
 */
function formatSessionCost(cost) {
  const amount = cost?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const digits = amount < 0.001 ? 4 : amount < 1 ? 3 : 2;
  const currency = typeof cost?.currency === "string" && cost.currency ? cost.currency : "USD";
  const value = amount.toFixed(digits);
  if (currency !== "USD") return `${value} ${currency}`;
  return `$${value}`;
}

/**
 * 退出时的会话累计用量，压成一行 `Stat ↑输入 ↓输出  R读 W写 CH命中率  $成本`。
 *
 * 段位写法为 `↑8.3k ↓299 R22k CH93.5% $0.002`：↑/↓ 沿用活动槽
 * 思考行的写法，0 是已上报的有效值，照样印出；R/W 是缓存读/写，CH 是缓存命中率，
 * 末段是会话累计成本。三段之间用两个空格隔开。total 是各项之和，思考用量在退出
 * 摘要里信息量最低，都不单独罗列。
 *
 * 缓存一段：两个方向都是 0 时不占位置（没有缓存命中的会话不需要这一句）；一旦
 * 出现读数就固定写成 `R读 W写`，缺失或未上报的一侧补 0。命中率口径为——
 * 命中量 /（未命中输入 + 命中 + 写入），这里的分母取会话累计值，跟同一行印出的
 * 数字对得上；两端缓存都是 0 时命中率无意义，整段跳过（不印 CH0.0%）。
 *
 * 一项读数都没有时返回 null，由调用方整行跳过——不打印占位文案。
 *
 * @param {{input?: number, output?: number, cacheRead?: number, cacheWrite?: number}|null} tokens 会话累计用量
 * @param {{amount?: number, currency?: string}|null} [cost] 会话累计成本
 * @returns {string|null} 有可印读数时是 `Stat ...` 一行，否则 null。
 */
export function formatSessionTokenUsage(tokens, cost) {
  const value = (count) => {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
    return formatTokens(count) ?? "0";
  };
  const parts = [];
  const fields = [
    ["↑", tokens?.input],
    ["↓", tokens?.output],
  ]
    .flatMap(([arrow, count]) => {
      const formatted = value(count);
      return formatted == null ? [] : [`${arrow}${formatted}`];
    })
    .join(" ");
  if (fields) parts.push(fields);
  const cacheRead = positiveOrZero(tokens?.cacheRead);
  const cacheWrite = positiveOrZero(tokens?.cacheWrite);
  if (cacheRead > 0 || cacheWrite > 0) {
    const cacheParts = [`R${value(cacheRead)} W${value(cacheWrite)}`];
    const prompt = positiveOrZero(tokens?.input) + cacheRead + cacheWrite;
    if (prompt > 0) cacheParts.push(`CH${((cacheRead / prompt) * 100).toFixed(1)}%`);
    parts.push(cacheParts.join(" "));
  }
  const spent = formatSessionCost(cost);
  if (spent) parts.push(spent);
  return parts.length > 0 ? `Stat ${parts.join("  ")}` : null;
}

/** used/size → 已用百分比，size 非法时返回 null。 */
function usedPercent(usage) {
  const used = usage?.used;
  const size = usage?.size;
  if (typeof used !== "number" || typeof size !== "number" || size <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / size) * 100)));
}

/** 运行态文本。 */
function runStateText(snapshot) {
  if (snapshot.cancelling) return "Interrupting";
  if (!snapshot.busy) return "Ready";
  return snapshot.thinking ? "Thinking" : "Working";
}

/**
 * item 定义：
 * - id：canonical 配置值
 * - aliases：兼容别名
 * - label：配置面板使用的英文说明
 * - placeholder：预览缺少运行时数据时使用的样例值
 * - tone：渲染色调（model / dir / state / accent / dim）
 * - value(snapshot)：返回字符串或 null
 */
const ITEM_DEFINITIONS = [
  {
    id: "model",
    aliases: ["model-name"],
    label: "Current model name",
    placeholder: "gpt-5",
    tone: "model",
    description: "当前模型名",
    value: (s) => s.modelName ?? null,
  },
  {
    id: "model-with-reasoning",
    label: "Current model name with reasoning level",
    placeholder: "gpt-5 medium",
    tone: "model",
    description: "模型名 + 思考强度",
    value: (s) =>
      s.modelName == null ? null : s.effortName ? `${s.modelName} ${s.effortName}` : s.modelName,
  },
  {
    id: "reasoning",
    label: "Current reasoning level",
    placeholder: "medium",
    tone: "model",
    description: "当前思考强度",
    value: (s) => s.effortName ?? null,
  },
  {
    id: "mode",
    label: "Current session mode",
    placeholder: "default",
    tone: "accent",
    description: "当前会话模式",
    value: (s) => s.modeName ?? null,
  },
  {
    id: "permission-mode",
    aliases: ["permissions"],
    label: "Current permission mode",
    placeholder: "AUTO",
    tone: "accent",
    description: "当前权限模式",
    // 三档均明确显示，默认 auto 也不能让用户误以为每次写入都会确认。
    // ACP 不提供 miro 权限模式，缺值时保持隐藏。
    value: (s) => {
      if (s.permissionMode === "auto") return "AUTO";
      if (s.permissionMode === "manual") return "MANUAL";
      return null;
    },
  },
  {
    id: "current-dir",
    label: "Current working directory",
    placeholder: "~/workspace/miro",
    tone: "dir",
    description: "当前工作目录",
    value: (s) => shortenHome(s.cwd) ?? null,
  },
  {
    id: "project-name",
    aliases: ["project", "project-root"],
    label: "Current project name",
    placeholder: "miro",
    tone: "dir",
    description: "项目名",
    value: (s) => s.projectName ?? null,
  },
  {
    id: "hostname",
    label: "Current hostname",
    placeholder: "localhost",
    tone: "dim",
    description: "主机名",
    value: (s) => s.hostname ?? null,
  },
  {
    id: "git-branch",
    label: "Current Git branch",
    placeholder: "feat/branch-name",
    tone: "accent",
    description: "当前 Git 分支",
    value: (s) => s.gitBranch ?? null,
  },
  {
    id: "run-state",
    aliases: ["status"],
    label: "Current run state",
    placeholder: "Ready",
    tone: "state",
    description: "运行状态",
    value: (s) => runStateText(s),
  },
  {
    id: "provider",
    label: "Current ACP provider",
    placeholder: "Codex",
    tone: "accent",
    description: "当前 ACP provider",
    value: (s) => s.providerName ?? null,
  },
  {
    id: "session-id",
    aliases: ["thread-id"],
    label: "Current session ID",
    placeholder: "1094dbe3",
    tone: "dim",
    description: "会话 id（短格式）",
    value: (s) => (typeof s.sessionId === "string" && s.sessionId ? s.sessionId.slice(0, 8) : null),
  },
  {
    id: "session-title",
    aliases: ["thread-title"],
    label: "Current session title",
    placeholder: "Status line setup",
    tone: "dim",
    description: "会话标题",
    value: (s) => (typeof s.sessionTitle === "string" && s.sessionTitle.trim() ? s.sessionTitle.trim() : null),
  },
  {
    id: "miro-version",
    aliases: ["version"],
    label: "Miro version",
    placeholder: "v0.1.0",
    tone: "dim",
    description: "miro 版本号",
    value: (s) => (s.version ? `v${s.version}` : null),
  },
  {
    id: "context-used",
    aliases: ["context-usage"],
    label: "Context window used percentage",
    placeholder: "28% used",
    tone: "state",
    description: "上下文已用百分比",
    value: (s) => {
      const percent = usedPercent(s.usage);
      return percent == null ? null : `${percent}% used`;
    },
  },
  {
    id: "context-remaining",
    label: "Context window remaining percentage",
    placeholder: "72% left",
    tone: "state",
    description: "上下文剩余百分比",
    value: (s) => {
      const percent = usedPercent(s.usage);
      return percent == null ? null : `${100 - percent}% left`;
    },
  },
  {
    id: "context-window-size",
    label: "Context window size",
    placeholder: "200k ctx",
    tone: "dim",
    description: "上下文窗口总量",
    value: (s) => {
      const size = formatTokens(s.usage?.size);
      return size == null ? null : `${size} ctx`;
    },
  },
  {
    id: "task-progress",
    label: "Current task progress",
    placeholder: "3/7",
    tone: "accent",
    description: "最新 checklist 进度",
    value: (s) => {
      const total = s.plan?.total ?? 0;
      if (!total) return null;
      return `${s.plan.completed ?? 0}/${total}`;
    },
  },
  {
    id: "goal",
    aliases: ["goal-status"],
    label: "Active goal status and progress",
    placeholder: "goal active 3t",
    tone: "accent",
    description: "目标状态与进度",
    // 印状态而不只是「有目标」：blocked 与 active 对用户的含义完全相反，
    // 一个要他介入、一个不用管。回合数是目标特有的进度量（已用回合数没有
    // 上限时也有意义），预算存在时才补 /N，避免给不限预算的目标印假分母。
    //
    // ACP provider 没有目标机制，快照恒为 null，这一项自然隐藏。
    value: (s) => {
      const goal = s.goal;
      if (goal == null || typeof goal.status !== "string") return null;
      const limit = goal.budget?.turnBudget;
      const turns = typeof goal.turnsUsed === "number" ? goal.turnsUsed : 0;
      const progress = limit != null ? `${turns}/${limit}t` : `${turns}t`;
      return `goal ${goal.status} ${progress}`;
    },
  },
  {
    id: "used-tokens",
    label: "Total session tokens",
    placeholder: "12.3k tokens",
    tone: "dim",
    description: "会话累计 token",
    // 累计项读 store 的会话累计值，不读 `tokens`：后者是提供方最近一次读数
    // （ActivitySlot 的思考行提示用），miro 多轮调用时只等于最后一轮。
    value: (s) => {
      const total = formatTokens(s.sessionTokens?.total);
      return total == null ? null : `${total} tokens`;
    },
  },
  {
    id: "input-tokens",
    label: "Total input tokens",
    placeholder: "10k in",
    tone: "dim",
    description: "累计输入 token",
    value: (s) => {
      const value = formatTokens(s.sessionTokens?.input);
      return value == null ? null : `${value} in`;
    },
  },
  {
    id: "output-tokens",
    label: "Total output tokens",
    placeholder: "2k out",
    tone: "dim",
    description: "累计输出 token",
    value: (s) => {
      const value = formatTokens(s.sessionTokens?.output);
      return value == null ? null : `${value} out`;
    },
  },
  {
    id: "thought-tokens",
    label: "Total reasoning tokens",
    placeholder: "345 think",
    tone: "dim",
    description: "累计思考 token",
    value: (s) => {
      const value = formatTokens(s.sessionTokens?.thought);
      return value == null ? null : `${value} think`;
    },
  },
  {
    id: "session-cost",
    label: "Estimated session cost",
    placeholder: "$1.50",
    tone: "dim",
    description: "会话累计成本",
    // 与退出摘要同源：读累计值而不是 `usage.cost`（miro 那里只是最近一次
    // LLM 请求的成本，累加会让这一项在长会话里明显偏低）。
    value: (s) => {
      const amount = s.sessionCost?.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
      const currency = s.sessionCost.currency ?? "USD";
      return currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
    },
  },
];

/** canonical id → 定义。 */
export const STATUS_LINE_ITEMS = new Map(ITEM_DEFINITIONS.map((item) => [item.id, item]));

/** 别名与 canonical id → canonical id。 */
const ALIAS_TO_ID = new Map();
for (const item of ITEM_DEFINITIONS) {
  ALIAS_TO_ID.set(item.id, item.id);
  for (const alias of item.aliases ?? []) ALIAS_TO_ID.set(alias, item.id);
}

/** 解析单个配置值；无法识别返回 null。 */
export function resolveStatusLineItem(id) {
  if (typeof id !== "string") return null;
  return ALIAS_TO_ID.get(id.trim().toLowerCase()) ?? null;
}

/** 全量可用 id（含别名），用于文档与提示。 */
export function statusLineItemIds() {
  return ITEM_DEFINITIONS.map((item) => item.id);
}

/**
 * 把配置数组解析成 { items, invalid }。
 * items 为 canonical id 有序数组（已去重），invalid 保留用户原始写法。
 */
export function parseStatusLineItems(ids) {
  const items = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = resolveStatusLineItem(raw);
    if (id == null) {
      if (typeof raw === "string" && raw.trim()) invalid.push(raw.trim());
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(id);
  }
  return { items, invalid };
}
