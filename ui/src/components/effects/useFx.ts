// Which tier effect should be showing right now, derived from the selected thread. A fallback
// (Claude Code, Codex) has an effect of its own too, in its own colour.
//
// The effect is always on for the selected tier or fallback: FlameFx flares when the tier changes
// (and on first load), idles quietly, and rises while a turn streams.
//
// Dev-only preview (stripped from production builds):
//   ?fx=nova            nova, active (as if a turn were streaming)
//   ?fx=nova:idle       nova, idle (after the load flare)
//   ?fx=nova:flare      same as idle; the page load plays the flare
//   ?fx=claude          a fallback: claude or codex
//   &fxspeed=0.1        slow motion (every effect's clock runs at that rate)
//   &fxuptime=86400     start every effect's clock as if the app had been open that long
//                       (seconds): for checking that nothing degrades over days
//   &fxtrace            record every frame's layer state in window.__provenanceFxTrace (the
//                       write head's place and speed, Codex's sweep), for checking motion headless
//   &sunseed=7          the hero sun's nebulae use seeds 7, 8, ... (style and palette by seed)
//   &sunstep            the hero sun's clock stands still; __provenanceSunStep(seconds) moves it
//                       and returns the sequence state, for frame-by-frame checks headless
//   ?fx=none:idle       no effect (then __provenanceFx(...) selects one from nothing)
//   __provenanceFx("spark", "flare")   replay spark's switch flare, then idle
//   __provenanceFx("spark", "active")  / "idle"
//   __provenanceFx(null)               back to the real state
import { useSyncExternalStore } from "react";
import type { FallbackCli } from "../../../shared/fallback-api";
import { fallbackOf } from "../../fallback/model";
import { useAppState } from "../../store/store";
import { tierOf, type TierInfo } from "../../theme/tiers";

export interface FxState {
  tier: TierInfo | null;
  /** The selected model is a fallback instead (tier is null then). */
  fallback: FallbackCli | null;
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
    return {
      ...identity(dev.tier === "claude" || dev.tier === "codex" ? `${dev.tier}:` : dev.tier),
      streaming: dev.mode === "active",
      flareKey: dev.key,
    };
  if (running)
    return {
      ...identity(running.model ?? threadModel ?? settingsModel),
      streaming: true,
      flareKey: 0,
    };
  return { ...identity(settingsModel), streaming: sending, flareKey: 0 };
}

function identity(model: string | null | undefined): Pick<FxState, "tier" | "fallback"> {
  return { tier: tierOf(model), fallback: fallbackOf(model) };
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Dev only (?fxuptime=s): seconds every effect's clock starts at. 0 in production. */
export const devUptime = import.meta.env.DEV
  ? Number(new URLSearchParams(location.search).get("fxuptime")) || 0
  : 0;

/** prefers-reduced-motion, kept live (the OS setting can change while the app is open). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore((l) => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mq?.addEventListener("change", l);
    return () => mq?.removeEventListener("change", l);
  }, prefersReducedMotion);
}
