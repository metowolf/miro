import { Box, Text } from "ink";

import { useSpinner, useSpinnerVerb } from "../hooks/use-spinner.js";

/**
 * 整个回合常驻的状态行。
 *
 * 位置上始终是输入框的上一行：它渲染在 ActivitySlot 之后，因此工具输出、已完成摘要
 * 等内容都堆在它上方，而不会把它顶开。
 *
 * 这一行是统一的「回合状态槽」，包含两种互斥形态：
 * - cancelling：黄色 Interrupting…
 * - 否则：青色的随机动词 + 计时
 * 两者共用同一行，因此按 esc 取消时提示不会跳到工具输出的位置。
 *
 * 与 ActivitySlot 的区别：ActivitySlot 是「单槽」，同一时刻只展示最具体的那一件事
 * （工具调用 / 已完成摘要 / Thinking）；而这一行表示「本回合仍在进行中」，
 * 因此不会被工具调用抢占，只要 busy 就一直显示，避免工具运行期间状态行消失、
 * 让界面看起来像卡住了。
 *
 * 仍让位于 hasBashActivity：BashCard 自己拥有活动区与计时。
 *
 * 也让位于 awaitingInput（权限审批等阻塞式 overlay）：那时回合仍是 busy，但真正
 * 在等的是用户按键，继续跑 spinner 与计时只会让对话框每 100ms 抖一次。审批期间
 * 界面看起来「卡住」正是事实，不需要动词来暗示还在推进。
 *
 * spinner 必须放进 width={2} 的盒子里、而不是靠 paddingX + 文本里的空格：
 * Message 与 ActivitySlot 的 marker（`●` / `∴`）都用这个宽度，正文因此都从第 3 列
 * 起排。用 paddingX={1} 会把这一行整体右移一格，在 transcript 里显得缩进不齐。
 */
export function StatusVerb({
  now,
  busy,
  cancelling,
  turnStartedAt,
  toolRound = 0,
  hasBashActivity = false,
  awaitingInput = false,
  retryNotice = null,
}) {
  // 等待用户输入时让 spinner 停摆，从根上去掉这个 100ms 的重渲源。
  const spinner = useSpinner(busy && !awaitingInput);
  // key 里带工具轮次：一批工具内动词稳定，模型每重新调一次工具就换新词。
  // 只用 turnStartedAt 的话，跑几十轮工具的长回合会几分钟不动一个字，
  // 用户无法从这一行判断到底还在推进还是卡住了。
  const verb = useSpinnerVerb(turnStartedAt == null ? null : `${turnStartedAt}:${toolRound}`);

  if (!busy || hasBashActivity || awaitingInput) return null;

  if (cancelling) {
    return (
      <Box marginTop={1}>
        <Box width={2} flexShrink={0}><Text color="yellow">{spinner}</Text></Box>
        <Text color="yellow">Interrupting…</Text>
      </Box>
    );
  }

  // 重试期间顶替动词：模型没在思考，是网络/服务端在恢复，
  // 继续显示「Thinking…」会误导用户以为进展正常。
  if (retryNotice) {
    const { attempt, maxRetries, delayMs, status } = retryNotice;
    const seconds = Math.max(1, Math.ceil((delayMs ?? 0) / 1000));
    const reason = status === 429 ? "rate limited" : status != null ? `HTTP ${status}` : "connection lost";
    return (
      <Box marginTop={1}>
        <Box width={2} flexShrink={0}><Text color="yellow">{spinner}</Text></Box>
        <Text color="yellow">
          Reconnecting… {attempt}/{maxRetries}{" "}
          <Text dimColor>({reason} · retrying in {seconds}s · esc to interrupt)</Text>
        </Text>
      </Box>
    );
  }

  // 不足 1 秒不印秒数：这一行本来就有 spinner，「0s」只是噪声；
  // esc 提示必须保留，否则开头一秒里用户看不到时如何中断。
  const elapsed = turnStartedAt == null ? 0 : Math.max(0, Math.floor((now - turnStartedAt) / 1000));
  const timing = elapsed > 0 ? `${elapsed}s · ` : "";
  return (
    <Box marginTop={1}>
      <Box width={2} flexShrink={0}><Text color="cyan">{spinner}</Text></Box>
      <Text color="cyan">{verb}… <Text dimColor>({timing}esc to interrupt)</Text></Text>
    </Box>
  );
}
