import { Box, Text } from "ink";

import { useSpinner } from "../hooks/use-spinner.js";
import { DEFAULT_STATUS_LINE_ITEMS } from "../settings-file.js";
import { goalIndicator } from "../status-line/goal-indicator.js";
import { STATUS_LINE_SEPARATOR, buildStatusLineSegments } from "../status-line/render.js";

export function StatusBar({
  status,
  connectionStage,
  agentBin,
  busy,
  cancelling,
  switching,
  exitConfirming,
  statusLineItems,
  statusLineUseColors = true,
  statusLineSnapshot = null,
  goal = null,
  hidden = false,
}) {
  const connecting = status === "connecting";
  const spinner = useSpinner(connecting || switching != null);

  let content;
  if (exitConfirming) {
    content = <Text color="yellow">Press Ctrl+C again to exit</Text>;
  } else if (switching) {
    content = (
      <Text color="cyan">
        {spinner} {switching}
      </Text>
    );
  } else if (connecting) {
    content = (
      <Text color="cyan">
        {spinner} {connectionStage ?? `Connecting to ${agentBin} ACP…`}
      </Text>
    );
  } else if (status === "failed") {
    content = <Text color="red">Disconnected · restart miro to retry · Ctrl+C twice to exit</Text>;
  } else if (cancelling) {
    content = <Text color="yellow">Interrupting…</Text>;
  } else if (hidden) {
    return null;
  } else {
    // 稳定态统一走配置化状态栏；未提供配置时用默认项，空数组表示隐藏。
    const { segments } = buildStatusLineSegments(
      statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS,
      statusLineSnapshot ?? {},
      { useColors: statusLineUseColors }
    );
    if (segments.length === 0) return null;

    // 有目标时右侧常驻一个 `◎ /goal active (4s)`：目标跨多个回合，用户需要的
    // 是「现在还在跑、跑了多久」这一个读数，而不是去翻 transcript。
    //
    // 右侧项不跟着 busy 变暗：目标绝大多数时间就在 busy 期间推进，把它压成
    // 灰色等于最该看见的时候看不见。左侧仍然是整行留给状态项的剩余宽度，
    // 目标文字不参与收缩，宁可压缩状态项也不挤掉它。
    const indicator = goalIndicator(goal, { useColors: statusLineUseColors });

    return (
      <Box paddingX={1} justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate">
            {segments.map((segment, index) => (
              <Text key={segment.id}>
                {index > 0 ? <Text dimColor>{STATUS_LINE_SEPARATOR}</Text> : null}
                <Text
                  color={busy || segment.color == null ? undefined : segment.color}
                  dimColor={busy || segment.dim}
                >
                  {segment.text}
                </Text>
              </Text>
            ))}
          </Text>
        </Box>
        {indicator ? (
          <Box flexShrink={0} marginLeft={2}>
            <Text color={indicator.color} dimColor={indicator.dim} wrap="truncate">
              {indicator.text}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text wrap="truncate">{content}</Text>
    </Box>
  );
}
