import { useStore } from "./store.js";

/** 动画帧间隔：与 useSpinner 原来的默认值一致，spinner 转速不变。 */
export const ANIMATION_FRAME_MS = 100;

let subscribers = 0;
let timer = null;

/**
 * 全局动画时钟：整个进程只有一个 interval，推进 `store.animationTick`。
 *
 * 每个动画各自 setInterval 会带来两个问题：同一屏上同时有动画时帧率翻倍，
 * 更重要的是各动画落在不同的提交里 —— 而 Ink 的真实光标只在「上报过位置的
 * 那次提交」里回到输入格，于是每一帧都会把光标藏掉再补回来（输入时光标一闪
 * 一灭）。收成一个时钟后，动画与光标锚点必然同帧（见 hooks/use-input-cursor.js）。
 *
 * 返回 release 函数，可以重复调用；最后一个订阅者离开时停表，空闲时不空转。
 */
export function acquireAnimationClock() {
  subscribers += 1;
  if (timer == null) {
    timer = setInterval(() => useStore.getState().bumpAnimationTick(), ANIMATION_FRAME_MS);
    // 动画不该成为「进程为什么还活着」的答案：TUI 存活靠 stdin，测试里靠用例本身。
    if (typeof timer.unref === "function") timer.unref();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers -= 1;
    if (subscribers > 0 || timer == null) return;
    clearInterval(timer);
    timer = null;
    subscribers = 0;
  };
}

/** 当前是否有动画在跑。测试用，避免直接读模块级 timer。 */
export function isAnimationClockRunning() {
  return timer != null;
}
