import { Box, Text, useInput, useWindowSize } from "ink";
import { useMemo, useReducer, useRef } from "react";

import { useInputCursor } from "../hooks/use-input-cursor.js";
import { renderMarkdown } from "../markdown.js";
import { stringWidth } from "../markdown-width.js";
import { truncateToCellWidth } from "./picker/picker-rows.js";
import {
  OTHER_VALUE,
  allQuestionsAnswered,
  answerForQuestion,
  buildUserQuestionResult,
  createUserQuestionState,
  hasQuestionPreview,
  userQuestionReducer,
  visibleQuestionOptions,
} from "./user-question-state.js";

function cleanInput(input) {
  return String(input ?? "").replace(/[\r\n]+/g, "").replace(/[\u0000-\u001F\u007F]/g, "");
}

function Navigation({ questions, state, columns, showReview }) {
  if (questions.length === 1 && !showReview) return null;
  const tabCount = questions.length + (showReview ? 1 : 0);
  const labelWidth = Math.max(3, Math.floor((columns - 8) / Math.max(1, tabCount)) - 4);
  return (
    <Box marginBottom={1}>
      <Text dimColor={state.view === "question" && state.index === 0}>← </Text>
      {questions.map((question, index) => {
        const active = state.view === "question" && state.index === index;
        const answered = Boolean(answerForQuestion(question, state.questions[question.id]));
        const label = truncateToCellWidth(question.header || `Q${index + 1}`, labelWidth);
        return (
          <Text key={question.id} inverse={active} color={active ? "cyan" : undefined}>
            {` ${answered ? "[x]" : "[ ]"} ${label} `}
          </Text>
        );
      })}
      {showReview ? (
        <Text inverse={state.view === "review"} color={state.view === "review" ? "cyan" : undefined}>
          {" ✓ Submit "}
        </Text>
      ) : null}
      <Text dimColor={state.view === "review"}> →</Text>
    </Box>
  );
}

function OptionRow({ option, index, active, selected, multiSelect, editing, input }) {
  const choice = multiSelect ? `[${selected ? "x" : " "}]` : selected ? "●" : "○";
  const other = option.value === OTHER_VALUE;
  return (
    <Box flexDirection="column">
      <Text color={active ? "cyan" : undefined}>
        {active ? "❯" : " "} {index + 1}. {choice} {option.label}
        {other && (editing || input) ? <Text> {input || "Type something…"}</Text> : null}
      </Text>
      {option.description ? (
        <Box paddingLeft={5}>
          <Text dimColor>{option.description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ReviewView({ questions, state }) {
  const complete = allQuestionsAnswered(questions, state);
  return (
    <Box flexDirection="column">
      <Text bold>Review your answers</Text>
      {!complete ? <Text color="yellow">! You have not answered all questions</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {questions.map((question) => {
          const answer = answerForQuestion(question, state.questions[question.id]);
          return (
            <Box key={question.id} flexDirection="column" marginBottom={1}>
              <Text>• {question.question}</Text>
              <Box paddingLeft={2}>
                <Text color={answer ? "green" : undefined} dimColor={!answer}>→ {answer || "Not answered"}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>Ready to submit your answers?</Text>
      <Text color={state.reviewIndex === 0 ? "cyan" : undefined}>
        {state.reviewIndex === 0 ? "❯" : " "} 1. Submit answers
      </Text>
      <Text color={state.reviewIndex === 1 ? "cyan" : undefined}>
        {state.reviewIndex === 1 ? "❯" : " "} 2. Cancel
      </Text>
    </Box>
  );
}

export function UserQuestionDialog({ questions, onResolve }) {
  const safeQuestions = Array.isArray(questions) ? questions : [];
  const { rows = 24, columns = 80 } = useWindowSize();
  const [state, dispatch] = useReducer(
    (current, action) => userQuestionReducer(current, action, safeQuestions),
    safeQuestions,
    createUserQuestionState,
  );
  const inputRef = useRef(null);
  const question = safeQuestions[state.index];
  const questionState = question ? state.questions[question.id] : null;
  const previewQuestion = hasQuestionPreview(question);
  const options = useMemo(() => visibleQuestionOptions(question), [question]);
  const showReview = safeQuestions.length > 1 || safeQuestions.some((item) => item.multiSelect);
  const editingValue = state.editing && questionState ? questionState[state.editing] : "";
  const editingPrefix = state.editing === "notes" ? "Notes: " : `${questionState?.focused + 1}. ○ Other `;
  useInputCursor(inputRef, state.editing ? stringWidth(editingPrefix + editingValue) : null, { truncate: true });

  const reduce = (action) => userQuestionReducer(state, action, safeQuestions);
  const submit = (nextState = state) => onResolve(buildUserQuestionResult(safeQuestions, nextState));
  const advance = (nextState) => {
    if (!showReview && safeQuestions.length === 1) submit(nextState);
    else if (state.index + 1 < safeQuestions.length) dispatch({ type: "switch-tab", index: state.index + 1 });
    else dispatch({ type: "switch-tab", index: safeQuestions.length });
  };

  useInput((input, key) => {
    if (!question && state.view !== "review") return;
    if (state.editing) {
      if (key.escape) return dispatch({ type: "end-edit" });
      if (key.return) {
        const next = reduce({ type: "end-edit" });
        dispatch({ type: "end-edit" });
        if (state.editing === "custom" && !question.multiSelect && questionState.custom.trim()) advance(next);
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "set-text", field: state.editing, value: [...editingValue].slice(0, -1).join("") });
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      const text = cleanInput(input);
      if (text) dispatch({ type: "set-text", field: state.editing, value: editingValue + text });
      return;
    }

    if (key.escape) return onResolve(null);
    if (key.tab || key.leftArrow || key.rightArrow) {
      if (!showReview) return;
      const delta = key.leftArrow || (key.tab && key.shift) ? -1 : 1;
      dispatch({ type: "step-tab", delta });
      return;
    }
    if (state.view === "review") {
      if (key.upArrow || input === "k") return dispatch({ type: "move-review", delta: -1 });
      if (key.downArrow || input === "j") return dispatch({ type: "move-review", delta: 1 });
      if (input === "1") return submit();
      if (input === "2") return onResolve(null);
      if (key.return) return state.reviewIndex === 0 ? submit() : onResolve(null);
      return;
    }

    if (key.upArrow || input === "k") return dispatch({ type: "move-option", delta: -1 });
    if (key.downArrow || input === "j") return dispatch({ type: "move-option", delta: 1 });

    const focusedOption = options[questionState.focused];
    const notesFocused = previewQuestion && questionState.focused === options.length;
    const activate = (option) => {
      if (!option) return;
      const value = option.value ?? option.label;
      if (question.multiSelect) {
        const wasSelected = questionState.selected.includes(value);
        dispatch({ type: "toggle-multi", value });
        if (value === OTHER_VALUE && !wasSelected) dispatch({ type: "begin-edit", field: "custom" });
        return;
      }
      const selectedState = reduce({ type: "select-single", value });
      dispatch({ type: "select-single", value });
      if (value === OTHER_VALUE) dispatch({ type: "begin-edit", field: "custom" });
      else advance(selectedState);
    };

    const digit = Number.parseInt(input, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) return activate(options[digit - 1]);
    if (input === " " && question.multiSelect) return activate(focusedOption);
    if (key.return) {
      if (notesFocused) return dispatch({ type: "begin-edit", field: "notes" });
      if (question.multiSelect && focusedOption?.value === OTHER_VALUE) {
        if (!questionState.selected.includes(OTHER_VALUE)) dispatch({ type: "toggle-multi", value: OTHER_VALUE });
        return dispatch({ type: "begin-edit", field: "custom" });
      }
      if (question.multiSelect) return advance(state);
      return activate(focusedOption);
    }
  });

  if (!question) return null;
  const previewOption = previewQuestion ? options[questionState.focused] ?? null : null;
  const maxPreviewLines = Math.max(3, rows - 15);
  const previewLines = previewOption?.preview ? renderMarkdown(previewOption.preview).split("\n") : ["No preview available"];
  const shownPreview = previewLines.slice(0, maxPreviewLines).join("\n");
  const previewTruncated = previewLines.length > maxPreviewLines;
  const sideBySide = previewQuestion && columns >= 72;

  const hint = () => {
    if (state.editing) return "Enter to save · Esc to return";
    if (state.view === "review") return "↑↓ to select · Enter to confirm · Tab/Shift+Tab to revisit · Esc to cancel";
    if (question.multiSelect) {
      return "↑↓ to navigate · Space to toggle · Enter for next · Tab/Shift+Tab to navigate · Esc to cancel";
    }
    const navigate = safeQuestions.length === 1 ? "↑↓" : "Tab/Shift+Tab · ↑↓";
    return `${navigate} to navigate · Enter to select · Esc to cancel`;
  };

  return (
    <Box flexDirection="column" borderTop borderColor="gray">
      <Navigation questions={safeQuestions} state={state} columns={columns} showReview={showReview} />
      {state.view === "review" ? <ReviewView questions={safeQuestions} state={state} /> : (
        <>
          <Text bold>{question.question}</Text>
          <Box flexDirection={sideBySide ? "row" : "column"} gap={sideBySide ? 2 : 0} marginTop={1}>
            <Box flexDirection="column" width={sideBySide ? Math.min(34, Math.floor(columns * 0.4)) : undefined}>
              {options.map((option, index) => {
                const value = option.value ?? option.label;
                const selected = question.multiSelect
                  ? questionState.selected.includes(value)
                  : questionState.selected === value;
                return (
                  <Box key={value} ref={state.editing === "custom" && index === questionState.focused ? inputRef : undefined}>
                    <OptionRow
                      option={option}
                      index={index}
                      active={questionState.focused === index}
                      selected={selected}
                      multiSelect={question.multiSelect}
                      editing={state.editing === "custom" && index === questionState.focused}
                      input={questionState.custom}
                    />
                  </Box>
                );
              })}
              {previewQuestion ? (
                <Box ref={state.editing === "notes" ? inputRef : undefined} marginTop={1}>
                  <Text color={questionState.focused === options.length ? "cyan" : undefined}>
                    {questionState.focused === options.length ? "❯" : " "} Notes: {questionState.notes || <Text dimColor>optional</Text>}
                  </Text>
                </Box>
              ) : null}
            </Box>
            {previewQuestion ? (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor="gray"
                paddingX={1}
                marginTop={sideBySide ? 0 : 1}
                flexGrow={1}
              >
                <Text>{shownPreview}</Text>
                {previewTruncated ? <Text dimColor>… preview truncated</Text> : null}
              </Box>
            ) : null}
          </Box>
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hint()}</Text>
      </Box>
    </Box>
  );
}
