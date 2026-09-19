import { useEffect, useState } from "react";

import { acquireAnimationClock } from "../animation-clock.js";
import { sampleSpinnerVerb } from "../spinner-verbs.js";
import { useStore } from "../store.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * spinner 帧：帧号来自全局动画时钟（store.animationTick），不是本组件的 state。
 *
 * 用 store 而不是 useState 是刻意的 —— 只有跟着动画走的东西都在同一次提交里
 * 重渲，Ink 才会把每一帧都当成「带光标锚点」的一帧，输入框里的真实光标才不会
 * 被别的组件的重渲帧藏掉（见 hooks/use-input-cursor.js）。
 *
 * active 为 false 时不订阅时钟：等待用户输入期间不留下任何定时重渲源。
 */
export function useSpinner(active) {
  const tick = useStore((state) => state.animationTick);

  useEffect(() => {
    if (!active) return undefined;
    return acquireAnimationClock();
  }, [active]);

  return FRAMES[tick % FRAMES.length];
}

/**
 * 等待期显示的随机动词。
 *
 * 用 useState 惰性初始化，词在挂载时只抽一次，重渲染不会变，避免文案每帧乱跳。
 * turnKey 变化（新一轮回合）时才重新抽词，这样一轮内保持稳定、跨轮又有新鲜感。
 */
export function useSpinnerVerb(turnKey = null) {
  const [verb, setVerb] = useState(sampleSpinnerVerb);
  const [seenKey, setSeenKey] = useState(turnKey);

  // 渲染期同步换词，避免先用旧词渲染一帧再闪成新词。
  if (turnKey !== seenKey) {
    setSeenKey(turnKey);
    setVerb(sampleSpinnerVerb());
  }

  return verb;
}
