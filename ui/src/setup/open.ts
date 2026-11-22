// Whether the "Models & accounts" dialog is open, and on which site. Opened from the
// sidebar foot, the tier picker, the app menu, and once on first run when no site is
// signed in (remembered once closed, so it doesn't come back on every launch).

import { useSyncExternalStore } from "react";
import { anySignedIn, getAccounts } from "./web";

export interface SetupOpen {
  open: boolean;
  /** Start on this site's accounts instead of the site list. */
  provider: string | null;
  /** Opened by itself on first run (the site list says why). */
  firstRun: boolean;
  /** Start on the token pool's API keys instead. */
  view?: "keys";
}

const DISMISSED_KEY = "provenance-ui.setup-dismissed";

let state: SetupOpen = { open: false, provider: null, firstRun: false };
const listeners = new Set<() => void>();

function set(next: SetupOpen): void {
  state = next;
  for (const l of listeners) l();
}

export function openSetup(provider: string | null = null, view?: "keys"): void {
  set({ open: true, provider, firstRun: false, view });
}

export function closeSetup(): void {
  if (state.firstRun) {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // private mode: it may show again next launch, which is fine
    }
  }
  set({ open: false, provider: null, firstRun: false });
}

export function useSetupOpen(): SetupOpen {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/**
 * First run: open the dialog when the router has the sign-in API and no site is signed in
 * on any account, unless it was closed before. A router that isn't answering yet (the app's
 * own takes a few seconds to start on a first launch) is waited for, up to a minute; one
 * too old for the API: nothing happens.
 */
export async function maybeOpenFirstRun(): Promise<void> {
  try {
    if (localStorage.getItem(DISMISSED_KEY)) return;
  } catch {
    // fall through
  }
  for (let i = 0; i < 40; i++) {
    const r = await getAccounts();
    if (r.ok) {
      if (!anySignedIn(r.value) && !state.open) set({ open: true, provider: null, firstRun: true });
      return;
    }
    if (r.why === "unsupported") return;
    await new Promise((res) => setTimeout(res, 1500));
  }
}
