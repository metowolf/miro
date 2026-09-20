const OTHER_VALUE = "__other__";

export function hasQuestionPreview(question) {
  return !question?.multiSelect && question?.options?.some((option) => option.preview);
}

export function visibleQuestionOptions(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (hasQuestionPreview(question)) return options;
  return [...options, { label: "Other", description: "Type a custom answer", value: OTHER_VALUE }];
}

function initialQuestionState(question) {
  return {
    focused: 0,
    selected: question.multiSelect ? [] : null,
    custom: "",
    notes: "",
  };
}

export function createUserQuestionState(questions) {
  return {
    index: 0,
    view: "question",
    editing: null,
    reviewIndex: 0,
    questions: Object.fromEntries(questions.map((question) => [question.id, initialQuestionState(question)])),
  };
}

function updateCurrent(state, questions, update) {
  const question = questions[state.index];
  if (!question) return state;
  return {
    ...state,
    questions: {
      ...state.questions,
      [question.id]: update(state.questions[question.id] ?? initialQuestionState(question), question),
    },
  };
}

export function userQuestionReducer(state, action, questions) {
  const lastTab = questions.length;
  switch (action.type) {
    case "switch-tab": {
      // lastTab 是 review 这个虚拟 tab；问题索引单独钳制，切到 review 时保留最后一题。
      const tab = Math.max(0, Math.min(lastTab, action.index));
      const onReview = tab === lastTab;
      return {
        ...state,
        index: Math.min(tab, Math.max(0, questions.length - 1)),
        view: onReview ? "review" : "question",
        editing: null,
      };
    }
    case "step-tab": {
      const current = state.view === "review" ? lastTab : state.index;
      const next = (current + action.delta + lastTab + 1) % (lastTab + 1);
      return userQuestionReducer(state, { type: "switch-tab", index: next }, questions);
    }
    case "move-option":
      return updateCurrent(state, questions, (current, question) => {
        const count = visibleQuestionOptions(question).length + (hasQuestionPreview(question) ? 1 : 0);
        if (count === 0) return current;
        return { ...current, focused: (current.focused + action.delta + count) % count };
      });
    case "select-single":
      return updateCurrent(state, questions, (current) => ({ ...current, selected: action.value }));
    case "toggle-multi":
      return updateCurrent(state, questions, (current) => {
        const selected = Array.isArray(current.selected) ? current.selected : [];
        return {
          ...current,
          selected: selected.includes(action.value)
            ? selected.filter((value) => value !== action.value)
            : [...selected, action.value],
        };
      });
    case "begin-edit":
      return { ...state, editing: action.field };
    case "end-edit":
      return { ...state, editing: null };
    case "set-text":
      return updateCurrent(state, questions, (current) => ({ ...current, [action.field]: action.value }));
    case "move-review":
      return { ...state, reviewIndex: (state.reviewIndex + action.delta + 2) % 2 };
    default:
      return state;
  }
}

export function answerForQuestion(question, state) {
  if (!state) return "";
  if (question.multiSelect) {
    return (Array.isArray(state.selected) ? state.selected : [])
      .map((value) => value === OTHER_VALUE ? state.custom.trim() : value)
      .filter(Boolean)
      .join(", ");
  }
  if (state.selected === OTHER_VALUE) return state.custom.trim();
  return typeof state.selected === "string" ? state.selected : "";
}

/** preview 与备注都可缺省；两者皆空时不产生 annotation 条目。 */
function annotationEntry(preview, notes) {
  if (!preview && !notes) return null;
  return { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) };
}

export function buildUserQuestionResult(questions, state) {
  const answers = {};
  const annotations = {};
  for (const question of questions) {
    const questionState = state.questions[question.id];
    const answer = answerForQuestion(question, questionState);
    if (answer) answers[question.id] = answer;

    const selectedOption = !question.multiSelect
      ? question.options.find((option) => option.label === questionState?.selected)
      : null;
    const annotation = annotationEntry(selectedOption?.preview, questionState?.notes?.trim());
    if (annotation) annotations[question.id] = annotation;
  }
  return {
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

export function allQuestionsAnswered(questions, state) {
  return questions.every((question) => Boolean(answerForQuestion(question, state.questions[question.id])));
}

export { OTHER_VALUE };
