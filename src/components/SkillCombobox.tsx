import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
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

type SkillComboboxProps = {
  skills: Skill[];
  /** The currently chosen skill name (may be a custom value not in `skills`). */
  value: string;
  /** Called with the picked name — an existing catalog skill or a new custom one. */
  onChange: (name: string) => void;
  /**
   * Called when the user commits a skill by pressing Enter in the search box.
   * Receives the chosen name so the parent can add it without waiting for the
   * `onChange` state update to flush.
   */
  onCommit?: (name: string) => void;
  /** Skill ids already added; hidden from the list so they can't be picked twice. */
  excludeIds?: string[];
  placeholder?: string;
  className?: string;
};

const MAX_RESULTS = 50;

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

  const matches = useMemo(() => {
    const q = trimmed.toLowerCase();
    return skills
      .filter((s) => !excluded.has(s.id))
      .filter((s) => (q ? s.name.toLowerCase().includes(q) : true))
      .slice(0, MAX_RESULTS);
  }, [skills, excluded, trimmed]);

  // Offer "Add …" only when the typed text isn't already an exact catalog match.
  const hasExactMatch = useMemo(
    () => skills.some((s) => s.name.toLowerCase() === trimmed.toLowerCase()),
    [skills, trimmed],
  );

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
                if (e.key === "Enter" && trimmed) {
                  e.preventDefault();
                  // Resolve to a catalog skill's canonical name when it matches,
                  // otherwise commit the typed text as a new custom skill.
                  const exact = skills.find(
                    (s) => s.name.toLowerCase() === trimmed.toLowerCase(),
                  );
                  const name = exact ? exact.name : trimmed;
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
            {matches.length === 0 && !trimmed && (
              <CommandEmpty>Type to search skills…</CommandEmpty>
            )}
            {matches.length > 0 && (
              <CommandGroup>
                {matches.map((s) => (
                  <CommandItem key={s.id} value={s.id} onSelect={() => choose(s.name)}>
                    <Check
                      className={cn(
                        "h-4 w-4",
                        value.toLowerCase() === s.name.toLowerCase() ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{s.name}</span>
                    {s.category && (
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {s.category}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmed && !hasExactMatch && (
              <CommandGroup>
                <CommandItem value={`__add__${trimmed}`} onSelect={() => choose(trimmed)}>
                  <Plus className="h-4 w-4" />
                  <span className="truncate">
                    Add “<span className="font-medium text-foreground">{trimmed}</span>”
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
