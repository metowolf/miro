/**
 * picker 的统一过滤、排序与高亮。
 *
 * 过滤语义为「大小写不敏感的子序列匹配」，与 acp/config-options.js 的
 * fuzzyMatch 保持一致；命中后额外按匹配质量排序——连续命中优于跳跃命中、
 * 前缀匹配优于文本中部匹配——使得输入 hy4 时 hy4-… 排在 hy3-…4 之前。
 */

import { fuzzyMatch } from "../../acp/config-options.js";

export { fuzzyMatch };

/**
 * 参与匹配的文本：主文案 + 右栏 + 分组 + 说明 + value。
 * 右栏（right）必须参与：Ctrl+O 查看器把 title 放在右栏，若只匹配 label，
 * 搜索框就只能按序号和类型过滤，输入工具名或路径会全部落空。
 */
export function searchableText(item) {
  return [item?.label, item?.right, item?.name, item?.groupName, item?.description, item?.value]
    .filter((value) => value != null && value !== "")
    .join(" ");
}

/**
 * 子序列命中的字符下标，用于高亮。无匹配返回 null。
 * 采用贪心从左到右取最早命中位置，与 fuzzyMatch 的判定路径一致。
 */
export function matchIndices(text, query) {
  const source = String(text ?? "");
  const needle = String(query ?? "");
  if (!needle) return [];

  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const indices = [];
  let cursor = 0;

  for (const ch of lowerNeedle) {
    const hit = lowerSource.indexOf(ch, cursor);
    if (hit === -1) return null;
    indices.push(hit);
    cursor = hit + 1;
  }
  return indices;
}

/**
 * 模糊匹配评分：数值越大表示匹配质量越高，不匹配返回 null。
 *
 * 与 fuzzyMatch 共享同一条贪心遍历路径，在判断是否匹配的同时收集评分信号：
 * - 连续命中段越长越好（hy4 匹配 hy4-… 全连续，远胜 hy3-…4 跳跃命中）
 * - 首次命中越早越好（前缀匹配优于文本中部匹配）
 * - 命中字符之间的间隔（gap）越小越好（紧凑匹配优于分散匹配）
 */
export function matchScore(text, query) {
  const source = String(text ?? "").toLowerCase();
  const needle = String(query ?? "").toLowerCase();
  if (!needle) return 0;

  let cursor = 0;
  let prevHit = -2; // 初始 -2 保证首字符不计为连续
  let consecutive = 0;
  let maxConsecutive = 0;
  let firstPos = -1;

  for (const ch of needle) {
    const hit = source.indexOf(ch, cursor);
    if (hit === -1) return null;

    if (firstPos === -1) firstPos = hit;
    consecutive = hit === prevHit + 1 ? consecutive + 1 : 1;
    if (consecutive > maxConsecutive) maxConsecutive = consecutive;

    prevHit = hit;
    cursor = hit + 1;
  }

  // gap：首末命中跨度减去 query 长度，反映匹配的紧凑程度（全连续时为 0）
  const gap = prevHit - firstPos + 1 - needle.length;

  let score = 0;
  score += maxConsecutive * 100; // 连续段权重最高
  score -= firstPos; // 起始越早越好
  score -= gap * 10; // 间隔越大越差
  // 前缀全连续额外奖励：query 整体连续命中且从文本起始处开始
  if (firstPos === 0 && maxConsecutive === needle.length) score += 1000;

  return score;
}

/**
 * 过滤并按匹配质量排序 items。query 为空时原样返回（保持引用，避免无谓重渲染）。
 * disabled 项照常参与过滤，由渲染层决定置灰。
 */
export function filterItems(items, query) {
  const list = Array.isArray(items) ? items : [];
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return list;
  return list
    .map((item) => ({ item, score: matchScore(searchableText(item), trimmed) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

/**
 * 把文本按命中下标切成 { text, hit } 段，供渲染层着色。
 * 无 query 或无命中时返回单段未命中结果。
 *
 * 迭代按码点进行，但位置游标按 character.length 推进，从而与 matchIndices
 * 基于 indexOf 的 UTF-16 偏移口径对齐；若逐 code unit 切分，代理对会被拆进
 * 不同 <Text>，emoji 在终端会显示成替换字符。
 */
export function highlightSegments(text, query) {
  const source = String(text ?? "");
  const indices = matchIndices(source, query);
  if (!indices || indices.length === 0) {
    return source === "" ? [] : [{ text: source, hit: false }];
  }

  const hits = new Set(indices);
  const segments = [];
  let position = 0;
  for (const character of source) {
    const hit = hits.has(position);
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += character;
    else segments.push({ text: character, hit });
    position += character.length;
  }
  return segments;
}
