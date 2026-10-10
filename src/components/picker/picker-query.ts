/** 查询与候选绑定；新查询尚未返回时不能沿用上一批候选。 */
export function pickerQueryState(result, key) {
  if (key == null) return { items: [], pending: false };
  if (result?.key === key) return { items: result.items, pending: false };
  return { items: [], pending: true };
}

/** 请求取消后，即使异步读取已经开始，也不能再发布结果。 */
export function createPickerRequest(key, publish) {
  let cancelled = false;
  return {
    resolve(items) {
      if (!cancelled) publish({ key, items });
    },
    cancel() {
      cancelled = true;
    },
  };
}
