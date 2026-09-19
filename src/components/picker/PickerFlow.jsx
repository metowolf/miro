import { useEffect, useState } from "react";

import { Picker } from "./Picker.jsx";
import { createFlowState, goBack, selectValue, stepView } from "./picker-flow.js";

/**
 * 多步 picker：把 picker-flow 状态机接到通用 Picker 上。
 *
 * 全部步骤走完才调 onComplete，中途不产生任何副作用——
 * 因此用户在第二步按 Esc 回到第一步时，第一步的选择尚未被应用。
 */
export function PickerFlow({ steps, initialContext, color = "cyan", onComplete, onCancel }) {
  const [state, setState] = useState(() => createFlowState(steps, initialContext));

  const view = stepView(state);
  const finished = view == null;

  // 所有步骤都被 skip（或 steps 为空）时立刻交付结果。
  // 放在 effect 中而非渲染期，避免在渲染阶段触发外部状态更新。
  useEffect(() => {
    if (finished) onComplete?.(state.context);
  }, [finished]);

  if (finished) return null;

  const handleSelect = (item) => {
    const next = selectValue(state, item?.value ?? null);
    if (next.done) {
      onComplete?.(next.context);
      return;
    }
    setState(next);
  };

  const handleCancel = () => {
    const previous = goBack(state);
    if (previous == null) {
      onCancel?.();
      return;
    }
    setState(previous);
  };

  return (
    <Picker
      // key 让每一步都重建 Picker，从而重置查询串与选中下标。
      key={view.key}
      title={view.title}
      subtitle={view.subtitle}
      items={view.items}
      selected={view.selected}
      color={color}
      searchable={view.searchable}
      emptyText={view.emptyText}
      canGoBack={view.canGoBack}
      onSelect={handleSelect}
      onCancel={handleCancel}
    />
  );
}
