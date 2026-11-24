// Minimal external store + React hook (no extra state library).
//
//   const x = useAppState((s) => s.something);
//   setState((s) => ({ ...s, something: 1 }));
//
// Keep selectors cheap and return stable references (pick existing objects
// rather than building new ones) so components only re-render on change.

import { useSyncExternalStore } from "react";
import { initialState, type AppState } from "./state";

let state: AppState = initialState();
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(update: (s: AppState) => AppState): void {
  const next = update(state);
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}
