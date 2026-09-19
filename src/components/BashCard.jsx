import { Box, Text } from "ink";

import { previewBashLines } from "../bash.js";
import { BASH_PREVIEW_LINES, DYNAMIC_BASH_PREVIEW_LINES } from "../config.js";

export function BashCard({ card }) {
  const { command, lines, status } = card;
  // 已保存的旧会话仍可能带三个分散字段；只在展示边界兼容它们。
  const outcome = card.outcome ?? (
    card.timedOut
      ? { type: "timed_out" }
      : card.interrupted
        ? { type: "cancelled" }
        : card.exitCode != null
          ? { type: "exited", code: card.exitCode }
          : Object.hasOwn(card, "exitCode")
            ? { type: "spawn_failed" }
            : null
  );
  const running = status === "running";
  const finalized = card.hidden != null;
  const { visible, hidden } = finalized
    ? { visible: lines, hidden: card.hidden }
    : previewBashLines(lines, false, DYNAMIC_BASH_PREVIEW_LINES);

  const statusParts = [];
  if (!running) {
    if (hidden > 0) {
      statusParts.push({
        text: finalized
          ? `... ${hidden} more lines`
          : `... ${hidden} more lines (ctrl+o to review)`,
      });
    }
    if (outcome?.type === "timed_out") statusParts.push({ color: "red", text: "(timed out)" });
    else if (outcome?.type === "cancelled") statusParts.push({ color: "yellow", text: "(cancelled)" });
    else if (outcome?.type === "signaled")
      statusParts.push({ color: "red", text: `(signal ${outcome.signal})` });
    else if (outcome?.type === "exited" && outcome.code !== 0)
      statusParts.push({ color: "red", text: `(exit ${outcome.code})` });
    else if (outcome?.type === "spawn_failed")
      statusParts.push({ color: "red", text: "(failed to start)" });
  }

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle="single"
      borderColor="magenta"
      borderLeft={false}
      borderRight={false}
    >
      <Text bold color="magenta">
        $ {command}
      </Text>
      {running ? (
        <Text dimColor>Running… (esc to cancel)</Text>
      ) : (
        visible.map((line, index) => (
          <Text key={index} dimColor color={line.err ? "yellow" : undefined}>
            {line.text.length > 0 ? line.text : " "}
          </Text>
        ))
      )}
      {statusParts.length > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            {statusParts.map((part, index) => (
              <Text key={index} color={part.color}>
                {index > 0 ? " " : ""}
                {part.text}
              </Text>
            ))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
