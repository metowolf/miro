import { toolFromGroup } from "./store.js";

function toolEntries(tool, prefix) {
  const items = tool?.reviewItems?.length ? tool.reviewItems : [];
  return items.map((item, index) => ({
    id: `${prefix}:tool:${index}`,
    kind: item?.subagent ? "subagent" : "tool",
    item,
  }));
}

function bashEntry(card, id) {
  return { id: `${id}:bash`, kind: "bash", card };
}

/**
 * 当前进程内所有可复查 thinking/tool/bash，按 transcript 顺序扁平化。
 * 实时来源（活动 thought、已完成的 bash 卡片）一律追加在历史之后：浏览器的默认
 * 停靠位是最后一条，落在屏幕最下方的那件事就是按键最该命中的那件事。
 */
export function reviewEntries(state) {
  const entries = [];
  for (const [index, block] of (state.blocks ?? []).entries()) {
    if (block.role === "thought" && block.thought?.text?.trim()) {
      entries.push({
        id: `${block.id ?? index}:thought`,
        kind: "thought",
        thought: block.thought,
      });
    } else if (block.role === "tool") {
      entries.push(...toolEntries(block.tool, block.id ?? index));
    } else if (block.role === "bashCard" && block.card) {
      entries.push(bashEntry(block.card, block.id ?? index));
    }
  }

  if (state.pendingToolGroup) {
    entries.push(...toolEntries(toolFromGroup(state.pendingToolGroup), "pending"));
  }
  if (state.thought && state.thought.text && state.thought.text.trim().length > 0) {
    entries.push({ id: "live:thought", kind: "thought", thought: state.thought, live: true });
  }
  if (state.bashCard && state.bashCard.status === "done") {
    entries.push({ ...bashEntry(state.bashCard, "live"), live: true });
  }
  return entries;
}

/**
 * ctrl+o 当前会作用到的对象：永远只剩「开窗口」与「关窗口」两种。
 * 实时内容不再就地展开，而是作为条目并进同一个浏览器窗口，`live` 只表示
 * 「这件事正显示在底部活动区」（也就是自己会打 ctrl+o 广告的那一类）。
 */
export function findReviewTarget(state) {
  const { overlay, pendingToolGroup, blocks = [] } = state;
  if (overlay?.kind === "review-browser") return { kind: "close" };
  if (overlay) return null;

  const entries = reviewEntries({ ...state, blocks, pendingToolGroup });
  if (entries.length === 0) return null;
  return {
    kind: "review",
    entries,
    index: entries.length - 1,
    // 未定稿的工具组也在活动区里，算「会自己打广告」的一类。
    live: Boolean(pendingToolGroup) || entries.some((entry) => entry.live),
  };
}
