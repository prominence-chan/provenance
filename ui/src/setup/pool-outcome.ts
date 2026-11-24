// What each provider's key setup came to, sent to the router (POST /pool/help/{id}/outcome) so
// its guide gets better for the next person: the result, rough minutes from the key card shown
// (or the provider opened) to saved, and, in the assisted flow, which steps went as written and
// what the site's controls were called where they differed, from the assistant's
// `[[provenance:pool-steps <id> {…}]]` line in its message after the provider.
//
// Never a key, an e-mail address or anything else about the person: every string is scrubbed
// (assist-text.ts `scrub`) and capped here, whatever the assistant wrote. A router without the
// route (an older one) is left alone after its first 404.

import type { OutcomePost, OutcomeResult } from "../../shared/router-api";
import { getState, subscribe } from "../store/store";
import { scrub, splitMarkers, stepReport, type KeyOutcome, type StepReport } from "./assist-text";
import { postPoolOutcome, type PoolHelp } from "./web";

/** Waiting this long for the assistant's steps line, the outcome goes without it. */
const WAIT_MS = 5 * 60_000;

let unsupported = false;
let help: PoolHelp[] = [];
let unsub: (() => void) | null = null;

const k = (thread: string, provider: string) => `${thread}\n${provider}`;
/** When each provider's key card was first shown in a thread. */
const shown = new Map<string, number>();
/** A result waiting for the assistant's steps line (its next turn). */
const pending = new Map<
  string,
  { thread: string; provider: string; body: OutcomePost; turns: number; timer: number }
>();
/** Sent since the provider's last card: a later steps line for it is not a new attempt. */
const closed = new Set<string>();
/** A steps line that came with the provider's own card, before its result. */
const early = new Map<string, StepReport>();
/** Per thread, the assistant messages already read. */
const tracks = new Map<string, Set<string>>();

const resultOf = (o: KeyOutcome): OutcomeResult | null =>
  o.kind === "working" || o.kind === "saved"
    ? "saved_working"
    : o.kind === "rejected"
      ? "saved_rejected"
      : o.kind === "skipped"
        ? "skipped"
        : null;

const minutesSince = (start: number | undefined) =>
  start === undefined ? {} : { minutes: Math.max(0, Math.round((Date.now() - start) / 60_000)) };

/** The body as it goes out: only the contract's fields, every string scrubbed and capped. */
export function cleanOutcome(b: OutcomePost, h: PoolHelp[] = help): OutcomePost {
  const out: OutcomePost = {
    result: b.result,
    source: b.source === "manual" ? "manual" : "assistant",
  };
  if (typeof b.minutes === "number" && Number.isFinite(b.minutes))
    out.minutes = Math.min(600, Math.max(0, Math.round(b.minutes)));
  const notes = (b.step_notes ?? [])
    .filter((n) => Number.isInteger(n.step) && n.step >= 1 && n.step <= 50)
    .slice(0, 30)
    .map((n) => {
      const note = n.note ? scrub(n.note, h) : "";
      return note ? { step: n.step, ok: n.ok === true, note } : { step: n.step, ok: n.ok === true };
    });
  if (notes.length) out.step_notes = notes;
  const labels = [...new Set((b.labels_seen ?? []).map((l) => scrub(l, h, 60)).filter(Boolean))];
  if (labels.length) out.labels_seen = labels.slice(0, 12);
  return out;
}

function send(provider: string, body: OutcomePost): void {
  if (unsupported) return;
  void postPoolOutcome(provider, cleanOutcome(body)).then((ok) => {
    if (!ok) unsupported = true;
  });
}

function watch(thread: string): void {
  if (!tracks.has(thread)) {
    // What the thread holds already (its history) was read before: only new messages count.
    const seen = new Set<string>();
    for (const t of getState().views[thread]?.turns ?? [])
      for (const i of t.items) if (i.type === "agentMessage") seen.add(i.id);
    tracks.set(thread, seen);
  }
  unsub ??= subscribe(onChange);
}

function onChange(): void {
  for (const [thread, seen] of tracks) {
    const v = getState().views[thread];
    if (!v) continue;
    for (const t of v.turns)
      for (const i of t.items) {
        if (i.type !== "agentMessage" || seen.has(i.id)) continue;
        if (!i.completedAtMs && t.status === "inProgress") continue;
        seen.add(i.id);
        const parts = splitMarkers(i.text);
        for (const p of parts)
          if (p.kind === "steps")
            onSteps(
              thread,
              p.id,
              p.raw,
              parts.some((c) => c.kind === "card" && c.id === p.id),
            );
      }
    // A result whose next turn finished without a steps line for it: sent as it is.
    for (const [key, p] of pending)
      if (
        p.thread === thread &&
        v.turns
          .slice(p.turns)
          .some((t) => t.status !== "inProgress" && t.items.some((i) => i.type === "agentMessage"))
      )
        flush(key);
  }
}

function onSteps(thread: string, provider: string, raw: string, withCard: boolean): void {
  const key = k(thread, provider);
  const rep = stepReport(raw, help) ?? {};
  const p = pending.get(key);
  if (p) {
    window.clearTimeout(p.timer);
    pending.delete(key);
    closed.add(key);
    return send(provider, { ...p.body, ...rep });
  }
  // Written beside the provider's own card, before anything was saved: kept for its result.
  if (withCard) return void early.set(key, rep as StepReport);
  if (closed.has(key)) return;
  // The assistant moved on and nothing was saved or skipped: the person gave up on it.
  closed.add(key);
  send(provider, {
    result: "gave_up",
    source: "assistant",
    ...minutesSince(shown.get(key)),
    ...rep,
  });
  shown.delete(key);
}

function flush(key: string): void {
  const p = pending.get(key);
  if (!p) return;
  window.clearTimeout(p.timer);
  pending.delete(key);
  closed.add(key);
  send(p.provider, p.body);
}

/** A key card for this provider is up in the assistant's thread. */
export function cardShown(thread: string, provider: string, h: PoolHelp[] | undefined): void {
  if (h?.length) help = h;
  const key = k(thread, provider);
  if (!shown.has(key)) shown.set(key, Date.now());
  closed.delete(key);
  watch(thread);
}

/** What came of a provider in the assistant's thread (its card, or a key caught in the composer). */
export function assistResult(thread: string, provider: string, o: KeyOutcome): void {
  const result = resultOf(o);
  if (!result) return;
  const key = k(thread, provider);
  const body: OutcomePost = { result, source: "assistant", ...minutesSince(shown.get(key)) };
  shown.delete(key);
  const notes = early.get(key);
  if (notes) {
    early.delete(key);
    closed.add(key);
    return send(provider, { ...body, ...notes });
  }
  const old = pending.get(key);
  if (old) window.clearTimeout(old.timer);
  watch(thread);
  pending.set(key, {
    thread,
    provider,
    body,
    turns: getState().views[thread]?.turns.length ?? 0,
    timer: window.setTimeout(() => flush(key), WAIT_MS),
  });
}

/** A key saved on the keys page: the result and how long since the provider was opened. */
export function manualResult(provider: string, o: KeyOutcome, openedAt: number | null): void {
  const result = resultOf(o);
  if (!result || result === "skipped") return;
  send(provider, { result, source: "manual", ...minutesSince(openedAt ?? undefined) });
}
