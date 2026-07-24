import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Skill = { id: string; name: string; category: string | null };

// Selection-only. The catalog is curated (see the
// 20260724000000_curated_skill_catalog.sql migration), so this component can
// only ever hand back the name of a skill that is already in `skills` — there
// is no path for the user to introduce a new one. Typing filters the list; it
// never becomes a value of its own.
type SkillComboboxProps = {
  skills: Skill[];
  /** The currently chosen skill name. Always a catalog entry, or empty. */
  value: string;
  /** Called with the picked catalog skill's canonical name. */
  onChange: (name: string) => void;
  /**
   * Called when the user commits a skill by pressing Enter. Receives the chosen
   * name so the parent can add it without waiting for the `onChange` state
   * update to flush.
   */
  onCommit?: (name: string) => void;
  /** Skill ids already added; hidden from the list so they can't be picked twice. */
  excludeIds?: string[];
  placeholder?: string;
  className?: string;
};

// Only caps the searched list. Browsing (empty query) renders the whole catalog
// grouped by category — it is curated and bounded, so there is nothing to
// truncate and a cut-off list would hide entire categories below the letter C.
const MAX_RESULTS = 60;

export function SkillCombobox({
  skills,
  value,
  onChange,
  onCommit,
  excludeIds = [],
  placeholder = "Search a skill…",
  className,
}: SkillComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const trimmed = query.trim();

  // Ranked, flat, and capped while searching. Prefix beats substring so typing
  // "gui" puts Guitar above Classical Guitar, and a category hit ranks last so
  // "music" still surfaces every instrument without burying name matches.
  const matches = useMemo(() => {
    const pool = skills.filter((s) => !excluded.has(s.id));
    const q = trimmed.toLowerCase();
    if (!q) return pool;
    return pool
      .map((s) => {
        const at = s.name.toLowerCase().indexOf(q);
        if (at === 0) return { skill: s, rank: 0 };
        if (at > 0) return { skill: s, rank: 1 };
        if ((s.category ?? "").toLowerCase().includes(q)) return { skill: s, rank: 2 };
        return null;
      })
      .filter((hit): hit is { skill: Skill; rank: number } => hit !== null)
      .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
      .slice(0, MAX_RESULTS)
      .map((hit) => hit.skill);
  }, [skills, excluded, trimmed]);

  // Browsing view only. ~380 catalog entries in one alphabetical run is
  // unreadable, so an empty query gets category headings instead. While
  // searching the list stays flat: the ranking above is the point, and
  // regrouping it would put something other than the best match at the top,
  // which is what Enter commits.
  const grouped = useMemo(() => {
    if (trimmed) return null;
    const byCategory = new Map<string, Skill[]>();
    for (const skill of matches) {
      const key = skill.category ?? "Other";
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(skill);
      else byCategory.set(key, [skill]);
    }
    return Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches, trimmed]);

  // What Enter commits: an exact name match if the user typed one in full,
  // otherwise the top of the filtered list. Never the raw typed text — that is
  // the whole point of a selection-only picker.
  const enterTarget = useMemo(() => {
    if (!trimmed) return null;
    const exact = skills.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
    if (exact && !excluded.has(exact.id)) return exact;
    return matches[0] ?? null;
  }, [skills, excluded, trimmed, matches]);

  const choose = (name: string) => {
    onChange(name);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          onKeyDown={(e) => {
            // After picking from the list the popover closes and focus returns
            // here — let Enter add the chosen skill instead of reopening it.
            if (e.key === "Enter" && !open && onCommit && value.trim()) {
              e.preventDefault();
              e.stopPropagation();
              onCommit(value);
            }
          }}
          className={cn(
            "glass flex h-10 w-full items-center justify-between gap-2 rounded-md border border-white/10 px-3 text-left text-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--radix-popover-trigger-width) overflow-hidden rounded-md p-0 focus-visible:outline-none [&_:focus-visible]:outline-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <div className="flex h-11 items-center border-b px-3" cmdk-input-wrapper="">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter with no match is a no-op rather than a silent failure —
                // the empty state below already explains why nothing happened.
                if (e.key === "Enter" && enterTarget) {
                  e.preventDefault();
                  const name = enterTarget.name;
                  if (onCommit) {
                    onChange(name);
                    setQuery("");
                    setOpen(false);
                    onCommit(name);
                  } else {
                    choose(name);
                  }
                }
              }}
              placeholder={placeholder}
              style={{ outline: "none" }}
              className="h-full w-full bg-transparent text-sm placeholder:text-muted-foreground"
            />
          </div>
          <CommandList>
            {matches.length === 0 && !trimmed && <CommandEmpty>Loading skills…</CommandEmpty>}
            {matches.length === 0 && trimmed && (
              <CommandEmpty>
                <span className="block">
                  No skill matches “<span className="font-medium text-foreground">{trimmed}</span>”.
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  SkillSwap has a curated catalog. Ask an admin to add a skill that is missing.
                </span>
              </CommandEmpty>
            )}
            {grouped
              ? grouped.map(([category, items]) => (
                  <CommandGroup key={category} heading={category}>
                    {items.map((s) => (
                      <SkillOption key={s.id} skill={s} value={value} onChoose={choose} />
                    ))}
                  </CommandGroup>
                ))
              : matches.length > 0 && (
                  <CommandGroup>
                    {matches.map((s) => (
                      <SkillOption
                        key={s.id}
                        skill={s}
                        value={value}
                        onChoose={choose}
                        showCategory
                      />
                    ))}
                  </CommandGroup>
                )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// The trailing category label is redundant under a category heading, so it only
// renders in the flat (searching) list.
function SkillOption({
  skill,
  value,
  onChoose,
  showCategory = false,
}: {
  skill: Skill;
  value: string;
  onChoose: (name: string) => void;
  showCategory?: boolean;
}) {
  return (
    <CommandItem value={skill.id} onSelect={() => onChoose(skill.name)}>
      <Check
        className={cn(
          "h-4 w-4",
          value.toLowerCase() === skill.name.toLowerCase() ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="truncate">{skill.name}</span>
      {showCategory && skill.category && (
        <span className="ml-auto truncate text-xs text-muted-foreground">{skill.category}</span>
      )}
    </CommandItem>
  );
}
