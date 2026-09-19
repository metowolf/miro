import { Box, Text, useStdout } from "ink";

import { buildSetupItems, buildPreviewSegments } from "../status-line/setup-items.js";
import { MultiSelectPicker } from "./MultiSelectPicker.jsx";

export function StatusLineSetup({ configuredIds, useColors, snapshot, onConfirm, onCancel }) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const items = buildSetupItems(configuredIds, useColors);

  return (
    <Box flexDirection="column" paddingX={1}>
      <MultiSelectPicker
        title="Configure Status Line"
        subtitle="Select which items to display in the status line."
        items={items}
        columns={columns}
        renderPreview={(nextItems, options) =>
          buildPreviewSegments(nextItems, snapshot, { useColors: options?.useColors ?? useColors })}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </Box>
  );
}
