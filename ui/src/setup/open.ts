// Whether the "Models & accounts" dialog is open, and on which site; and whether the welcome is.
// Models & accounts opens from the sidebar foot, the tier picker, the app menu and the welcome.
// The welcome opens once on first run when nothing is set up (no site signed in, no API key,
// no fallback; remembered once closed or finished), and again from the app menu.

import { useSyncExternalStore } from "react";
import { getPoolKeys, getAccounts, anySignedIn } from "./web";

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
}

/** Leave the welcome for Models & accounts, coming back to it when that closes. */
export function welcomeToSetup(provider: string | null, view?: "keys", firstRun = false): void {
  welcome = { ...welcome, open: false };
  emit();
  openSetup(provider, view, { returnTo: "welcome", firstRun });
}

/**
 * First run: open the welcome when nothing is set up — no site signed in on any account, no API
 * key in the token pool, no fallback turned on — unless it was closed before. A router that
 * isn't answering yet (the app's own takes a few seconds to start on a first launch) is waited
 * for, up to a minute; one too old for the sign-in API: nothing happens.
 */
export async function maybeOpenWelcome(fallbacksOn: () => boolean): Promise<void> {
  try {
    if (localStorage.getItem(WELCOME_DONE_KEY)) return;
  } catch {
    // fall through
  }
  for (let i = 0; i < 40; i++) {
    const r = await getAccounts();
    if (r.ok) {
      if (anySignedIn(r.value) || fallbacksOn()) return;
      const pool = await getPoolKeys();
      if (pool.ok && pool.value.some((p) => p.usable && !p.anonymous)) return;
      if (!state.open && !welcome.open) openWelcome("intro");
      return;
    }
    if (r.why === "unsupported") return;
    await new Promise((res) => setTimeout(res, 1500));
  }
}
