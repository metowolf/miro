import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import { useInputCursor } from "../hooks/use-input-cursor.js";
import { stringWidth } from "../markdown-width.js";

const PROMPT = "> ";

export function InputPrompt({ title, value = "", hint = "Enter to save · Esc to go back", secret = false, onSubmit, onCancel }) {
  const [text, setText] = useState(value);
  // 单行输入、光标恒在末尾；真实光标的定位见 use-input-cursor.js。
  const lineRef = useRef(null);
  useInputCursor(lineRef, stringWidth(PROMPT + text));

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSubmit(text);
    if (key.backspace || key.delete) return setText((current) => [...current].slice(0, -1).join(""));
    if (input) setText((current) => current + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      <Box ref={lineRef}>
        <Text>{PROMPT + (secret ? "•".repeat([...text].length) : text)}</Text>
      </Box>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
