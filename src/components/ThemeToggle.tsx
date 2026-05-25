import { useEffect, useState } from "react";
import { Monitor, Moon, SunMedium } from "lucide-react";
import { useTheme } from "@/lib/theme-context";

const NEXT_LABEL: Record<"system" | "light" | "dark", string> = {
  system: "Switch to light mode",
  light: "Switch to dark mode",
  dark: "Switch to system preference",
};

export function ThemeToggle() {
  const { preference, toggleTheme } = useTheme();
  // SSR can't read localStorage, so the server always renders "system" (Monitor).
  // After mount, switch to the real preference. Dark-mode colors are already
  // applied to <html> by themeInitScript before hydration, so swapping just the
  // icon does not flash. Without this, the server's "system" output and the
  // client's "light"/"dark" output mismatch and React regenerates the subtree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const resolved = mounted ? preference : "system";
  const Icon = resolved === "dark" ? Moon : resolved === "light" ? SunMedium : Monitor;

  return (
    <button
      type="button"
      aria-label={NEXT_LABEL[resolved]}
      title={NEXT_LABEL[resolved]}
      onClick={toggleTheme}
      className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
