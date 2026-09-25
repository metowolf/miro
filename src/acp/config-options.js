import { configChoices } from "./model.js";

export function listedConfigOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.filter((option) => option?.id);
}

export function configDisplayValue(option) {
  const current = configChoices(option).find((choice) => choice.current);
  if (current) return String(current.name ?? current.value);
  if (option?.currentValue == null || option.currentValue === "") return "default";
  return String(option.currentValue);
}

export function matchConfigOption(options, query) {
  const listed = listedConfigOptions(options);
  if (query == null || query === "") return null;
  const lower = String(query).toLowerCase();
  return (
    listed.find((option) => option.id === query) ??
    listed.find((option) => String(option.id).toLowerCase() === lower) ??
    listed.find((option) => String(option.name ?? "").toLowerCase() === lower) ??
    null
  );
}

export function matchConfigChoice(option, query) {
  const choices = configChoices(option);
  if (query == null || query === "") return null;
  const lower = String(query).toLowerCase();
  return (
    choices.find((choice) => choice.value === query) ??
    choices.find((choice) => String(choice.value).toLowerCase() === lower) ??
    choices.find((choice) => String(choice.name ?? "").toLowerCase() === lower) ??
    choices.find((choice) => choice.id != null && String(choice.id) === query) ??
    choices.find((choice) => choice.id != null && String(choice.id).toLowerCase() === lower) ??
    null
  );
}

/** 恰好两项时返回另一项的 value，否则 null。 */
export function toggleConfigValue(option) {
  const choices = configChoices(option);
  if (choices.length !== 2) return null;
  const other = choices.find((choice) => choice.value !== option.currentValue);
  return other?.value ?? null;
}

/** 可选值不足两项时无法切换，界面上按不可用处理（置灰）。 */
export function isConfigOptionLocked(option) {
  return configChoices(option).length < 2;
}
