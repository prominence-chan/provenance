// Light/dark switch. Dark is the default; the choice is stored separately from the
// app settings and applied as <html data-theme="...">.
import { useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light";

const KEY = "provenance-ui.theme";
const listeners = new Set<() => void>();

function read(): ThemeMode {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let mode: ThemeMode = read();

export function applyTheme(): void {
  document.documentElement.dataset.theme = mode;
}

export function setTheme(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // private mode etc.: still switch for this session
  }
  applyTheme();
  for (const l of listeners) l();
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => mode,
  );
}
