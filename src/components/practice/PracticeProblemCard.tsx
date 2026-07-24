import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, Lightbulb, X } from "lucide-react";
import type { PracticeProblem } from "@/lib/practice";

// A single practice problem: pick one of four, submit, and get an INSTANT
// verdict + explanation (the client already has the key). Option styling matches
// SkillVerificationDialog so the two quiz surfaces read as one system; the extra
// work here is the post-submit reveal (correct = green, your wrong pick = red).

const LETTERS = ["A", "B", "C", "D"];

// Renders `inline code` segments as <code>. The model is told to wrap code in
// backticks; anything between a matched pair becomes monospaced.
function InlineText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em] text-foreground"
          >
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

type Props = {
  problem: PracticeProblem;
  // The 1-based number shown to the user (position in the whole session).
  questionNumber: number;
  // Fired exactly once, the moment the user submits, with whether they were right.
  onResolved: (correct: boolean) => void;
  onNext: () => void;
  nextLabel?: string;
};

export function PracticeProblemCard({
  problem,
  questionNumber,
  onResolved,
  onNext,
  nextLabel = "Next problem",
}: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const isCorrect = submitted && selected === problem.correctIndex;

  const submit = () => {
    if (submitted || selected === null) return;
    setSubmitted(true);
    onResolved(selected === problem.correctIndex);
  };

  return (
    <div className="rounded-3xl border border-border bg-muted/60 p-5 md:p-6">
      <p className="text-base font-medium leading-relaxed md:text-lg">
        <span className="mr-1.5 text-muted-foreground">{questionNumber}.</span>
        <InlineText text={problem.prompt} />
      </p>

      <div className="mt-4 space-y-2.5">
        {problem.options.map((option, index) => {
          const chosen = selected === index;
          const isKey = index === problem.correctIndex;

          // Post-submit reveal: the correct option always turns green; the user's
          // wrong pick turns red; everything else fades back.
          let state: "idle" | "chosen" | "correct" | "wrong" = "idle";
          if (!submitted) state = chosen ? "chosen" : "idle";
          else if (isKey) state = "correct";
          else if (chosen) state = "wrong";

          return (
            <button
              key={index}
              type="button"
              disabled={submitted}
              onClick={() => setSelected(index)}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left text-sm transition-colors md:text-[0.95rem]",
                state === "idle" &&
                  "border-border bg-background text-muted-foreground hover:border-brand-purple/40 hover:text-foreground",
                state === "chosen" && "border-brand-cyan/50 bg-brand-cyan/15 text-foreground",
                state === "correct" && "border-brand-cyan/60 bg-brand-cyan/15 text-foreground",
                state === "wrong" && "border-destructive/50 bg-destructive/10 text-foreground",
                submitted && "cursor-default",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  state === "idle" && "border-border",
                  (state === "chosen" || state === "correct") &&
                    "border-brand-cyan/60 bg-brand-cyan/20 text-brand-cyan",
                  state === "wrong" && "border-destructive/60 bg-destructive/20 text-destructive",
                )}
              >
                {submitted && isKey ? (
                  <Check className="h-4 w-4" />
                ) : submitted && state === "wrong" ? (
                  <X className="h-4 w-4" />
                ) : (
                  LETTERS[index]
                )}
              </span>
              <span className="min-w-0 flex-1">
                <InlineText text={option} />
              </span>
            </button>
          );
        })}
      </div>

      {submitted && (
        <div className="mt-4 space-y-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
          <div
            className={cn(
              "flex items-start gap-2.5 rounded-2xl border px-4 py-3",
              isCorrect
                ? "border-brand-cyan/40 bg-brand-cyan/10"
                : "border-destructive/40 bg-destructive/10",
            )}
          >
            {isCorrect ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-cyan" />
            ) : (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold">{isCorrect ? "Correct" : "Not quite"}</p>
              {problem.explanation && (
                <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-yellow" />
                  <span className="min-w-0">
                    <InlineText text={problem.explanation} />
                  </span>
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="hero" size="sm" onClick={onNext} className="gap-1">
              {nextLabel}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {!submitted && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {selected === null ? "Pick an answer" : "Ready when you are"}
          </p>
          <Button variant="hero" size="sm" onClick={submit} disabled={selected === null}>
            Submit
          </Button>
        </div>
      )}
    </div>
  );
}
