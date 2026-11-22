import { useEffect, useState } from "react";
import { appShell } from "../app-shell";
import { refreshTiers } from "../store/actions";
import { shortPath } from "./format";

interface Health {
  bin: { path: string; exists: boolean };
  router: { url: string; up: boolean; message?: string };
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
        if (wasDown && next.router.up) void refreshTiers();
        wasDown = !next.router.up;
      } catch {
        // server gone: the bridge status (bottom-left) already says so
      }
      const ok = next && next.router.up && next.bin.exists;
      timer = setTimeout(poll, ok ? 30_000 : 4_000);
    };
    void poll();
    return () => clearTimeout(timer);
  }, []);

  if (!health) return null;
  const issues: { key: string; text: string; action?: { label: string; run: () => void } }[] = [];
  if (!health.bin.exists) {
    issues.push({
      key: `bin:${health.bin.path}`,
      text: `Provenance binary not found at ${shortPath(health.bin.path)}.`,
      action: appShell && { label: "Preferences", run: () => void appShell!.openPreferences() },
    });
  }
  if (!health.router.up) {
    const msg = health.router.message;
    issues.push({
      key: `router:${health.router.url}`,
      text: `provenance-core isn't answering at ${health.router.url.replace(/^https?:\/\//, "")}.${msg ? ` ${msg}` : ""}`,
      action:
        appShell && !starting && !msg?.startsWith("Starting")
          ? {
              label: "Start it",
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
          <span className="dot dot-warn" />
          <span className="health-text">
            {starting && i.key.startsWith("router") ? "Starting provenance-core…" : i.text}
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
