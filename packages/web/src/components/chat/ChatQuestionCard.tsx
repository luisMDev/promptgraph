import { formatQuestionAnswer, type ChatPermissionRequestItem, type ChatQuestion } from "@promptgraph/shared";
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Button } from "../common/ui";

interface Draft {
  selected: string[];
  /** "Other" is chosen: its text is part of the answer. */
  otherOn: boolean;
  other: string;
}

const EMPTY_DRAFT: Draft = { selected: [], otherOn: false, other: "" };

function answered(d: Draft): boolean {
  return d.selected.length > 0 || (d.otherOn && d.other.trim().length > 0);
}

/**
 * Claude's AskUserQuestion as a card (DESIGN §21.4): one question at a time with a chip per question, the options
 * as selectable rows (radio or checkbox), "Other" with free text, number keys to pick, Enter to go on. Submit sends
 * every answer (a question left empty tells Claude to pick a default); Skip denies the call.
 */
export function QuestionCard({
  request,
  questions,
  onSubmit,
  onSkip,
  queued = 0,
}: {
  request: ChatPermissionRequestItem;
  questions: ChatQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
  queued?: number;
}) {
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY_DRAFT));
  const firstOption = useRef<HTMLButtonElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const question = questions[index]!;
  const draft = drafts[index] ?? EMPTY_DRAFT;
  const last = index === questions.length - 1;
  const multi = question.multiSelect === true;

  useEffect(() => {
    // Keyboard and screen-reader users learn that Claude is waiting on them.
    if (!draft.otherOn) firstOption.current?.focus();
    // Only when the shown question (or the request) changes, not on every keystroke.
  }, [request.requestId, index]);

  const patch = (next: Partial<Draft>) => setDrafts((all) => all.map((d, i) => (i === index ? { ...d, ...next } : d)));

  const submit = (all: Draft[] = drafts) => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const d = all[i] ?? EMPTY_DRAFT;
      answers[q.question] = formatQuestionAnswer(d.selected, d.otherOn ? d.other : undefined);
    });
    onSubmit(answers);
  };

  const next = (all: Draft[] = drafts) => {
    if (last) submit(all);
    else setIndex(index + 1);
  };

  const choose = (label: string) => {
    if (multi) {
      patch({ selected: draft.selected.includes(label) ? draft.selected.filter((l) => l !== label) : [...draft.selected, label] });
      return;
    }
    // Single choice: picking an option answers the question and moves on, as in Claude Code.
    const all = drafts.map((d, i) => (i === index ? { selected: [label], otherOn: false, other: d.other } : d));
    setDrafts(all);
    if (!last) setIndex(index + 1);
  };

  const toggleOther = () => {
    const on = multi ? !draft.otherOn : true;
    patch(multi ? { otherOn: on } : { otherOn: true, selected: [] });
    if (on) requestAnimationFrame(() => otherInput.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= question.options.length + 1) {
      e.preventDefault();
      if (n === question.options.length + 1) toggleOther();
      else choose(question.options[n - 1]!.label);
    }
  };

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="space-y-2.5 rounded-lg bg-card p-3 ring-1 ring-primary/30"
      onKeyDown={onKeyDown}
      data-testid="question-card"
    >
      <div className="flex items-center gap-1.5">
        <MessageCircleQuestionIcon className="size-4 shrink-0 text-primary" />
        <p id={titleId} className="text-sm font-medium">
          {questions.length === 1 ? "Claude has a question" : `Claude has ${questions.length} questions`}
        </p>
        {queued > 0 && <span className="ml-auto text-xs text-muted-foreground">+{queued} more waiting</span>}
      </div>

      {questions.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Questions">
          {questions.map((q, i) => (
            <button
              key={q.question}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => setIndex(i)}
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 ring-border",
                i === index ? "bg-primary text-primary-foreground ring-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {answered(drafts[i] ?? EMPTY_DRAFT) && i !== index && <CheckIcon className="size-3" />}
              {q.header || `Question ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      <div>
        <p className="text-sm text-foreground">{question.question}</p>
        {multi && <p className="text-[11px] text-muted-foreground">Choose one or more.</p>}
      </div>

      <div role={multi ? "group" : "radiogroup"} aria-label={question.question} className="space-y-1">
        {question.options.map((option, i) => {
          const checked = draft.selected.includes(option.label);
          return (
            <button
              key={option.label}
              ref={i === 0 ? firstOption : undefined}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={checked}
              onClick={() => choose(option.label)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ring-1 ring-border transition-colors hover:bg-muted",
                checked && "bg-primary/8 ring-primary/50",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-px flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-medium tabular-nums ring-1 ring-border",
                  checked ? "bg-primary text-primary-foreground ring-primary" : "text-muted-foreground",
                )}
              >
                {checked ? <CheckIcon className="size-3" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">{option.label}</span>
                {option.description && <span className="block text-[11px] text-muted-foreground">{option.description}</span>}
              </span>
            </button>
          );
        })}
        <div className={cn("rounded-md ring-1 ring-border", draft.otherOn && "bg-primary/8 ring-primary/50")}>
          <button
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={draft.otherOn}
            onClick={toggleOther}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-medium tabular-nums ring-1 ring-border",
                draft.otherOn ? "bg-primary text-primary-foreground ring-primary" : "text-muted-foreground",
              )}
            >
              {draft.otherOn ? <CheckIcon className="size-3" /> : question.options.length + 1}
            </span>
            <span className="text-xs font-medium text-foreground">Other…</span>
          </button>
          {draft.otherOn && (
            <div className="px-2 pb-2">
              <Input
                ref={otherInput}
                aria-label="Your answer"
                placeholder="Type your answer"
                value={draft.other}
                className="h-7 text-xs"
                onChange={(e) => patch({ other: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    next();
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onSkip} className="text-muted-foreground">
          Skip
        </Button>
        <span className="ml-auto" />
        {index > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setIndex(index - 1)}>
            Back
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => next()}>
          {last ? "Submit" : "Next"}
        </Button>
      </div>
    </div>
  );
}
