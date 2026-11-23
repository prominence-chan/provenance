// Whether the "Models & accounts" dialog is open, and on which site; and whether the welcome is;
// and what is still not set up.
// Models & accounts opens from the sidebar foot, the tier picker, the app menu and the welcome.
// The welcome opens by itself once, while something is still not set up (no site signed in, no
// API key of your own in the token pool, or no fallback switched on; remembered once closed or
// finished), and again from the app menu and the sidebar's "Finish setting up".

import { useSyncExternalStore } from "react";
import type { FallbackPrefs } from "../store/state";
import { getState, useAppState } from "../store/store";
import { getPoolKeys, getAccounts, anySignedIn, type PoolProvider, type WebAccounts } from "./web";

export interface SetupOpen {
  open: boolean;
  /** Start on this site's accounts instead of the site list. */
  provider: string | null;
  /** Opened for someone with nothing signed in yet (the site list says why). */
  firstRun: boolean;
  /** Start on the token pool's API keys, or on the fallbacks, instead. */
  view?: "keys" | "fallbacks";
  /** Closing it goes back to the welcome. */
  returnTo?: "welcome";
}

export interface WelcomeOpen {
  open: boolean;
  /** The step to (re)open on. */
  step: WelcomeStep;
}

export type WelcomeStep = "intro" | "models" | "fallbacks" | "done";

const WELCOME_DONE_KEY = "provenance-ui.welcome-done";

let state: SetupOpen = { open: false, provider: null, firstRun: false };
let welcome: WelcomeOpen = { open: false, step: "intro" };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function set(next: SetupOpen): void {
  state = next;
  emit();
}

export function openSetup(
  provider: string | null = null,
  view?: "keys" | "fallbacks",
  opts: { returnTo?: "welcome"; firstRun?: boolean } = {},
): void {
  set({ open: true, provider, firstRun: opts.firstRun ?? false, view, returnTo: opts.returnTo });
}

export function closeSetup(): void {
  const back = state.returnTo;
  set({ open: false, provider: null, firstRun: false });
  if (back === "welcome") openWelcome("models");
  void refreshSetupKnown();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useSetupOpen(): SetupOpen {
  return useSyncExternalStore(subscribe, () => state);
}

export function useWelcomeOpen(): WelcomeOpen {
  return useSyncExternalStore(subscribe, () => welcome);
}

export function openWelcome(step: WelcomeStep = "intro"): void {
  welcome = { open: true, step };
  emit();
}

/** Closed (skipped) or finished: it doesn't open by itself again. */
export function closeWelcome(): void {
  try {
    localStorage.setItem(WELCOME_DONE_KEY, "1");
  } catch {
    // private mode: it may show again next launch, which is fine
  }
  welcome = { ...welcome, open: false };
  emit();
  void refreshSetupKnown();
}

/** Leave the welcome for Models & accounts, coming back to it when that closes. */
export function welcomeToSetup(provider: string | null, view?: "keys", firstRun = false): void {
  welcome = { ...welcome, open: false };
  emit();
  openSetup(provider, view, { returnTo: "welcome", firstRun });
}

// ---- what is still not set up ---------------------------------------------------------------

/** What the router says is set up; null until it has answered (or when it is too old to say). */
interface Known {
  sites: boolean;
  keys: boolean;
}
let known: Known | null = null;

/** Each part true while it is still missing. */
export interface SetupGaps {
  /** No chat site signed in on any account. */
  sites: boolean;
  /** No usable API key of your own in the token pool. */
  keys: boolean;
  /** Neither Claude Code nor Codex switched on. */
  fallbacks: boolean;
}

export const fallbacksDecided = (f: FallbackPrefs) => f.claude || f.codex !== "off";

/** What the router's answers say is set up (the welcome's own reads come through here too). */
export function noteSetup(accounts: WebAccounts, pool: PoolProvider[] | null): void {
  const next = {
    sites: anySignedIn(accounts),
    keys: !!pool?.some((p) => p.usable && !p.anonymous),
  };
  if (known && known.sites === next.sites && known.keys === next.keys) return;
  known = next;
  emit();
}

/** Read it again (after Models & accounts or the welcome closes). Down or too old: unchanged. */
export async function refreshSetupKnown(): Promise<"ok" | "down" | "unsupported"> {
  const [a, p] = await Promise.all([getAccounts(), getPoolKeys()]);
  if (!a.ok) return a.why;
  noteSetup(a.value, p.ok ? p.value : null);
  return "ok";
}

function gapsOf(k: Known, f: FallbackPrefs): SetupGaps | null {
  const g = { sites: !k.sites, keys: !k.keys, fallbacks: !fallbacksDecided(f) };
  return g.sites || g.keys || g.fallbacks ? g : null;
}

/** What is still missing; null when everything is set up, or before the router has said. */
export function useSetupGaps(): SetupGaps | null {
  const k = useSyncExternalStore(subscribe, () => known);
  const f = useAppState((s) => s.settings.fallbacks);
  return k ? gapsOf(k, f) : null;
}

/** The welcome's first step with something left to do. */
export function firstGapStep(g: SetupGaps | null): WelcomeStep {
  if (!g) return "intro";
  return g.sites || g.keys ? "models" : g.fallbacks ? "fallbacks" : "done";
}

/**
 * Opens the welcome by itself once: while anything is still not set up — no site signed in on
 * any account, no API key of your own in the token pool, or no fallback switched on — unless it
 * was closed or finished before. Either way it learns what is set up, for the sidebar's "Finish
 * setting up". A router that isn't answering yet (the app's own takes a few seconds to start on
 * a first launch) is waited for, up to a minute; one too old for the sign-in API: nothing
 * happens.
 */
export async function maybeOpenWelcome(): Promise<void> {
  let seen = false;
  try {
    seen = !!localStorage.getItem(WELCOME_DONE_KEY);
  } catch {
    // fall through
  }
  for (let i = 0; i < 40; i++) {
    const r = await refreshSetupKnown();
    if (r === "unsupported") return;
    if (r === "ok") {
      if (
        !seen &&
        known &&
        gapsOf(known, getState().settings.fallbacks) &&
        !state.open &&
        !welcome.open
      )
        openWelcome("intro");
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}
