import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";

import { useInputCursor } from "../hooks/use-input-cursor.js";
import { stringWidth } from "../markdown-width.js";
import { useStore } from "../store.js";

function oneLine(item) {
  return String(item.display ?? item.text ?? "").replace(/\s+/g, " ").trim() || "(empty)";
}

/** 运行中消息队列：查看、原地编辑、删除及重排。 */
export function QueueEditor({ onClose }) {
  const { rows = 24 } = useWindowSize();
  const items = useStore((state) => state.queuedInputs);
  const update = useStore((state) => state.updateQueuedInput);
  const remove = useStore((state) => state.removeQueuedInput);
  const move = useStore((state) => state.moveQueuedInput);
  const clear = useStore((state) => state.clearQueuedInputs);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState(null);
  // 草稿是单行、光标恒在末尾（与 Composer 同理，见 use-input-cursor.js）。
  // draft 为 null 时输入行整块不渲染，ref 拿到 null，光标自然藏回去。
  const draftRowRef = useRef(null);
  useInputCursor(draftRowRef, draft == null ? null : stringWidth(draft));

  useEffect(() => {
    if (items.length === 0) onClose();
    else if (index >= items.length) setIndex(items.length - 1);
  }, [items.length, index, onClose]);

  useInput((input, key) => {
    if (draft != null) {
      if (key.escape) return setDraft(null);
      if (key.return) {
        if (draft.trim()) update(index, draft);
        return setDraft(null);
      }
      if (key.backspace || key.delete) return setDraft((value) => [...value].slice(0, -1).join(""));
      if (key.ctrl || key.meta || !input) return;
      return setDraft((value) => value + input.replace(/[\r\n]+/g, " "));
    }
    if (key.escape || (key.ctrl && input === "q")) return onClose();
    if (key.upArrow && key.shift) {
      move(index, -1);
      return setIndex(Math.max(0, index - 1));
    }
    if (key.downArrow && key.shift) {
      move(index, 1);
      return setIndex(Math.min(items.length - 1, index + 1));
    }
    if (key.upArrow) return setIndex((value) => (value - 1 + items.length) % items.length);
    if (key.downArrow) return setIndex((value) => (value + 1) % items.length);
    if (key.return || input === "e") return setDraft(items[index]?.text ?? "");
    if (input === "d") return remove(index);
    if (input === "x") return clear();
  });

  const maxVisible = Math.max(3, rows - 7);
  const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), items.length - maxVisible));
  return (
    <Box flexDirection="column" height={rows}>
      <Box borderStyle="single" borderLeft={false} borderRight={false} paddingX={1}>
        <Text bold color="cyan">Queued messages</Text><Text dimColor> · {items.length}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {items.slice(start, start + maxVisible).map((item, offset) => {
          const itemIndex = start + offset;
          const active = itemIndex === index;
          return <Text key={itemIndex} color={active ? "cyan" : undefined} bold={active} wrap="truncate-end">{active ? "❯ " : "  "}{itemIndex + 1}. {oneLine(item)}</Text>;
        })}
        {draft != null ? (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text dimColor>Edit message</Text>
            <Box ref={draftRowRef}>
              <Text>{draft}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
      <Box borderStyle="single" borderLeft={false} borderRight={false} paddingX={1}>
        <Text dimColor>{draft != null ? "Enter save · Esc cancel edit" : "↑↓ select · Shift+↑↓ reorder · Enter/e edit · d delete · x clear · Ctrl+Q/Esc close"}</Text>
      </Box>
    </Box>
  );
}
