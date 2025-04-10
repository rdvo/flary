"use client";

import { Palette, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle() {
  const { isDark, toggleTheme, variation, setThemeVariation } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full h-9 w-9"
          aria-label="Theme options"
        >
          <Palette className="h-4 w-4" />
          <span className="sr-only">Theme options</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={toggleTheme}>
          {isDark ? (
            <Sun className="mr-2 h-4 w-4" />
          ) : (
            <Moon className="mr-2 h-4 w-4" />
          )}
          <span>{isDark ? "Light mode" : "Dark mode"}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setThemeVariation("default")}
          className={variation === "default" ? "bg-accent" : ""}
        >
          Default
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setThemeVariation("blue")}
          className={variation === "blue" ? "bg-accent" : ""}
        >
          Blue
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setThemeVariation("green")}
          className={variation === "green" ? "bg-accent" : ""}
        >
          Green
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setThemeVariation("amber")}
          className={variation === "amber" ? "bg-accent" : ""}
        >
          Amber
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setThemeVariation("purple")}
          className={variation === "purple" ? "bg-accent" : ""}
        >
          Purple
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
