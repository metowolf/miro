import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

import { generateCommandSuggestions, SLASH_COMMANDS } from "../commands.js";
import { isBashInput } from "../bash.js";
import {
  cursorColumn,
  cursorText,
  deleteAfterCursor,
  deleteBeforeCursor,
  expandPasteMarkers,
  insertPastedText,
  normalizePastedText,
  pruneOrphanPastes,
  segmentInput,
  shouldCollapsePaste,
  stepCursor,
} from "../paste-block.js";
import { useInputCursor } from "../hooks/use-input-cursor.js";
import {
  applyFileSuggestion,
  applyPathSuggestion,
  extractAtToken,
  extractPathToken,
  generateBashSuggestions,
  generateFileSuggestions,
} from "../file-suggestions.js";
import { cloneInputSnapshot, getInputHistory } from "../input-history.js";

const MAX_VISIBLE_FILE_SUGGESTIONS = 8;
/** 命令候选按总行数限高，避免描述长短导致高度跳动。 */
const COMMAND_SUGGESTION_LINES = 10;
const COMMAND_DESCRIPTION_LINES = 2;
const MIN_DESCRIPTION_WIDTH = 20;
const FILE_SUGGESTION_DEBOUNCE_MS = 50;

/** 保证选中项在窗口内且尽量居中。 */
function windowStart(index, total, size) {
  if (total <= size) return 0;
  return Math.max(0, Math.min(index - Math.floor(size / 2), total - size));
}

/** 按宽度折行，最多 maxLines 行。 */
function wrapDescription(text, width, maxLines) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source || width <= 0) return [];
  const lines = [];
  let line = "";
  for (const word of source.split(" ")) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
    if (lines.length > maxLines) break;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] =
    last.length < width ? `${last}…` : `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  return kept;
}

/** 以选中项为中心在行数预算内挑可见条目。 */
function packRows(costs, activeIndex, budget) {
  if (costs.length === 0) return { start: 0, end: -1, used: 0 };
  let start = Math.min(Math.max(activeIndex, 0), costs.length - 1);
  let end = start;
  let used = costs[start];
  let down = true;
  for (;;) {
    const canDown = end + 1 < costs.length && used + costs[end + 1] <= budget;
    const canUp = start > 0 && used + costs[start - 1] <= budget;
    if (!canDown && !canUp) break;
    if (down ? canDown : !canUp) used += costs[(end += 1)];
    else used += costs[(start -= 1)];
    down = !down;
  }
  return { start, end, used };
}

/** 空输入时按 ? 展开的快捷键速查，替代输入框内的占位提示。 */
function ShortcutHelp() {
  return (
    <Box paddingX={1} gap={2}>
      <Box flexDirection="column" width={22}>
        <Text dimColor>! for shell mode</Text>
        <Text dimColor>/ for commands</Text>
        <Text dimColor>@ for file paths</Text>
      </Box>
      <Box flexDirection="column" width={32}>
        <Text dimColor>shift + tab to cycle mode</Text>
        <Text dimColor>ctrl + m to switch model</Text>
        <Text dimColor>ctrl + o to review</Text>
        <Text dimColor>ctrl + q to review queue</Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>ctrl + l to clear screen</Text>
        <Text dimColor>ctrl + c to clear input, then to interrupt</Text>
        <Text dimColor>esc to cancel</Text>
        <Text dimColor>↑/↓ for history</Text>
      </Box>
    </Box>
  );
}

export function Composer({
  disabled,
  locked = false,
  onSubmit,
  onCycleMode,
  providerCommands = [],
  inputHistory = null,
  helpOpen = false,
  onHelpOpenChange,
  sessionKey = null,
  initialSnapshot = null,
  onSnapshotChange,
  controlsRef = null,
}) {
  const { stdout } = useStdout();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [fileSuggestions, setFileSuggestions] = useState([]);

  const historyRef = useRef(inputHistory ?? getInputHistory());
  const onSnapshotChangeRef = useRef(onSnapshotChange);
  onSnapshotChangeRef.current = onSnapshotChange;
  const restoredSessionKeyRef = useRef(Symbol("uninitialized-session"));

  const [pastes, setPastes] = useState(() => new Map());
  const nextPasteIdRef = useRef(1);
  const pastesRef = useRef(pastes);
  pastesRef.current = pastes;
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const chars = [...value];
  const cursorPos = chars.slice(0, cursor).join("").length;
  /**
   * 正在浏览历史时抑制自动弹窗：否则回填出 "/model" 之类的条目会重新弹出
   * 命令列表，而列表会吞掉后续的上键，导致卡在列表里无法继续往上翻历史。
   */
  const browsingHistory = historyRef.current.isBrowsing(value, cursor);
  const fileToken = disabled || browsingHistory ? null : extractAtToken(value, cursorPos);

  const isBashMode = !disabled && isBashInput(value);
  const [bashPathActive, setBashPathActive] = useState(false);
  const [pathSuggestions, setPathSuggestions] = useState([]);
  const pathToken = isBashMode && bashPathActive ? extractPathToken(value, cursorPos) : null;

  useEffect(() => {
    if (!isBashMode && bashPathActive) {
      setBashPathActive(false);
      setPathSuggestions([]);
    }
  }, [isBashMode, bashPathActive]);

  const pathFetchSeq = useRef(0);
  const pathTokenKey = pathToken ? `${pathToken.startPos}:${pathToken.query}` : null;
  useEffect(() => {
    if (pathTokenKey == null) {
      setPathSuggestions([]);
      return;
    }
    const seq = ++pathFetchSeq.current;
    const timer = setTimeout(() => {
      generateBashSuggestions(value, pathToken).then((items) => {
        if (pathFetchSeq.current === seq) setPathSuggestions(items);
      });
    }, FILE_SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathTokenKey]);

  const fetchSeq = useRef(0);
  const tokenKey = fileToken ? `${fileToken.startPos}:${fileToken.query}` : null;
  useEffect(() => {
    if (!tokenKey) {
      setFileSuggestions([]);
      return;
    }
    const seq = ++fetchSeq.current;
    const query = tokenKey.slice(tokenKey.indexOf(":") + 1);
    const timer = setTimeout(() => {
      generateFileSuggestions(query).then((items) => {
        if (fetchSeq.current === seq) setFileSuggestions(items);
      });
    }, FILE_SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tokenKey]);

  const isFileMode = Boolean(fileToken);
  const isPathMode = !isFileMode && Boolean(pathToken);
  const localNames = new Set(SLASH_COMMANDS.map((cmd) => cmd.name));
  const allCommands = [
    ...SLASH_COMMANDS,
    ...providerCommands
      .filter((cmd) => cmd?.name && !localNames.has(cmd.name))
      .map((cmd) => ({
        name: cmd.name,
        aliases: [],
        description: `${cmd.description ?? ""}${cmd.input?.hint ? ` (${cmd.input.hint})` : ""} [provider]`.trim(),
      })),
  ];
  const commandSuggestions =
    dismissed || disabled || isFileMode || isPathMode || browsingHistory
      ? []
      : generateCommandSuggestions(value, allCommands);
  const activeSuggestions = dismissed || disabled
    ? []
    : isFileMode
      ? fileSuggestions
      : isPathMode
        ? pathSuggestions
        : commandSuggestions;
  const showSuggestions = activeSuggestions.length > 0;
  const activeIndex = Math.min(selectedIndex, Math.max(0, activeSuggestions.length - 1));

  const currentSnapshot = () =>
    cloneInputSnapshot({
      value: valueRef.current,
      cursor: cursorRef.current,
      pastes: pastesRef.current,
      nextPasteId: nextPasteIdRef.current,
    });

  const notifySnapshotChange = () => onSnapshotChangeRef.current?.(currentSnapshot());

  const replace = (nextChars, nextCursor) => {
    const nextValue = nextChars.join("");
    const clampedCursor = Math.max(0, Math.min(nextChars.length, nextCursor));
    valueRef.current = nextValue;
    cursorRef.current = clampedCursor;
    setValue(nextValue);
    setCursor(clampedCursor);
    setSelectedIndex(0);
    setDismissed(false);
    const pruned = pruneOrphanPastes(nextValue, pastesRef.current);
    if (pruned !== pastesRef.current) {
      pastesRef.current = pruned;
      setPastes(pruned);
    }
    notifySnapshotChange();
  };

  const restoreSnapshot = (snapshot, { notify = true, resetHistory = false } = {}) => {
    const restored = cloneInputSnapshot(snapshot ?? { value: "" });
    valueRef.current = restored.value;
    cursorRef.current = restored.cursor;
    pastesRef.current = restored.pastes;
    nextPasteIdRef.current = restored.nextPasteId;
    setValue(restored.value);
    setCursor(restored.cursor);
    setPastes(restored.pastes);
    setSelectedIndex(0);
    setDismissed(false);
    setFileSuggestions([]);
    setBashPathActive(false);
    setPathSuggestions([]);
    if (resetHistory) historyRef.current.resetNavigation();
    if (notify) notifySnapshotChange();
  };

  useEffect(() => {
    if (restoredSessionKeyRef.current === sessionKey) return;
    restoredSessionKeyRef.current = sessionKey;
    restoreSnapshot(initialSnapshot, { notify: false, resetHistory: true });
    // 草稿只在会话身份变化时恢复；普通重渲染不能覆盖用户正在输入的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  /** 清空输入框的全部可见与隐藏状态（粘贴表必须一起丢，否则只剩孤立标记的 registry）。 */
  const resetDraft = () => {
    valueRef.current = "";
    cursorRef.current = 0;
    setValue("");
    setCursor(0);
    setSelectedIndex(0);
    setDismissed(false);
    setFileSuggestions([]);
    setBashPathActive(false);
    setPathSuggestions([]);
    pastesRef.current = new Map();
    setPastes(pastesRef.current);
    nextPasteIdRef.current = 1;
  };

  const hasDraft = () => valueRef.current !== "" || pastesRef.current.size > 0;

  /**
   * App 的 Ctrl+C 靠这个命令式入口丢弃草稿：判空与清空都得落在 Composer 自己持有的
   * 最新文本上（App 只有滞后快照，拿它判空会把刚敲的字当成空输入框）。
   * 返回值就是「输入框为空」的判据——没东西可丢时 Ctrl+C 才轮到中断与退出确认。
   */
  const clearDraft = () => {
    if (!hasDraft()) return false;
    historyRef.current.resetNavigation();
    resetDraft();
    // 必须通知：落盘的 ui_state 是恢复草稿的来源，不写就等于被清掉的草稿在 /resume 时复活。
    notifySnapshotChange();
    return true;
  };

  if (controlsRef) controlsRef.current = { hasDraft, clearDraft };

  const submit = (text) => {
    const display = String(text ?? "");
    const submittedPastes = pruneOrphanPastes(display, pastesRef.current);
    historyRef.current.record({
      value: display,
      cursor: [...display].length,
      pastes: submittedPastes,
      nextPasteId: nextPasteIdRef.current,
    });
    const expanded = expandPasteMarkers(display, submittedPastes);
    resetDraft();
    notifySnapshotChange();
    onSubmit(expanded, expanded === display ? undefined : display);
  };

  const applyActiveFileSuggestion = () => {
    const suggestion = activeSuggestions[activeIndex];
    const { nextChars, nextCursor } = applyFileSuggestion(chars, fileToken, suggestion);
    if (!suggestion.isDirectory) setFileSuggestions([]);
    replace(nextChars, nextCursor);
  };

  const applyActivePathSuggestion = () => {
    const suggestion = activeSuggestions[activeIndex];
    const { nextChars, nextCursor } = applyPathSuggestion(chars, pathToken, suggestion);
    if (!suggestion.isDirectory) {
      setBashPathActive(false);
      setPathSuggestions([]);
    }
    replace(nextChars, nextCursor);
  };

  const triggerBashPathCompletion = () => {
    const currentValue = valueRef.current;
    const currentChars = [...currentValue];
    const currentCursor = Math.max(0, Math.min(currentChars.length, cursorRef.current));
    const currentCursorPos = currentChars.slice(0, currentCursor).join("").length;
    const token = extractPathToken(currentValue, currentCursorPos);
    const seq = ++pathFetchSeq.current;
    const snapshot = currentValue;
    generateBashSuggestions(currentValue, token).then((items) => {
      if (pathFetchSeq.current !== seq || valueRef.current !== snapshot) return;
      if (items.length === 0) return;
      const only = items[0];
      if (items.length === 1 && only.path + (only.isDirectory ? "/" : "") !== token.token) {
        const { nextChars, nextCursor } = applyPathSuggestion(currentChars, token, only);
        replace(nextChars, nextCursor);
        if (only.isDirectory) setBashPathActive(true);
        return;
      }
      setBashPathActive(true);
      setPathSuggestions(items);
    });
  };

  const insertPaste = (text) => {
    const currentChars = [...valueRef.current];
    const result = insertPastedText({
      chars: currentChars,
      cursor: Math.max(0, Math.min(currentChars.length, cursorRef.current)),
      pastes: pastesRef.current,
      nextId: nextPasteIdRef.current,
      text,
    });
    if (!result) return null;
    if (result.id != null) nextPasteIdRef.current = result.id + 1;
    pastesRef.current = result.pastes;
    setPastes(result.pastes);
    const nextValue = result.chars.join("");
    replace(result.chars, result.cursor);
    return nextValue;
  };

  usePaste(
    (text) => {
      if (!locked) void insertPaste(text);
    },
    { isActive: !disabled }
  );

  useInput(
    (input, key) => {
      if (locked) return;

      const currentValue = valueRef.current;
      const currentChars = [...currentValue];
      const currentCursor = Math.max(0, Math.min(currentChars.length, cursorRef.current));
      const currentPastes = pastesRef.current;

      if (key.tab && key.shift) {
        onCycleMode?.();
        return;
      }

      if (
        onHelpOpenChange &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        currentValue === "" &&
        input === "?"
      ) {
        onHelpOpenChange(!helpOpen);
        return;
      }
      if (helpOpen) onHelpOpenChange?.(false);

      if (showSuggestions) {
        if (key.upArrow) {
          setSelectedIndex((activeIndex - 1 + activeSuggestions.length) % activeSuggestions.length);
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((activeIndex + 1) % activeSuggestions.length);
          return;
        }
        if (key.tab || (key.return && (isFileMode || isPathMode))) {
          if (isFileMode) {
            applyActiveFileSuggestion();
          } else if (isPathMode) {
            applyActivePathSuggestion();
          } else {
            const name = activeSuggestions[activeIndex].name;
            replace([...`/${name} `], name.length + 2);
          }
          return;
        }
        if (key.return) {
          submit(`/${activeSuggestions[activeIndex].name}`);
          return;
        }
        if (key.escape) {
          if (isPathMode) {
            setBashPathActive(false);
            setPathSuggestions([]);
            return;
          }
          setDismissed(true);
          return;
        }
      }

      if (key.return) {
        if (helpOpen && currentValue === "") return;
        submit(currentValue);
        return;
      }

      if (key.leftArrow) {
        const nextCursor = stepCursor(currentChars, currentCursor, -1, currentPastes);
        cursorRef.current = nextCursor;
        setCursor(nextCursor);
        notifySnapshotChange();
        return;
      }
      if (key.rightArrow) {
        const nextCursor = stepCursor(currentChars, currentCursor, 1, currentPastes);
        cursorRef.current = nextCursor;
        setCursor(nextCursor);
        notifySnapshotChange();
        return;
      }
      if (key.home) {
        cursorRef.current = 0;
        setCursor(0);
        notifySnapshotChange();
        return;
      }
      if (key.end) {
        cursorRef.current = currentChars.length;
        setCursor(currentChars.length);
        notifySnapshotChange();
        return;
      }

      if (key.backspace) {
        const result = deleteBeforeCursor(currentChars, currentCursor, currentPastes);
        if (result) replace(result.chars, result.cursor);
        return;
      }

      if (key.delete) {
        const result = deleteAfterCursor(currentChars, currentCursor, currentPastes);
        if (result) replace(result.chars, result.cursor);
        return;
      }

      if (key.ctrl) {
        if (input === "a") {
          cursorRef.current = 0;
          setCursor(0);
          notifySnapshotChange();
        }
        if (input === "e") {
          cursorRef.current = currentChars.length;
          setCursor(currentChars.length);
          notifySnapshotChange();
        }
        if (input === "u") replace(currentChars.slice(currentCursor), 0);
        if (input === "k") replace(currentChars.slice(0, currentCursor), currentCursor);
        return;
      }

      if (key.upArrow) {
        const snapshot = historyRef.current.previous(currentSnapshot());
        if (snapshot) restoreSnapshot(snapshot);
        return;
      }
      if (key.downArrow) {
        const snapshot = historyRef.current.next();
        if (snapshot) restoreSnapshot(snapshot);
        return;
      }

      if (key.tab) {
        if (isBashInput(currentValue) && !isFileMode) triggerBashPathCompletion();
        return;
      }
      if (key.escape || key.meta) return;
      if (key.pageUp || key.pageDown) return;
      if (!input) return;

      const shouldSubmit = /[\r\n]$/.test(input);
      const body = input.replace(/[\r\n]+$/, "");

      if ([...body].length > 1 && shouldCollapsePaste(normalizePastedText(body))) {
        const nextValue = insertPaste(body);
        if (shouldSubmit && nextValue != null) submit(nextValue);
        return;
      }

      const text = body
        .replace(/[\r\n]+/g, " ")
        .replace(/[\u0000-\u001F\u007F]/g, "");

      const next = [
        ...currentChars.slice(0, currentCursor),
        ...text,
        ...currentChars.slice(currentCursor),
      ];
      if (shouldSubmit) {
        submit(next.join(""));
        return;
      }
      replace(next, currentCursor + [...text].length);
    },
    { isActive: !disabled }
  );

  const accentColor = disabled ? "gray" : isBashMode ? "magenta" : "cyan";

  const displayChars = isBashMode ? chars.slice(1) : chars;
  const displayCursor = isBashMode ? Math.max(0, cursor - 1) : cursor;
  const inputSegments = segmentInput(displayChars, displayCursor, pastes);
  // 光标锚点：自绘的反显块只骗眼睛，输入法的预编辑串与候选框认的是真实终端
  // 光标，所以要把后者钉到这一行的光标格上（见 use-input-cursor.js）。
  const inputRowRef = useRef(null);
  const inputCursorText = cursorText(inputSegments);
  useInputCursor(inputRowRef, disabled || locked ? null : cursorColumn(inputSegments), {
    text: inputCursorText,
  });
  const isPathLikeMode = isFileMode || isPathMode;
  const nameColumnWidth = isPathLikeMode
    ? 0
    : Math.max(0, ...activeSuggestions.map((s) => s.displayText.length)) + 2;

  const descriptionWidth = Math.max(
    MIN_DESCRIPTION_WIDTH,
    (stdout?.columns ?? 80) - 2 - (nameColumnWidth + 2)
  );
  const commandRows = isPathLikeMode
    ? []
    : activeSuggestions.map((item) => ({
        item,
        lines: wrapDescription(item.description, descriptionWidth, COMMAND_DESCRIPTION_LINES),
      }));
  const rowCosts = commandRows.map((row) => Math.max(1, row.lines.length));
  const commandBudget = Math.min(
    COMMAND_SUGGESTION_LINES,
    rowCosts.reduce((sum, cost) => sum + cost, 0)
  );
  const packed = packRows(rowCosts, activeIndex, commandBudget);

  const windowFrom = isPathLikeMode
    ? windowStart(activeIndex, activeSuggestions.length, MAX_VISIBLE_FILE_SUGGESTIONS)
    : packed.start;
  const visibleSuggestions = isPathLikeMode
    ? activeSuggestions.slice(windowFrom, windowFrom + MAX_VISIBLE_FILE_SUGGESTIONS)
    : commandRows.slice(packed.start, packed.end + 1).map((row) => row.item);
  const fillerLines = isPathLikeMode ? 0 : Math.max(0, commandBudget - packed.used);

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={accentColor}
        borderLeft={false}
        borderRight={false}
        width="100%"
      >
        {/* 只保留上下发丝边，去掉左右框线。 */}
        <Box flexShrink={0}>
          <Text color={accentColor}>{isBashMode ? "! " : "❯ "}</Text>
        </Box>
        <Box flexGrow={1} ref={inputRowRef}>
          {disabled ? (
            chars.length > 0 ? <Text dimColor>{value}</Text> : null
          ) : (
            <Text>
              {inputSegments.map((segment, index) => (
                <Text
                  key={index}
                  // 只有光标落在折叠块里才反显整块（表达「下一步删掉它」）；
                  // 普通光标不再自绘，交给真实终端光标。
                  inverse={segment.marker && segment.cursor}
                  color={segment.marker ? "cyan" : undefined}
                  bold={segment.marker}
                >
                  {segment.text}
                </Text>
              ))}
            </Text>
          )}
        </Box>
      </Box>

      {showSuggestions ? (
        <Box flexDirection="column" paddingX={1}>
          {visibleSuggestions.map((item, index) => {
            const active = windowFrom + index === activeIndex;
            if (isPathLikeMode) {
              const detail = item.isDirectory ? "dir" : item.isCommand ? "cmd" : "";
              return (
                <Text key={item.displayText} color={active ? "cyan" : undefined} bold={active}>
                  {active ? "❯ " : "  "}
                  {item.displayText}
                  {detail ? <Text dimColor={!active}>{"  "}{detail}</Text> : null}
                </Text>
              );
            }
            const lines = commandRows[windowFrom + index].lines;
            return (
              <Box key={item.name} flexDirection="row">
                <Box width={nameColumnWidth + 2} flexShrink={0}>
                  <Text color={active ? "cyan" : undefined} bold={active} wrap="truncate-end">
                    {active ? "❯ " : "  "}
                    {item.displayText}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} flexDirection="column">
                  {lines.map((line, lineIndex) => (
                    <Text
                      key={lineIndex}
                      color={active ? "cyan" : undefined}
                      bold={active}
                      dimColor={!active}
                      wrap="truncate-end"
                    >
                      {line}
                    </Text>
                  ))}
                </Box>
              </Box>
            );
          })}
          {fillerLines > 0 ? <Box height={fillerLines} flexShrink={0} /> : null}
          <Text dimColor>
            {isPathLikeMode
              ? "Tab/Enter to complete · Esc to dismiss"
              : "Tab to complete · Enter to run · Esc to dismiss"}
            {activeSuggestions.length > visibleSuggestions.length
              ? `  ·  ${activeIndex + 1}/${activeSuggestions.length}`
              : ""}
          </Text>
        </Box>
      ) : helpOpen ? (
        <ShortcutHelp />
      ) : null}
    </Box>
  );
}
