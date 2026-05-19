import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  toggleTheme: () => void;
};

const THEME_STORAGE_KEY = "skillswap-theme";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  theme: "light",
  setPreference: () => {},
  toggleTheme: () => {},
});

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(SYSTEM_QUERY).matches ? "dark" : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return readSystemTheme();
  return preference;
}

function applyTheme(theme: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function getStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Lazy init so the very first client render already has the right value,
  // matching what `themeInitScript` wrote to <html> before hydration. The
  // previous "default light, fix in useEffect" pattern caused a one-frame
  // flash of light-mode UI for dark-mode users.
  // SSR returns "system" → "light" deterministically; client reconciles on mount.
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredPreference);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(getStoredPreference()));

  useEffect(() => {
    // Re-sync once on mount in case SSR computed "light" but the OS / stored
    // preference says otherwise. Cheap no-op when they already match.
    const storedPreference = getStoredPreference();
    if (storedPreference !== preference) setPreferenceState(storedPreference);
    const resolved = resolveTheme(storedPreference);
    setTheme(resolved);
    applyTheme(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for OS-level theme changes while the user is on the "system"
  // preference. When they pick an explicit light/dark we stop reacting to the
  // OS — that's the whole point of an explicit preference.
  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return;

    const media = window.matchMedia(SYSTEM_QUERY);
    const handleChange = () => {
      const resolved: ResolvedTheme = media.matches ? "dark" : "light";
      setTheme(resolved);
      applyTheme(resolved);
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    const resolved = resolveTheme(next);
    setTheme(resolved);
    applyTheme(resolved);
  };

  const toggleTheme = () => {
    // Cycle: system → light → dark → system. Predictable order makes the
    // 3-state toggle button feel like a regular UI control.
    const next: ThemePreference =
      preference === "system" ? "light" : preference === "light" ? "dark" : "system";
    setPreference(next);
  };

  return (
    <ThemeContext.Provider value={{ preference, theme, setPreference, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  return useContext(ThemeContext);
}

export const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var preference = (stored === 'dark' || stored === 'light' || stored === 'system') ? stored : 'system';
    var theme = preference;
    if (preference === 'system') {
      theme = window.matchMedia('${SYSTEM_QUERY}').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
})();
`;
