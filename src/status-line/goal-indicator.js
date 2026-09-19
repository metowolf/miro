import { formatElapsed } from "../miro/goal.js";

/**
 * 底栏右侧的目标指示图标。
 *
 * 用一个字形而不是文字标签：「有目标在跑」是常驻状态，每次都要读一遍
 * 「目标」两个字是浪费；`◎` 与状态栏其它单字标记（`●`/`∴`）同属一眼可辨的
 * 符号，状态词紧跟其后负责解释它。
 */
export const GOAL_INDICATOR_MARK = "◎";

/**
 * 状态 → 颜色。与 goal.js 的语义对齐：还在推进是青色（同 StatusVerb 的「在跑」），
 * 需要用户介入的两种停态用黄/红，已完成用绿色。
 */
const GOAL_STATUS_COLORS = {
  pending: "yellow",
  active: "cyan",
  pausing: "yellow",
  paused: "yellow",
  blocked: "red",
  complete: "green",
};

/**
 * 底栏右侧的目标指示：`◎ /goal active (4s)`。
 *
 * 只要存在目标快照就展示，终态也不例外：目标消失（而不是换个颜色）会让用户
 * 分不清「完成了」和「被取消了」，而状态词本身就是答案。
 *
 * 耗时取快照的 `wallClockMs`，也就是目标的**实际推进时间**（暂停期间与结束之后
 * 都不计入，与预算同一口径），而不是从创建算起的自然时长。这个数字随快照刷新，
 * 刷新由 App 的秒表负责（见 StatusBar 的调用方）：把「多久没动」交给数据，
 * 这里保持纯函数。
 *
 * 没有目标、或拿到的不是一份可用快照时返回 null，调用方据此整项跳过。
 *
 * 颜色跟随状态栏的 useColors：关掉颜色的用户要的是一条单色栏，在这里留一个
 * 彩色小岛只会显得像渲染出错。
 */
export function goalIndicator(snapshot, { useColors = true } = {}) {
  if (snapshot == null || typeof snapshot.status !== "string") return null;
  const status = snapshot.status.trim();
  if (status.length === 0) return null;
  const elapsed = Number.isFinite(snapshot.wallClockMs) ? Math.max(0, snapshot.wallClockMs) : 0;
  const color = GOAL_STATUS_COLORS[status] ?? null;
  return {
    mark: GOAL_INDICATOR_MARK,
    text: `${GOAL_INDICATOR_MARK} /goal ${status} (${formatElapsed(elapsed)})`,
    color: useColors ? color : null,
    dim: !useColors,
  };
}
