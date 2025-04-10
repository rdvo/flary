import { createContext, useContext, useEffect, useState } from "react";

// Define theme variations
type ThemeVariation = "default" | "blue" | "green" | "amber" | "purple";

interface ThemeContextType {
  isDark: boolean;
  toggleTheme: () => void;
  variation: ThemeVariation;
  setThemeVariation: (variation: ThemeVariation) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(false);
  const [variation, setVariation] = useState<ThemeVariation>("default");

  useEffect(() => {
    // Check for saved theme preference or use system preference
    const savedTheme = localStorage.getItem("theme-mode");
    const savedVariation =
      (localStorage.getItem("theme-variation") as ThemeVariation) || "default";

    // Set theme variation
    setVariation(savedVariation);
    applyThemeClasses(savedVariation);

    if (savedTheme === "dark") {
      document.documentElement.classList.add("dark");
      setIsDark(true);
    } else if (savedTheme === "light") {
      document.documentElement.classList.remove("dark");
      setIsDark(false);
    } else {
      // No preference set, check system preference
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;
      if (prefersDark) {
        document.documentElement.classList.add("dark");
        setIsDark(true);
      } else {
        document.documentElement.classList.remove("dark");
        setIsDark(false);
      }
    }
  }, []);

  const applyThemeClasses = (variation: ThemeVariation) => {
    // Remove all theme classes
    document.documentElement.classList.remove(
      "theme-default",
      "theme-blue",
      "theme-green",
      "theme-amber",
      "theme-purple"
    );

    // Apply theme variation
    document.documentElement.classList.add(`theme-${variation}`);
  };

  const toggleTheme = () => {
    if (isDark) {
      // Switch to light mode
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme-mode", "light");
      setIsDark(false);
    } else {
      // Switch to dark mode
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme-mode", "dark");
      setIsDark(true);
    }
  };

  const setThemeVariation = (newVariation: ThemeVariation) => {
    setVariation(newVariation);
    localStorage.setItem("theme-variation", newVariation);
    applyThemeClasses(newVariation);
  };

  return (
    <ThemeContext.Provider
      value={{
        isDark,
        toggleTheme,
        variation,
        setThemeVariation,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
