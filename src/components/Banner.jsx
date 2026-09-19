import { Box, Text } from "ink";
import process from "node:process";

import { APP_VERSION } from "../config.js";

/** 紧凑启动头：仅保留产品版本和当前目录，让首个输入尽快进入视野。 */
export function Banner() {
  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1} marginTop={1}>
      <Text>
        <Text bold>Miro</Text> <Text dimColor>v{APP_VERSION}</Text>
      </Text>
      <Box flexDirection="row">
        <Text dimColor wrap="truncate-start">
          {process.cwd()}
        </Text>
      </Box>
    </Box>
  );
}
