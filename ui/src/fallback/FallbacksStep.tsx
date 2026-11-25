// Claude Code and Codex as fallbacks: each one's health (installed, runs, signed in) and a switch,
// and for Codex how its turns run. Used by Models & accounts (its Fallbacks page) and by the
// welcome. The checks are the server's (GET /api/fallbacks): local commands, no usage spent.

import { useEffect, useState } from "react";
import type { CliHealth, FallbacksInfo } from "../../shared/fallback-api";
import { Status } from "../setup/parts";
import { refreshFallbacks, setFallbackPrefs } from "../store/actions";
import type { FallbackPrefs } from "../store/state";
import { useAppState } from "../store/store";

export function FallbacksStep({ lead }: { lead?: boolean }) {
  const info = useAppState((s) => s.fallbackInfo);
  const prefs = useAppState((s) => s.settings.fallbacks);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    await refreshFallbacks(true);
    setChecking(false);
  };
  useEffect(() => {
    void check();
  }, []);

  return (
    <div className="setup-step fallbacks-step">
      {lead !== false && (
        <p className="setup-lead">
          When a thread gets too big for the free models, continue it in Claude Code, Codex, or
          Antigravity using your own subscription.
        </p>
      )}
      <ul className="setup-sites">
        <li>
          <CliRow
            name="Claude Code"
            health={info?.claude ?? null}
            on={prefs.claude}
            onToggle={(on) => setFallbackPrefs({ claude: on })}
            note={prefs.claude ? NO_ASK : undefined}
          />
        </li>
        <li>
          <CliRow
            name="Codex"
            health={info?.codex ?? null}
            on={prefs.codex !== "off"}
            onToggle={(on) =>
              setFallbackPrefs({
                codex: on ? (info?.codex.provenance.ready ? "provenance" : "background") : "off",
              })
            }
            // Codex Desktop signs you in too: "through Provenance" works without the CLI.
            usable={!!info && (healthy(info.codex) || info.codex.provenance.ready)}
          />
          {prefs.codex !== "off" && info && <CodexMode info={info} prefs={prefs} />}
        </li>
        <li>
          <CliRow
            name="Antigravity"
            health={info?.antigravity ?? null}
            on={prefs.antigravity}
            onToggle={(on) => setFallbackPrefs({ antigravity: on })}
            note={prefs.antigravity ? NO_ASK : undefined}
          />
        </li>
      </ul>
      <button className="setup-add" onClick={() => void check()} disabled={checking}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

const healthy = (h: CliHealth) => h.installed && h.signedIn !== false && !h.problem;

/** Claude Code and Codex in the background can't ask for approval (server/fallback/backend.ts). */
const NO_ASK = "Can't ask for approval: Ask every time runs without asking, like Auto";

function CliRow({
  name,
  health: h,
  on,
  onToggle,
  usable,
  note,
}: {
  name: string;
  health: CliHealth | null;
  on: boolean;
  onToggle: (on: boolean) => void;
  usable?: boolean;
  /** One line about how it runs, under the row. */
  note?: string;
}) {
  const ok = usable ?? (!!h && healthy(h));
  let status = <Status cls="dot-busy" text="Checking…" />;
  if (h && !h.installed) status = <Status cls="dot-off" text="Not installed" />;
  else if (h && h.problem) status = <Status cls="dot-err" text={h.problem} />;
  else if (h) status = <Status cls="dot-ok" text="Ready" />;
  const detail = h?.installed ? [h.version, h.account].filter(Boolean).join(" · ") : null;
  return (
    <div className="fallback-row" data-cli={h?.id ?? name.toLowerCase()}>
      <label className="setup-switch-row">
        <span className="setup-mono" aria-hidden>
          {name === "Codex" ? "Cx" : name === "Antigravity" ? "Ag" : "CC"}
        </span>
        <span className="setup-switch-text">
          <span className="setup-site-name">{name}</span>
          {detail && <span className="meta">{detail}</span>}
        </span>
        {status}
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label={`Use ${name}`}
          checked={on}
          disabled={!on && !ok}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </label>
      {note && ok && <p className="meta fallback-note">{note}</p>}
      {h?.fix && (
        <p className="meta fallback-fix">
          {fixParts(h.fix).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : p.text))}
        </p>
      )}
    </div>
  );
}

/** "Run `codex login` in a terminal" -> text and code parts; "Install it with: cmd" -> cmd as code. */
function fixParts(fix: string): { text: string; code: boolean }[] {
  const colon = /^(.*?:\s)(.+)$/.exec(fix);
  if (colon && !fix.includes("`"))
    return [
      { text: colon[1], code: false },
      { text: colon[2], code: true },
    ];
  return fix.split("`").map((text, i) => ({ text, code: i % 2 === 1 }));
}

function CodexMode({ info, prefs }: { info: FallbacksInfo; prefs: FallbackPrefs }) {
  const pv = info.codex.provenance;
  const bgOk = healthy(info.codex);
  const choice = (
    mode: "background" | "provenance",
    label: string,
    text: string,
    ok: boolean,
    problem: string | null,
  ) => (
    <label className="fallback-mode" data-mode={mode} aria-disabled={!ok || undefined}>
      <input
        type="radio"
        name="codex-mode"
        checked={prefs.codex === mode}
        disabled={!ok}
        onChange={() => setFallbackPrefs({ codex: mode })}
      />
      <span className="setup-switch-text">
        <span>{label}</span>
        <span className="meta">{ok ? text : problem}</span>
      </span>
    </label>
  );
  return (
    <div className="fallback-modes" role="radiogroup" aria-label="How Codex runs">
      {choice(
        "provenance",
        "Run Codex through Provenance",
        "Runs each turn on your Codex account with history trimming, inline diffs, and approvals.",
        pv.ready,
        pv.problem,
      )}
      {choice(
        "background",
        "Codex in the background",
        `The codex command runs each turn on its own. ${NO_ASK}`,
        bgOk,
        info.codex.problem,
      )}
    </div>
  );
}
