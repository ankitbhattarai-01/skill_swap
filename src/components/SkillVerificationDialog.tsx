import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { invalidateAiSuggestionsCache } from "@/lib/ai-suggestions";
import { Check, Clock, Loader2, X } from "lucide-react";
import { VerifiedTick } from "@/components/VerifiedTick";
import {
  finishSkillQuiz,
  formatRetryWait,
  PASS_CORRECT,
  QUESTION_COUNT,
  startSkillQuiz,
  VerificationError,
  type QuizResult,
  type QuizStart,
  type SkillVerification,
} from "@/lib/skill-verification";

// The verification quiz: all ten questions on screen at once, answered at the
// user's own pace, with a SINGLE countdown for the whole set. When the clock
// runs out whatever is selected is submitted automatically.
//
// The client never sees the answer key or does any grading. It shows the
// questions, collects one choice each, and posts them; the verify-skill Edge
// Function grades against the key it kept and decides pass/fail.

type Phase = "intro" | "loading" | "quiz" | "grading" | "result" | "error";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillId: string;
  skillName: string;
  onVerified: (verification: SkillVerification) => void;
};

const LEVEL_LABEL: Record<string, string> = {
  basic: "Basic",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

const LETTERS = ["A", "B", "C", "D"];

function formatClock(secondsLeft: number) {
  const total = Math.max(0, secondsLeft);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function SkillVerificationDialog({
  open,
  onOpenChange,
  skillId,
  skillName,
  onVerified,
}: Props) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [quiz, setQuiz] = useState<QuizStart | null>(null);
  // Chosen option per question position. A position missing from the map is an
  // unanswered question.
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [retryAt, setRetryAt] = useState<string | null>(null);

  // Guards a late response from a previous opening from landing after the user
  // closed and reopened the dialog.
  const runIdRef = useRef(0);
  // Submission fires from two places — the button and the countdown reaching
  // zero. This makes sure it can only happen once per sitting.
  const submittedRef = useRef(false);

  const answeredCount = useMemo(() => Object.keys(answers).length, [answers]);

  const submitQuiz = useCallback(
    async (current: QuizStart, currentAnswers: Record<number, number>) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const runId = runIdRef.current;

      setPhase("grading");
      try {
        const payload = current.questions.map((q) => ({
          position: q.position,
          answerIndex: q.position in currentAnswers ? currentAnswers[q.position] : null,
        }));
        const graded = await finishSkillQuiz(current.attemptId, payload);
        if (runId !== runIdRef.current) return;

        setResult(graded);
        setPhase("result");
        if (graded.passed) {
          // A fresh badge retires the "get verified" suggestion tile.
          void invalidateAiSuggestionsCache();
          onVerified({
            skill_id: skillId,
            level: graded.level,
            score: graded.score,
            total: graded.total,
            verified_at: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (runId !== runIdRef.current) return;
        setErrorMessage(
          error instanceof Error ? error.message : "Could not grade the quiz. Please try again.",
        );
        setRetryAt(error instanceof VerificationError ? error.retryAt : null);
        setPhase("error");
      }
    },
    [onVerified, skillId],
  );

  // Kept in a ref so the countdown effect can auto-submit the latest answers
  // without re-subscribing every time a choice changes.
  const autoSubmitRef = useRef<() => void>(() => {});
  useEffect(() => {
    autoSubmitRef.current = () => {
      if (quiz) void submitQuiz(quiz, answers);
    };
  }, [quiz, answers, submitQuiz]);

  const beginQuiz = useCallback(async () => {
    const runId = ++runIdRef.current;
    submittedRef.current = false;

    setPhase("loading");
    setQuiz(null);
    setAnswers({});
    setResult(null);
    setErrorMessage("");
    setRetryAt(null);

    try {
      const started = await startSkillQuiz(skillId);
      if (runId !== runIdRef.current) return;
      setQuiz(started);
      setPhase("quiz");
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setErrorMessage(
        error instanceof Error ? error.message : "Could not start the quiz. Please try again.",
      );
      setRetryAt(error instanceof VerificationError ? error.retryAt : null);
      setPhase("error");
    }
  }, [skillId]);

  // Reset to the intro every time the dialog opens; the quiz never autostarts.
  useEffect(() => {
    if (open) {
      runIdRef.current++;
      submittedRef.current = false;
      setPhase("intro");
      setQuiz(null);
      setAnswers({});
      setResult(null);
      setErrorMessage("");
      setRetryAt(null);
    }
  }, [open]);

  // The single countdown. Derived from the server's deadline, so pausing the
  // tab changes what shows, not what the server will accept. Auto-submits once.
  useEffect(() => {
    if (phase !== "quiz" || !quiz) return;
    const deadline = new Date(quiz.deadlineAt).getTime();
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) autoSubmitRef.current();
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [phase, quiz]);

  const choose = useCallback((position: number, index: number) => {
    setAnswers((prev) => ({ ...prev, [position]: index }));
  }, []);

  // A quiz in flight must not be dismissed by a stray click outside or Esc —
  // closing abandons the attempt.
  const inProgress = phase === "loading" || phase === "quiz" || phase === "grading";
  const lowTime = phase === "quiz" && secondsLeft <= 30;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !inProgress && onOpenChange(false)}>
      <DialogContent
        className="flex max-h-[85vh] max-w-lg flex-col gap-3.5 overflow-hidden p-4"
        onInteractOutside={(e) => inProgress && e.preventDefault()}
        onEscapeKeyDown={(e) => inProgress && e.preventDefault()}
      >
        <DialogHeader className="shrink-0 space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-brand-soft">
              <VerifiedTick />
            </div>
            <DialogTitle className="text-base leading-tight">Verify {skillName}</DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-snug">
            {quiz && phase === "quiz"
              ? `${LEVEL_LABEL[quiz.level] ?? quiz.level} level · ${quiz.passCorrect} of ${quiz.total} correct to pass`
              : "A short multiple-choice quiz at the level you teach this skill at."}
          </DialogDescription>
        </DialogHeader>

        {phase === "intro" && (
          <div className="dialog-scroll min-h-0 flex-1 space-y-4 overflow-y-auto py-2">
            <div className="space-y-3 rounded-2xl border border-border bg-muted px-4 py-4 text-sm text-muted-foreground">
              <p>
                You'll answer{" "}
                <span className="text-foreground">{QUESTION_COUNT} multiple-choice questions</span>{" "}
                and need <span className="text-foreground">{PASS_CORRECT} correct</span> to earn the
                tick.
              </p>
              <p>
                There's <span className="text-foreground">one timer for the whole quiz</span>.
                Answer at your own pace and press Submit when you're done. If the time runs out,
                your answers are submitted automatically.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="hero" size="sm" onClick={() => void beginQuiz()}>
                Start the quiz
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Both waiting states are held at the height of the intro screen they
            replace. Left to size themselves they were about half as tall, so
            pressing "Start the quiz" collapsed the panel — and since a dialog is
            centred, collapsing moves all four edges at once — only for it to
            expand again a moment later when the questions arrived. */}
        {phase === "loading" && (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-brand-cyan" />
            <p className="text-sm text-muted-foreground">Getting your quiz ready…</p>
          </div>
        )}

        {phase === "grading" && (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-brand-cyan" />
            <p className="text-sm text-muted-foreground">Checking your answers…</p>
          </div>
        )}

        {phase === "error" && (
          <div className="dialog-scroll min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
            {retryAt && (
              <p className="text-sm text-muted-foreground">
                You can try again in about{" "}
                <span className="font-medium text-foreground">{formatRetryWait(retryAt)}</span>.
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {!retryAt && (
                <Button variant="hero" size="sm" onClick={() => void beginQuiz()}>
                  Try again
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === "quiz" && quiz && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Fixed above the scrolling question list — never competes with it for space. */}
            <div className="-mx-4 shrink-0 space-y-1.5 border-b border-border px-4 pb-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {answeredCount} of {quiz.total} answered
                </p>
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-sm font-semibold tabular-nums",
                    lowTime ? "text-destructive" : "text-foreground",
                  )}
                >
                  <Clock className="h-3.5 w-3.5" />
                  {formatClock(secondsLeft)}
                </div>
              </div>
              <Progress value={(answeredCount / quiz.total) * 100} className="h-1.5" />
            </div>

            <div className="dialog-scroll min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
              {quiz.questions.map((question) => (
                <div
                  key={question.position}
                  className="rounded-2xl border border-border bg-muted px-4 py-3.5"
                >
                  <p className="text-sm font-medium leading-relaxed">
                    <span className="text-muted-foreground">{question.position + 1}.</span>{" "}
                    {question.prompt}
                  </p>
                  <div className="mt-3 space-y-2">
                    {question.options.map((option, index) => {
                      const selected = answers[question.position] === index;
                      return (
                        <button
                          key={index}
                          type="button"
                          onClick={() => choose(question.position, index)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                            selected
                              ? "border-brand-cyan/50 bg-brand-cyan/15 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:border-brand-purple/40 hover:text-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                              selected
                                ? "border-brand-cyan/60 bg-brand-cyan/20 text-brand-cyan"
                                : "border-border",
                            )}
                          >
                            {LETTERS[index]}
                          </span>
                          <span className="min-w-0 flex-1">{option}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <DialogFooter className="shrink-0 gap-2 pt-3">
              <p className="mr-auto self-center text-xs text-muted-foreground">
                {answeredCount < quiz.total ? `${quiz.total - answeredCount} left` : "All answered"}
              </p>
              <Button variant="hero" size="sm" onClick={() => void submitQuiz(quiz, answers)}>
                Submit quiz
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === "result" && result && (
          <div className="dialog-scroll min-h-0 flex-1 space-y-4 overflow-y-auto">
            <div
              className={cn(
                "rounded-2xl border px-4 py-4 text-center",
                result.passed ? "border-blue-500/30 bg-blue-500/10" : "border-border bg-muted",
              )}
            >
              {result.passed ? (
                <VerifiedTick className="mx-auto h-7 w-7" />
              ) : (
                <X className="mx-auto h-7 w-7 text-muted-foreground" />
              )}
              <p className="mt-2 text-sm font-semibold">
                {result.passed
                  ? `Verified in ${skillName}`
                  : `${result.score} of ${result.total} — not quite`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {result.passed
                  ? `You scored ${result.score} of ${result.total}. The tick now shows on your profile.`
                  : result.retryAt
                    ? `You need ${result.passCorrect} correct. Try again in about ${formatRetryWait(result.retryAt)}.`
                    : `You need ${result.passCorrect} correct to pass.`}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Review</p>
              {result.results.map((row) => (
                <div
                  key={row.position}
                  className="rounded-2xl border border-border bg-muted px-3.5 py-3"
                >
                  <div className="flex items-start gap-2">
                    {row.correct ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-cyan" />
                    ) : (
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                    <p className="min-w-0 flex-1 text-xs font-medium leading-relaxed">
                      {row.prompt}
                    </p>
                  </div>
                  {!row.correct && (
                    <div className="mt-1.5 space-y-1 pl-6">
                      <p className="text-xs text-muted-foreground">
                        {row.yourIndex === null
                          ? "You didn't answer this one."
                          : `You chose ${LETTERS[row.yourIndex]}.`}{" "}
                        <span className="text-foreground">
                          Correct: {LETTERS[row.correctIndex]}
                          {row.options[row.correctIndex]
                            ? ` — ${row.options[row.correctIndex]}`
                            : ""}
                        </span>
                      </p>
                      {row.explanation && (
                        <p className="text-xs text-muted-foreground">{row.explanation}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button variant="hero" size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
