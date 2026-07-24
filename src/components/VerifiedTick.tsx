// The verified-skill tick. Rendered anywhere a teaching skill is named — own
// profile, other people's profiles, explore cards, dashboard matches — so the
// badge means the same thing everywhere it appears.
//
// Hand-rolled SVG rather than lucide's <BadgeCheck> because that icon is
// stroke-only: it draws a blue seal outline with a hollow centre and a blue
// check floating inside it. The Instagram-style badge is the inverse — the
// seal is a solid fill and the check is knocked out of it in white. That needs
// `fill` on the seal path and a white stroke on the check, which you can't get
// out of the lucide component from the outside.
//
// Deliberately NOT a brand token: --brand-cyan is green (#10b981) and
// --brand-blue is violet (#7c3aed), so neither gives the blue a verification
// tick is expected to be. Tailwind's blue scale instead.

// Text/icon blue for labels that sit next to the badge (e.g. the "Verified"
// caption). Lighter in dark mode so it holds up on the dark card backgrounds.
export const VERIFIED_BLUE = "text-blue-600 dark:text-blue-400";

// The seal itself stays saturated in both themes — a white check needs a dark
// enough field behind it, and blue-400 is too pale to carry one.
const VERIFIED_SEAL = "text-blue-600 dark:text-blue-500";

export function VerifiedTick({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Verified skill"
      className={`shrink-0 ${VERIFIED_SEAL} ${className}`}
    >
      <title>Passed a SkillSwap quiz for this skill</title>
      {/* Scalloped seal, filled with the current text colour. */}
      <path
        fill="currentColor"
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
      />
      {/* Check knocked out in white. Heavier stroke than lucide's default so it
          stays legible once it's sitting on a solid field at 14–16px. */}
      <path
        d="m9 12 2 2 4-4"
        fill="none"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
