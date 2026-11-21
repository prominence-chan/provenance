// Which fire effect should be showing right now, derived from the selected thread.
//
// Dev-only override (stripped from production builds): open the UI with
// `?fx=solstice` or `?fx=nova`, or call `__provenanceFx("nova")` / `__provenanceFx(null)`
// in the console, to preview the streaming effects without running a turn.
import { useSyncExternalStore } from "react";
import { useAppState } from "../../store/store";
import { tierOf, type TierInfo } from "../../theme/tiers";

export interface FxState {
  tier: TierInfo | null;
  /** A turn is in flight (or being started) on the selected thread. */
  streaming: boolean;
}

let devFx: string | null = null;
const devListeners = new Set<() => void>();
if (import.meta.env.DEV) {
  devFx = new URLSearchParams(location.search).get("fx");
  (window as unknown as { __provenanceFx: (t: string | null) => void }).__provenanceFx = (t) => {
    devFx = t;
    for (const l of devListeners) l();
  };
}

function useDevFx(): string | null {
  return useSyncExternalStore(
    (l) => {
      devListeners.add(l);
      return () => devListeners.delete(l);
    },
    () => devFx,
  );
}

export function useFx(): FxState {
  const dev = useDevFx();
  const settingsModel = useAppState((s) => s.settings.model);
  const sending = useAppState((s) => s.sending);
  const running = useAppState((s) => {
    const v = s.selectedThreadId ? s.views[s.selectedThreadId] : undefined;
    return v?.turns.findLast((t) => t.status === "inProgress");
  });
  const threadModel = useAppState((s) =>
    s.selectedThreadId ? s.views[s.selectedThreadId]?.model : null,
  );
  if (import.meta.env.DEV && dev) return { tier: tierOf(dev), streaming: true };
  if (running)
    return { tier: tierOf(running.model ?? threadModel ?? settingsModel), streaming: true };
  return { tier: tierOf(settingsModel), streaming: sending };
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
