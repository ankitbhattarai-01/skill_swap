import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Check, Loader2, Play, Search } from "lucide-react";
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_TONE,
  PRACTICE_LEVELS,
  searchSkills,
  type PracticeLevel,
  type PracticeSkill,
} from "@/lib/practice";

// The picker: choose WHAT to practice (a skill you're learning, or any skill via
// search) and HOW HARD (Easy / Medium / Hard), then start. Learning skills are
// the fast path; the search covers everything else in the catalog.

type Props = {
  learningSkills: PracticeSkill[];
  selected: PracticeSkill | null;
  onSelect: (skill: PracticeSkill) => void;
  level: PracticeLevel;
  onLevelChange: (level: PracticeLevel) => void;
  onStart: () => void;
  starting: boolean;
};

export function PracticeSkillPicker({
  learningSkills,
  selected,
  onSelect,
  level,
  onLevelChange,
  onStart,
  starting,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PracticeSkill[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced catalog search. Only runs once the user has typed something; an
  // empty box just closes the dropdown.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(async () => {
      const found = await searchSkills(trimmed);
      setResults(found);
      setSearching(false);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  // Close the results dropdown on an outside click.
  useEffect(() => {
    if (!showResults) return;
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showResults]);

  const pick = (skill: PracticeSkill) => {
    onSelect(skill);
    setQuery("");
    setShowResults(false);
  };

  // A selected skill that isn't one of the learning chips still needs to show as
  // selected somewhere — surface it as an extra chip at the front.
  const chips: PracticeSkill[] =
    selected && !learningSkills.some((s) => s.id === selected.id)
      ? [selected, ...learningSkills]
      : learningSkills;

  return (
    <div className="space-y-6">
      {/* Skill ------------------------------------------------------------- */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Choose a skill</h2>
          {selected && (
            <span className="text-xs text-muted-foreground">
              Practicing <span className="font-medium text-foreground">{selected.name}</span>
            </span>
          )}
        </div>

        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((skill) => {
              const active = selected?.id === skill.id;
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => onSelect(skill)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "border-brand-purple/50 bg-brand-purple/15 text-brand-purple"
                      : "border-border bg-muted text-muted-foreground hover:border-brand-purple/40 hover:text-foreground",
                  )}
                >
                  {active && <Check className="h-3.5 w-3.5" />}
                  {skill.name}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            You're not learning any skills yet — search the catalog below to practice anything.
          </p>
        )}

        {/* Catalog search */}
        <div ref={boxRef} className="relative">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowResults(true);
              }}
              onFocus={() => query.trim() && setShowResults(true)}
              placeholder="Or search any skill…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {searching && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            )}
          </div>

          {showResults && query.trim().length > 0 && (
            <div className="absolute z-30 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-glow">
              {searching && results.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
              ) : results.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No skills match that.</p>
              ) : (
                results.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => pick(skill)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                  >
                    <span className="min-w-0 truncate">{skill.name}</span>
                    {skill.category && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {skill.category}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Difficulty ------------------------------------------------------- */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Difficulty</h2>
        <div role="radiogroup" aria-label="Difficulty" className="grid grid-cols-3 gap-2">
          {PRACTICE_LEVELS.map((lvl) => {
            const active = lvl === level;
            const tone = DIFFICULTY_TONE[lvl];
            return (
              <button
                key={lvl}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onLevelChange(lvl)}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 transition-all",
                  active
                    ? cn(tone.chip, "shadow-glow")
                    : "border-border bg-muted text-muted-foreground hover:border-brand-purple/40 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    active ? tone.dot : "bg-muted-foreground/40",
                  )}
                />
                <span className="text-sm font-semibold">{DIFFICULTY_LABEL[lvl]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Start ------------------------------------------------------------ */}
      <Button
        variant="hero"
        size="lg"
        onClick={onStart}
        disabled={!selected || starting}
        className="w-full gap-2 sm:w-auto"
      >
        {starting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Getting problems…
          </>
        ) : (
          <>
            <Play className="h-4 w-4" />
            Start practicing
          </>
        )}
      </Button>
    </div>
  );
}
