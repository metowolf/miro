import { Box, Text, useWindowSize } from "ink";
import process from "node:process";

import { currentModelName } from "../acp/model.js";
import { APP_VERSION } from "../config.js";
import { MIRO_LOGO } from "../figures.js";
import { stringWidth } from "../markdown-width.js";
import { useStore } from "../store.js";

const LOGO_WIDTH = Math.max(...MIRO_LOGO.split("\n").map(stringWidth));

/** 三行像素图与启动信息并排；窄终端改为上下排列，避免挤坏图案。 */
export function Banner() {
  const { columns = 80 } = useWindowSize();
  const modelConfig = useStore((state) => state.modelConfig);
  const providerName = useStore((state) => state.providerName);
  const model = modelConfig ? currentModelName(modelConfig) : null;
  const details = [model, providerName].filter(Boolean).join(" · ");
  const stacked = columns < 40;

  return (
    <Box flexDirection={stacked ? "column" : "row"} paddingX={1} marginY={1}>
      <Box width={LOGO_WIDTH} flexShrink={0} marginRight={stacked ? 0 : 2} marginBottom={stacked ? 1 : 0}>
        <Text color="cyan">{MIRO_LOGO}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          <Text bold>Miro</Text> <Text dimColor>v{APP_VERSION}</Text>
        </Text>
        {details ? <Text dimColor wrap="truncate">{details}</Text> : null}
        <Text dimColor wrap="truncate-start">
          {process.cwd()}
        </Text>
      </Box>
    </Box>
  );
}
