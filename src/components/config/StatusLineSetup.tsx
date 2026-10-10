import { Box, Text, useStdout } from "ink";

import { buildSetupItems, buildPreviewSegments } from "../../status-line/setup-items.ts";
import { MultiSelectPicker } from "../picker/MultiSelectPicker.tsx";

export function StatusLineSetup({ configuredIds, useColors, snapshot, onConfirm, onCancel }: any) {
  const { stdout } = useStdout();
  const columns = (stdout as import("../../terminal/types.ts").TerminalOutput)?.columns ?? 80;
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
