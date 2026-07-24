// Height-accurate stand-ins for TeacherSlotPicker.
//
// Loading states inside a modal are not a cosmetic choice. A dialog is centred
// with `translate(-50%, -50%)`, so any change in its height moves all four of
// its edges at once. A one-line spinner that is later replaced by a 110px
// picker therefore doesn't "fill in" — it shoves the whole panel outward, and
// with the teacher-window fetch, the auto-fill and the chunk load each landing
// at a different moment you get several of those shoves in the first second of
// a dialog being open. That stutter is what reads as jitter.
//
// So these mirror the real controls exactly: same wrappers, same paddings, same
// font sizes, with transparent text standing in for the labels so every line
// box matches. Swapping skeleton for content changes nothing about the layout.
//
// Deliberately in its own module rather than inside TeacherSlotPicker: the
// picker is code-split, and the Suspense fallback that covers its chunk load
// obviously cannot live inside the chunk it is waiting for.

/** The "Best times:" chip row. Used on its own by TeacherSlotPicker while the
 *  teacher's windows are in flight. */
export function SuggestionChipsSkeleton({
  withCustomToggle = false,
}: {
  withCustomToggle?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2" aria-hidden>
      <span className="shrink-0 text-[11px] text-muted-foreground">Best times:</span>
      <div className="grid min-w-0 flex-1 grid-cols-3 gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="min-w-0 rounded-xl border border-brand-purple/20 bg-brand-purple/5 px-1.5 py-1 text-center leading-tight"
          >
            <span className="block truncate text-[11px] font-semibold text-transparent">
              <span className="animate-pulse rounded bg-brand-purple/20">Tomorrow</span>
            </span>
            <span className="block truncate text-[10px] text-transparent">
              <span className="animate-pulse rounded bg-brand-purple/15">10:00 AM</span>
            </span>
          </div>
        ))}
      </div>
      {withCustomToggle && (
        <span className="shrink-0 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-transparent">
          Custom…
        </span>
      )}
    </div>
  );
}

/** The whole picker: chips, the date/time row, and the reserved status line.
 *  `compact` matches the picker's own prop — chips only, with the "Custom…"
 *  toggle instead of the expanded controls. */
export function SlotPickerSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-2" aria-hidden>
      <SuggestionChipsSkeleton withCustomToggle={compact} />
      {!compact && (
        <>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="animate-pulse rounded-xl border border-border bg-muted px-3 py-2.5 text-sm text-transparent">
              Pick a date
            </div>
            <div className="min-w-[120px] animate-pulse rounded-xl border border-border bg-muted px-3 py-2.5 text-sm text-transparent">
              Time
            </div>
          </div>
          {/* The line the picker reserves for the echoed date. */}
          <div className="min-h-4" />
        </>
      )}
    </div>
  );
}
