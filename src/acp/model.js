/** 从 ACP configOptions 提取 model / effort。 */

function configFrom(configOptions, category, fallbackId) {
  if (!Array.isArray(configOptions)) return null;

  const selects = configOptions.filter((option) => option?.type === "select");
  return (
    selects.find((option) => option.category === category) ??
    selects.find((option) => option.id?.toLowerCase() === fallbackId) ??
    selects.find((option) => option.name?.toLowerCase() === fallbackId) ??
    null
  );
}

export function modelConfigFrom(configOptions) {
  return configFrom(configOptions, "model", "model");
}

export function effortConfigFrom(configOptions) {
  return configFrom(configOptions, "thought_level", "reasoning_effort");
}

export function thinkingConfigFrom(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((option) => option?.id === "enable_thinking") ?? null;
}

/** 当前 options 里可用来打开 thinking 的值；没有 On/true 则返回 null。 */
export function thinkingOnValue(config) {
  const on = selectChoices(config).find((choice) => {
    if (choice.value === true || String(choice.value).toLowerCase() === "true") return true;
    return String(choice.name ?? "").toLowerCase() === "on";
  });
  return on == null ? null : on.value;
}

function selectChoices(config) {
  if (!config) return [];
  const choices = [];

  for (const entry of config.options ?? []) {
    if (Array.isArray(entry?.options)) {
      for (const option of entry.options) {
        choices.push({
          ...option,
          groupName: entry.name ?? entry.group ?? "",
          current: option.value === config.currentValue,
        });
      }
      continue;
    }

    if (entry?.value != null) {
      choices.push({
        ...entry,
        groupName: "",
        current: entry.value === config.currentValue,
      });
    }
  }

  return choices;
}

export function modelChoices(config) {
  return selectChoices(config).sort((a, b) =>
    String(a.name ?? a.value)
      .toLowerCase()
      .localeCompare(String(b.name ?? b.value).toLowerCase())
  );
}

export function effortChoices(config) {
  return selectChoices(config);
}

export function configChoices(config) {
  return selectChoices(config);
}

export function currentModelName(config) {
  const current = modelChoices(config).find((choice) => choice.current);
  return current?.name ?? config?.currentValue ?? "default";
}

/** currentValue 为空时返回 null。 */
export function currentEffortName(config) {
  if (!config || config.currentValue == null || config.currentValue === "") return null;
  const current = effortChoices(config).find((choice) => choice.current);
  return current?.name ?? config.currentValue;
}
