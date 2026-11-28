import { useEffect, useState } from "react";
import type { RouterInfo, UiHealth as Health } from "../../shared/router-api";
import { appShell } from "../app-shell";
import { openSettings } from "../setup/settings-store";
import { refreshSources, refreshTiers } from "../store/actions";
import { shortPath } from "./format";

/** The app is bringing a router up right now: say so, without an alarm or a button. */
const busy = (r: RouterInfo) => /^(Starting|Waiting)/.test(r.message ?? "");

/** What's wrong with the router, in a sentence for someone who may not know it by name. */
function routerText(r: RouterInfo): string {
  if (busy(r))
    return r.message === "Starting provenance-core…"
      ? "Starting Provenance's model router…"
      : r.message!;
  if (r.mode === "bundled")
    return `Provenance's model router isn't answering.${r.message ? ` ${r.message}` : ""}`;
  const where = r.url.replace(/^https?:\/\//, "");
  return `Your provenance-core at ${where} isn't answering.${r.message ? ` ${r.message}` : ""}`;
}

/** One-line strip under the header when provenance-core is down or the binary is missing. */
export function HealthBanner() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let wasDown = false;
    const poll = async () => {
      let next: Health | null = null;
      try {
        next = (await (await fetch("/api/health")).json()) as Health;
        setHealth(next);
        if (wasDown && next.router.up) {
          void refreshTiers();
          void refreshSources();
        }
        wasDown = !next.router.up;
      } catch {
        // server gone: the bridge status (bottom-left) already says so
      }
      const ok = next && next.router.up && next.bin.exists;
      // fast while the app's own router comes up, so the strip goes as soon as it answers
      timer = setTimeout(poll, ok ? 30_000 : next && busy(next.router) ? 1000 : 4000);
    };
    void poll();
    return () => clearTimeout(timer);
  }, []);

  if (!health) return null;
  const issues: {
    key: string;
    text: string;
    busy?: boolean;
    action?: { label: string; run: () => void };
  }[] = [];
  if (!health.bin.exists) {
    issues.push({
      key: `bin:${health.bin.path}`,
      text: `The provenance agent isn't installed at ${shortPath(health.bin.path)}, so threads can't run. Set provenanceBin in Settings if it's elsewhere.`,
      action: appShell && { label: "Settings", run: () => openSettings("advanced") },
    });
  }
  if (!health.router.up) {
    issues.push({
      key: `router:${health.router.url}`,
      text: routerText(health.router),
      busy: busy(health.router),
      action:
        appShell && !starting && !busy(health.router)
          ? {
              label: health.router.mode === "bundled" ? "Restart it" : "Retry",
              run: () => {
                setStarting(true);
                void appShell!.startRouter().finally(() => setStarting(false));
              },
            }
          : undefined,
    });
  }
  const shown = issues.filter((i) => i.key !== dismissed);
  if (!shown.length) return null;

  return (
    <div className="health-banner" role="status">
      {shown.map((i) => (
        <div key={i.key} className="health-row">
          <span className={`dot ${i.busy ? "dot-busy" : "dot-warn"}`} />
          <span className="health-text">
            {starting && i.key.startsWith("router")
              ? "Starting Provenance's model router…"
              : i.text}
          </span>
          {i.action && (
            <button className="health-btn" onClick={i.action.run}>
              {i.action.label}
            </button>
          )}
          <button
            className="icon-btn health-x"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setDismissed(i.key)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
