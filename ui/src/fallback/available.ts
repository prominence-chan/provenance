// Which fallbacks can take a thread now: turned on by the user and healthy on this Mac.

import type {
  FallbackCli,
  FallbackMode,
  FallbackModel,
  FallbacksInfo,
} from "../../shared/fallback-api";
import type { FallbackPrefs } from "../store/state";

export interface Fallback {
  /** "claude", "codex", or "antigravity" (the picker row). */
  cli: FallbackCli;
  name: string;
  /** How turns run: claude, codex (in the background), codex-pv (through Provenance), or antigravity. */
  mode: FallbackMode;
  /** Turned on and healthy. */
  ready: boolean;
  /** Turned on (by the user). */
  on: boolean;
  models: FallbackModel[];
  /** Why it isn't ready, in a few words. */
  problem: string | null;
}

export function fallbacks(prefs: FallbackPrefs, info: FallbacksInfo | null): Fallback[] {
  const c = info?.claude;
  const x = info?.codex;
  const a = info?.antigravity;
  const claudeOk = !!c?.installed && c.signedIn !== false && !c.problem;
  const pv = prefs.codex === "provenance";
  const codexOk = pv ? !!x?.provenance.ready : !!x?.installed && x.signedIn !== false && !x.problem;
  const agyOk = !!a?.installed && a.signedIn !== false && !a.problem;
  return [
    {
      cli: "claude",
      name: "Claude Code",
      mode: "claude",
      on: prefs.claude,
      ready: prefs.claude && claudeOk,
      models: c?.models ?? [{ id: "", label: "Default" }],
      problem: !prefs.claude ? "Off" : (c?.problem ?? (info ? null : "Checking…")),
    },
    {
      cli: "codex",
      name: "Codex",
      mode: pv ? "codex-pv" : "codex",
      on: prefs.codex !== "off",
      ready: prefs.codex !== "off" && codexOk,
      models: (pv ? x?.provenance.models : x?.models) ?? [{ id: "", label: "Default" }],
      problem:
        prefs.codex === "off"
          ? "Off"
          : ((pv ? x?.provenance.problem : x?.problem) ?? (info ? null : "Checking…")),
    },
    {
      cli: "antigravity",
      name: "Antigravity",
      mode: "antigravity",
      on: prefs.antigravity,
      ready: prefs.antigravity && agyOk,
      models: a?.models ?? [{ id: "", label: "Default" }],
      problem: !prefs.antigravity ? "Off" : (a?.problem ?? (info ? null : "Checking…")),
    },
  ];
}
