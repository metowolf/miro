import { measureElement, useCursor, useStdout } from "ink";
import { useEffect, useLayoutEffect, useState } from "react";

import { DEFAULT_CURSOR, STEADY_BAR_CURSOR, writeCursorShape } from "../cursor-shape.js";
import { stringWidth } from "../markdown-width.js";
import { useStore } from "../store.js";

/**
 * 把**真实终端光标**钉到输入行的光标格上。
 *
 * 这块以前只有 `<Text inverse>` 画出来的假光标块：它能骗过眼睛，骗不过输入法。
 * IME 的预编辑串（拼音）与候选框是按真实光标位置画的，而 Ink 每帧输出以 `\n`
 * 结尾、默认又隐藏终端光标，于是真实光标停在最后一帧之后——也就是屏幕最底下，
 * 拼音就出现在那里（输入框里反倒是干净的）。
 *
 * 坐标只能实测，不能手算：setCursorPosition 收的是相对 live region 的绝对列/行，
 * 而输入框上方还有活动区、常驻状态行、待定正文等高度可变的兄弟节点。measureElement
 * 沿祖先累加偏移，正好是这套坐标；用 useBoxMetrics 反而要自己累加，它给的是
 * 父相对坐标。测量结果落在 state 上，所以布局刚变的那一帧锚点还是旧的（差一帧）。
 *
 * 另外两件必须一起做的事：
 * - 订阅 `animationTick`（全局动画时钟）。Ink 的 useCursor 只在「上报过位置的
 *   那一次提交」里把光标放回这一格，别的组件（spinner、计时）自己重渲的帧会把
 *   光标藏掉且不再放回来 —— 用户看到的就是打字时光标一亮一灭。让锚点跟着动画帧
 *   重新提交，才能保证每一帧都带光标。
 * - 钉住期间把光标形状设成不闪的稳定条（见 cursor-shape.js）：闪烁由终端决定，
 *   Ink 每帧成对写的 `?25l`/`?25h` 还会不断重置它的相位。
 *
 * @param ref 输入行里「文本起点」那个 Box 的 ref（不含 `❯ ` 之类的提示符）
 * @param column 光标距文本起点的列偏移；传 null 表示输入框此刻没有焦点（禁用、
 *   overlay 抢占、正在切模式），此时把光标藏回去，免得它留在原地被 IME 误用
 * @param options.truncate 这一行是 `wrap="truncate"`（picker 的搜索框），
 *   超宽时只会截断而不会折行，锚点得跟着夹在可见范围内
 * @param options.text 光标前实际渲染的文本。提供它后会按字素模拟 Ink 的折行，
 *   尤其处理 CJK 在奇数列宽下无法塞进最后一格的情况；不提供时使用简单列偏移。
 * @param options.rowOffset 额外的行偏移，目前只有一个用途：整屏帧里补回 Ink 差的那一行。
 *   Ink 把「高度不小于终端行数」的帧当整屏处理（末尾不写换行），写完后光标停在最后一行，
 *   但它算锚点时仍按「停在最后一行之后」推：整屏帧里的真实光标恒定高一行，
 *   输入法会把预编辑串画到输入框上面去。常驻 UI 不是整屏帧，所以这个偏移默认为 0。
 */
export function useInputCursor(ref, column, { truncate = false, text = null, rowOffset = 0 } = {}) {
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const [origin, setOrigin] = useState(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const measured = node?.yogaNode ? measureElement(node) : null;
    setOrigin((current) => {
      if (!measured) return current === null ? current : null;
      if (current && current.x === measured.x && current.y === measured.y && current.width === measured.width) {
        return current;
      }
      return { x: measured.x, y: measured.y, width: measured.width };
    });
  });

  const pinned = Boolean(origin && column != null);

  // 订阅而不使用取值：这一行只是「本组件必须跟着动画帧重新提交」。没钉着光标的
  // 输入框（禁用、overlay 抢占）不跟帧，免得白白重渲。
  useStore((state) => (pinned ? state.animationTick : 0));

  useEffect(() => {
    if (!pinned) return undefined;
    writeCursorShape(stdout, STEADY_BAR_CURSOR);
    // 失焦、禁用、overlay 抢占与卸载都走同一条归还路径。
    return () => writeCursorShape(stdout, DEFAULT_CURSOR);
  }, [pinned, stdout]);

  // 在渲染期写、由 useCursor 的 insertion effect 在本次提交里读走：
  // 放进 effect 里写会晚一个提交，光标要等下一次按键才跟上。
  setCursorPosition(pinned ? caretPosition(origin, column, { truncate, text, rowOffset }) : undefined);
}

/**
 * 折行后的锚点：Ink 按格宽折行，文本超过一行宽时光标要跟着落到下一行，
 * 否则长消息打到最后会在第一行末尾显示候选框。列偏移正好落满一行时算作
 * 下一行的第 0 列——终端是延迟折行的，下一个字符确实会落在那里。
 *
 * 折行时按终端字素宽度推进：宽字符无法塞入行尾剩余的一格时，先换行再绘制，
 * 这样连续多行 CJK 文本的锚点不会逐行漂移。
 */
export function caretPosition({ x, y, width }, column, { truncate = false, text = null, rowOffset = 0 } = {}) {
  if (!(width > 0)) return { x: x + column, y: y + rowOffset };
  // 截断行（wrap="truncate"）不会折行，超出可见宽度时锚点就停在最后一个
  // 可见格之后；量到的宽度此时等于截断宽度，所以夹到 width 即可。
  if (truncate) return { x: x + Math.min(column, width), y: y + rowOffset };
  if (typeof text === "string") return wrappedCaretPosition({ x, y, width }, text, rowOffset);
  return { x: x + (column % width), y: y + rowOffset + Math.floor(column / width) };
}

/** 按终端字素宽度折行，返回文本末尾（光标处）的坐标。 */
function wrappedCaretPosition({ x, y, width }, text, rowOffset) {
  let column = 0;
  let row = 0;
  for (const character of [...text]) {
    const characterWidth = stringWidth(character);
    if (characterWidth > 0 && column > 0 && column + characterWidth > width) {
      row += 1;
      column = 0;
    }
    column += characterWidth;
    if (column >= width) {
      row += Math.floor(column / width);
      column %= width;
    }
  }
  return { x: x + column, y: y + rowOffset + row };
}
