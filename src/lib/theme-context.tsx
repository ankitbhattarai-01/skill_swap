import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
};

const THEME_STORAGE_KEY = "skillswap-theme";

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  toggleTheme: () => {},
});

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Lazy init so the very first client render already has the right value,
  // matching what `themeInitScript` wrote to <html> before hydration. The
  // previous "default light, fix in useEffect" pattern caused a one-frame
  // flash of light-mode UI for dark-mode users.
  // SSR returns "light" deterministically; client picks up localStorage.
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    // Re-sync once on mount in case SSR computed "light" but localStorage
    // says otherwise. Cheap no-op when they already match.
    const storedTheme = getStoredTheme();
    if (storedTheme !== theme) setTheme(storedTheme);
    applyTheme(storedTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  return useContext(ThemeContext);
}

export const themeInitScript = `
(function() {
  try {
    var theme = localStorage.getItem('${THEME_STORAGE_KEY}') === 'dark' ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
})();
`;
