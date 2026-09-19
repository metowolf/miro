import { Box } from "ink";
import { useState } from "react";

import {
  configDisplayValue,
  isConfigOptionLocked,
  toggleConfigValue,
} from "../acp/config-options.js";
import { configChoices } from "../acp/model.js";
import { Picker } from "./picker/Picker.jsx";

/**
 * /config 面板。普通项是两级；Tools 先进入工具列表，二值工具在该层直接切换。
 * 因此边框、选中标记、搜索、滚动提示与其它 picker 完全一致。
 *
 * 与 PickerFlow 的区别：改完一项后仍留在面板里继续调其它项，
 * 不是「走完即关闭」的向导，故不套用 picker-flow。
 */
export function ConfigPanel({
  options = [],
  focusId = null,
  switching = null,
  onChange,
  onCancel,
}) {
  // 正在选值的选项 id；为 null 表示停在选项列表这一级。
  const [pickingId, setPickingId] = useState(null);

  const listed = options.filter((option) => option?.id);
  const picking = pickingId ? listed.find((option) => option.id === pickingId) : null;
  const valueOption = picking;

  const valuePicker = valueOption && picking?.type !== "tools" ? (
    <Picker
      key={`config-value-${valueOption.id}`}
      title={valueOption.name ?? valueOption.id}
      items={configChoices(valueOption).map((choice) => ({
        value: choice.value,
        label: choice.groupName
          ? `${choice.groupName} / ${choice.name ?? choice.value}`
          : String(choice.name ?? choice.value),
        current: Boolean(choice.current),
      }))}
      emptyText="No matching values"
      // 取值一级由选项一级进入，Esc 语义是回退而非关闭整个面板。
      canGoBack
      onSelect={(item) => {
        setPickingId(null);
        if (item?.value != null && item.value !== valueOption.currentValue) {
          onChange?.(valueOption, item.value);
        }
      }}
      onCancel={() => setPickingId(null)}
    />
  ) : null;

  const toolsPicker = picking?.type === "tools" ? (
    <Picker
      key="config-tools"
      title="Tools"
      items={(picking.tools ?? []).map((tool) => ({
        value: tool.id,
        label: tool.name ?? tool.id,
        right: configDisplayValue(tool),
        description: configDisplayValue(tool),
        disabled: isConfigOptionLocked(tool),
      }))}
      emptyText="No tools available"
      canGoBack
      // 工具是二值开关；在工具列表按 Enter 即切换，不再多进一层 picker。
      onSelect={(item) => {
        const tool = (picking.tools ?? []).find((entry) => entry.id === item?.value);
        const next = toggleConfigValue(tool);
        if (next != null && next !== tool?.currentValue) onChange?.(tool, next);
      }}
      onCancel={() => setPickingId(null)}
    />
  ) : null;

  /**
   * 恰好两个可选值时直接切换，不再多一级面板；
   * 只有一个值时该行已置灰，走不到这里。
   */
  const activate = (option) => {
    if (switching || !option || (option.type !== "tools" && isConfigOptionLocked(option))) return;
    if (option.type === "tools") {
      setPickingId(option.id);
      return;
    }
    const choices = configChoices(option);
    if (choices.length === 2) {
      const next = toggleConfigValue(option);
      if (next != null && next !== option.currentValue) onChange?.(option, next);
      return;
    }
    setPickingId(option.id);
  };

  return (
    <>
      {/* 选项一级始终保持挂载：下钻时只隐藏布局，回退后查询串与选中行原样保留。 */}
      <Box display={picking ? "none" : "flex"} flexDirection="column">
        <Picker
          title="Config"
          subtitle={switching || undefined}
          // 下钻时本级隐藏，按键交给取值一级。
          active={!picking}
          items={listed.map((option) => {
            const display = configDisplayValue(option);
            return {
              value: option.id,
              label: option.name ?? option.id,
              right: display,
              // right 不参与匹配，把当前值与类别写进参与搜索的字段，
              // 否则按行上可见的当前值（如 Fast）搜索会无结果。
              description: [option.category ?? "", display].filter(Boolean).join(" "),
              // 可选值不足两项时无法切换，整行置灰并跳过导航。
              disabled: option.type !== "tools" && isConfigOptionLocked(option),
            };
          })}
          selected={
            focusId == null ? null : Math.max(0, listed.findIndex((option) => option.id === focusId))
          }
          emptyText="No matching settings"
          onSelect={(item) => activate(listed.find((option) => option.id === item?.value))}
          onCancel={() => onCancel?.()}
        />
      </Box>
      {toolsPicker}
      {valuePicker}
    </>
  );
}
