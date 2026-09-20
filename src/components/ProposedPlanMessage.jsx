import { Box, Text } from "ink";

import { BLACK_CIRCLE } from "../figures.js";
import { renderMarkdown } from "../markdown.js";

export function ProposedPlanMessage({ block }) {
  return (
    <Box flexDirection="column" marginTop={block.head ? 1 : 0} borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{BLACK_CIRCLE} Approved Plan</Text>
      <Text>{renderMarkdown(block.text)}</Text>
      {block.planPath ? <Text dimColor>Saved at {block.planPath}</Text> : null}
    </Box>
  );
}
