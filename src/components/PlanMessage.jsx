import { Box, Text } from "ink";

import { PLAN_MAX_ROWS } from "../config.js";
import { BLACK_CIRCLE, TREE_BLANK_PREFIX, TREE_LAST_PREFIX } from "../figures.js";

function rowProps(status) {
  if (status === "completed") return { box: "☒", style: { dimColor: true, strikethrough: true } };
  if (status === "in_progress") return { box: "☐", style: { bold: true, color: "cyan" } };
  return { box: "☐", style: {} };
}

export function PlanMessage({ block }) {
  const entries = Array.isArray(block.plan?.entries) ? block.plan.entries : [];
  const visible = entries.slice(0, PLAN_MAX_ROWS);
  const omitted = entries.length - visible.length;

  return (
    <Box flexDirection="column" marginTop={block.head ? 1 : 0}>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color="green">{BLACK_CIRCLE}</Text>
        </Box>
        <Text bold>Update Todos</Text>
      </Box>
      {visible.map((entry, index) => {
        const props = rowProps(entry?.status);
        return (
          <Box key={index} flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text dimColor>{index === 0 ? TREE_LAST_PREFIX : TREE_BLANK_PREFIX}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="truncate-end" {...props.style}>
                {`${props.box} ${entry?.content ?? ""}`}
              </Text>
            </Box>
          </Box>
        );
      })}
      {omitted > 0 ? (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text dimColor>{TREE_BLANK_PREFIX}</Text>
          </Box>
          <Text dimColor>… +{omitted} more</Text>
        </Box>
      ) : null}
    </Box>
  );
}
