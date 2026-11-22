// Which tier effect should be showing right now, derived from the selected thread.
//
// The effect is always on for the selected tier: FlameFx flares when the tier changes
// (and on first load), idles quietly, and rises while a turn streams.
//
// Dev-only preview (stripped from production builds):
//   ?fx=nova            nova, active (as if a turn were streaming)
//   ?fx=nova:idle       nova, idle (after the load flare)
//   ?fx=nova:flare      same as idle; the page load plays the flare
//   __provenanceFx("spark", "flare")   replay spark's switch flare, then idle
//   __provenanceFx("spark", "active")  / "idle"
//   __provenanceFx(null)               back to the real state
import { useSyncExternalStore } from "react";
import { useAppState } from "../../store/store";
import { tierOf, type TierInfo } from "../../theme/tiers";

export interface FxState {
  tier: TierInfo | null;
  /** A turn is in flight (or being started) on the selected thread. */
  streaming: boolean;
  /** Bumped to replay the switch flare without a tier change (dev preview). */
  flareKey: number;
}

type DevMode = "idle" | "active" | "flare";
interface DevFx {
  tier: string;
  mode: DevMode;
  key: number;
}

let devFx: DevFx | null = null;
const devListeners = new Set<() => void>();
if (import.meta.env.DEV) {
  const parse = (tier: string, mode: string | undefined, key: number): DevFx => ({
    tier,
    mode: mode === "idle" || mode === "flare" ? mode : "active",
    key,
  });
  const q = new URLSearchParams(location.search).get("fx");
  if (q) devFx = parse(q.split(":")[0], q.split(":")[1], 0);
  (
    window as unknown as { __provenanceFx: (t: string | null, mode?: DevMode) => void }
  ).__provenanceFx = (t, mode) => {
    devFx = t ? parse(t, mode, (devFx?.key ?? 0) + (mode === "flare" ? 1 : 0)) : null;
    for (const l of devListeners) l();
  };
}

function useDevFx(): DevFx | null {
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
  if (import.meta.env.DEV && dev)
    return { tier: tierOf(dev.tier), streaming: dev.mode === "active", flareKey: dev.key };
  if (running)
    return {
      tier: tierOf(running.model ?? threadModel ?? settingsModel),
      streaming: true,
      flareKey: 0,
    };
  return { tier: tierOf(settingsModel), streaming: sending, flareKey: 0 };
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** prefers-reduced-motion, kept live (the OS setting can change while the app is open). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore((l) => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mq?.addEventListener("change", l);
    return () => mq?.removeEventListener("change", l);
  }, prefersReducedMotion);
}
