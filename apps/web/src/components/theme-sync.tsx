"use client";
import { useLayoutEffect } from "react";
import type { ThemePreference } from "@hullwise/ui/tokens";

/**
 * Keeps the `dark` class right for the "system" preference after client-side refreshes (the
 * inline script in <head> only runs on the first load). Explicit themes are rendered by the server.
 */
export function ThemeSync({ theme }: { theme: ThemePreference }) {
  useLayoutEffect(() => {
    if (theme !== "system") return;
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", m.matches);
    apply();
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, [theme]);
  return null;
}
