/** Codemode 是编排包装层，只展示其内部实际工具；原始记录仍供回看使用。 */
export function isVisibleTool(tool: any): boolean {
  return tool?.raw?.name !== "codemode" && tool?.name !== "codemode" &&
    tool?.raw?.kind !== "codemode" && tool?.kind !== "codemode" &&
    tool?.label?.name !== "Codemode";
}

export function summarizeToolCategories(items: any[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = String(item.label?.name ?? "Tool").toLowerCase();
    const category = name === "bash"
      ? "commands"
      : `${name}${name.endsWith("s") ? "" : name.endsWith("ch") ? "es" : "s"}`;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(" · ");
}

/** 只投影展示字段，不删除 reviewItems、父子身份或原始工具组。 */
export function toolForDisplay(tool: any): any | null {
  if (!tool?.group) return isVisibleTool(tool) ? tool : null;
  const items = tool.group.items.filter(isVisibleTool);
  if (items.length === 0) return null;
  if (items.length === tool.group.items.length) return tool;
  return {
    ...tool,
    group: {
      ...tool.group,
      name: `${items.length} tool calls`,
      summary: summarizeToolCategories(items),
      count: items.length,
      items,
    },
  };
}
