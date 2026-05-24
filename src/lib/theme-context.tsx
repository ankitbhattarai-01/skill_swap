import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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
  preference: "light",
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
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  return "light";
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

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    const resolved = resolveTheme(next);
    setTheme(resolved);
    applyTheme(resolved);
  }, []);

  // Use the functional setState form so the cycle reads the latest preference
  // without closing over a stale `preference` value — that lets toggleTheme
  // stay reference-stable across renders.
  const toggleTheme = useCallback(() => {
    setPreferenceState((current) => {
      const next: ThemePreference =
        current === "system" ? "light" : current === "light" ? "dark" : "system";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      const resolved = resolveTheme(next);
      setTheme(resolved);
      applyTheme(resolved);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, theme, setPreference, toggleTheme }),
    [preference, theme, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  return useContext(ThemeContext);
}

export const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var preference = (stored === 'dark' || stored === 'light' || stored === 'system') ? stored : 'light';
    var theme = preference;
    if (preference === 'system') {
      theme = window.matchMedia('${SYSTEM_QUERY}').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
})();
`;
