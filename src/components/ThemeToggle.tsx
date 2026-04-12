import { Moon, SunMedium } from "lucide-react";
import { useTheme } from "@/lib/theme-context";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggleTheme}
      className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {isDark ? <Moon className="h-4 w-4" /> : <SunMedium className="h-4 w-4" />}
    </button>
  );
}
