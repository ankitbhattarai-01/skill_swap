import { Monitor, Moon, SunMedium } from "lucide-react";
import { useTheme } from "@/lib/theme-context";

const NEXT_LABEL: Record<"system" | "light" | "dark", string> = {
  system: "Switch to light mode",
  light: "Switch to dark mode",
  dark: "Switch to system preference",
};

export function ThemeToggle() {
  const { preference, toggleTheme } = useTheme();
  const Icon = preference === "dark" ? Moon : preference === "light" ? SunMedium : Monitor;

  return (
    <button
      type="button"
      aria-label={NEXT_LABEL[preference]}
      title={NEXT_LABEL[preference]}
      onClick={toggleTheme}
      className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
