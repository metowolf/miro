/**
 * 通用多步选择流程（provider → model、model → effort、config 项 → 值）。
 *
 * 状态机做成纯函数：step 推进、context 累积、Esc 回退都可直接单测，
 * 组件只负责把它接到 Picker 上。
 *
 * step 形如：
 *   {
 *     key: "model",                        // context 中的键
 *     title: "Select model" | (ctx) => …,
 *     subtitle, emptyText, searchable,     // 可为值或 (ctx) => …
 *     items: (ctx) => PickerItem[],
 *     preselect: (ctx) => number | null,
 *     skip: (ctx) => boolean,              // 为 true 时自动跳过该步
 *   }
 */

/** 值或 (context) => 值。 */
function resolveField(field, context) {
  return typeof field === "function" ? field(context) : field;
}

export function createFlowState(steps, initialContext = {}) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  return advancePastSkipped({ steps: list, index: 0, context: { ...initialContext }, done: false }, 1);
}

/**
 * 按 direction 跳过所有 skip 为真的步骤。
 * 前进越界即完成；后退越界则停在首个可用步骤。
 */
function advancePastSkipped(state, direction) {
  const { steps, context } = state;
  let index = state.index;

  while (index >= 0 && index < steps.length) {
    const step = steps[index];
    if (!resolveField(step.skip, context)) return { ...state, index, done: false };
    index += direction;
  }

  if (index >= steps.length) return { ...state, index: steps.length, done: true };

  // 后退时越过了首步：回到最靠前的未跳过步骤。
  let forward = 0;
  while (forward < steps.length && resolveField(steps[forward].skip, context)) forward += 1;
  if (forward >= steps.length) return { ...state, index: steps.length, done: true };
  return { ...state, index: forward, done: false };
}

export function currentStep(state) {
  if (state.done) return null;
  return state.steps[state.index] ?? null;
}

/** 当前步骤解析后的展示参数。 */
export function stepView(state) {
  const step = currentStep(state);
  if (!step) return null;
  const { context } = state;
  return {
    key: step.key,
    title: resolveField(step.title, context) ?? "",
    subtitle: resolveField(step.subtitle, context) ?? undefined,
    emptyText: resolveField(step.emptyText, context) ?? undefined,
    searchable: resolveField(step.searchable, context) ?? true,
    items: resolveField(step.items, context) ?? [],
    selected: resolveField(step.preselect, context) ?? null,
    // 非首个可见步骤才允许回退；据此让底部提示显示 “Esc to go back”。
    canGoBack: hasPreviousStep(state),
  };
}

/** 当前步骤之前是否还有未跳过的步骤。 */
export function hasPreviousStep(state) {
  for (let index = state.index - 1; index >= 0; index -= 1) {
    if (!resolveField(state.steps[index].skip, state.context)) return true;
  }
  return false;
}

/** 选中当前步骤的值，写入 context 并前进；越界则 done。 */
export function selectValue(state, value) {
  const step = currentStep(state);
  if (!step) return state;
  const context = { ...state.context, [step.key]: value };
  return advancePastSkipped({ ...state, context, index: state.index + 1 }, 1);
}

/**
 * 回退一步：删掉该步已写入的 key，避免上一步的选择被下一步的旧值污染。
 * 已在首步时返回 null，交由调用方取消整个流程。
 */
export function goBack(state) {
  if (!hasPreviousStep(state)) return null;
  const previous = advancePastSkipped({ ...state, index: state.index - 1, done: false }, -1);
  const step = previous.steps[previous.index];
  if (!step) return null;
  const context = { ...previous.context };
  delete context[step.key];
  return { ...previous, context };
}
