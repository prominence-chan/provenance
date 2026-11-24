// Discord Rich Presence, the page's part: tells the desktop app (electron/discord-presence.ts)
// only the coarse state: the selected tier or fallback, its orchestrator, whether a turn is
// running, and since when. Never a thread title, prompt, path, model output or account. Not mounted in a browser.

import { useEffect, useRef } from "react";
import { appShell, type PresenceReport } from "./app-shell";
import { fallbackOf } from "./fallback/model";
import { threadOrchestrator } from "./orchestrator/thread";
import { isThreadActive, type AppState, type ThreadView } from "./store/state";
import { servingThreadId } from "./store/segments";
import { useAppState } from "./store/store";
import { tierOf } from "./theme/tiers";

const running = (v: ThreadView | undefined) => v?.turns.findLast((t) => t.status === "inProgress");

/** The report as a string, so the selector stays stable between unrelated changes. */
function presenceKey(s: AppState): string {
  const sel = s.selectedThreadId ? s.views[s.selectedThreadId] : undefined;
  const view = running(sel) ? sel : Object.values(s.views).find((v) => running(v));
  const turn = running(view);
  const working = !!turn || s.sending || s.threads.some((t) => isThreadActive(t.status));
  const model = (working && turn?.model) || s.settings.model;
  const tier = tierOf(model)?.id ?? null;
  // The thread shown or running names its own orchestrator; with none open, the one new threads get.
  const threadId = turn
    ? Object.keys(s.views).find((id) => s.views[id] === view)
    : s.selectedThreadId;
  const report: PresenceReport = {
    kind: tier ?? fallbackOf(model) ?? null,
    orchestrator: tier
      ? threadId
        ? threadOrchestrator(servingThreadId(s, threadId))
        : s.settings.orchestrator
      : null,
    working,
    since: turn?.startedAt ? turn.startedAt * 1000 : null,
  };
  return JSON.stringify(report);
}

export function PresenceReporter(): null {
  const key = useAppState(presenceKey);
  const firstSeen = useRef<number | null>(null);
  useEffect(() => {
    const r = JSON.parse(key) as PresenceReport;
    // Sending, or a turn whose start the page hasn't heard yet: time it from when it was seen.
    if (!r.working) firstSeen.current = null;
    else if (firstSeen.current === null) firstSeen.current = Date.now();
    appShell?.setPresence?.({ ...r, since: r.working ? (r.since ?? firstSeen.current) : null });
  }, [key]);
  return null;
}
