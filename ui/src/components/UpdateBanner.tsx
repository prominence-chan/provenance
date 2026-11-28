import { useState } from "react";
import {
  downloadUpdate,
  installUpdate,
  openSettings,
  useUpdateState,
} from "../setup/settings-store";

/** Slim one-line strip under the header when an update is available, downloading, ready, or failed. */
export function UpdateBanner() {
  const state = useUpdateState();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!state) return null;
  const { phase, available, progress, error } = state;
  if (phase === "idle" || phase === "checking" || phase === "up-to-date") return null;

  const key = `${phase}:${available?.version ?? error ?? ""}`;
  if (dismissedKey === key && phase !== "installing") return null;

  const ver = available ? `v${available.version}` : "Update";
  let dotClass = "dot-busy";
  let text = "";
  let primaryLabel: string | null = null;
  let primaryAccent = false;
  let onPrimary: (() => void) | null = null;
  const canDismiss = phase !== "downloading" && phase !== "installing";

  if (phase === "available" && available) {
    dotClass = "dot-update";
    text = `Provenance ${ver} is available`;
    primaryLabel = available.installMode === "manual" ? "View release" : "Download";
    primaryAccent = true;
    onPrimary = () => void downloadUpdate();
  } else if (phase === "downloading") {
    dotClass = "dot-busy";
    const pct = progress?.percent ?? 0;
    text = `Downloading Provenance ${ver}… ${pct}%`;
  } else if (phase === "ready") {
    dotClass = "dot-ok";
    text = `Provenance ${ver} is ready to install`;
    primaryLabel = "Restart to update";
    primaryAccent = true;
    onPrimary = () => void installUpdate();
  } else if (phase === "installing") {
    dotClass = "dot-busy";
    text = `Installing Provenance ${ver}… Restarting shortly`;
  } else if (phase === "error") {
    dotClass = "dot-warn";
    text = error || "Update failed";
    primaryLabel = "Details";
    onPrimary = () => openSettings("updates");
  } else {
    return null;
  }

  return (
    <div className="update-banner" data-phase={phase} role="status">
      <div className="health-row">
        <span className={`dot ${dotClass}`} />
        <span className="health-text update-banner-text">
          <span>{text}</span>
          {phase === "downloading" && progress && (
            <span className="setup-meter update-banner-meter" aria-hidden>
              <span style={{ width: `${Math.max(4, progress.percent)}%` }} />
            </span>
          )}
        </span>
        {available && phase !== "installing" && (
          <button type="button" className="update-link-btn" onClick={() => openSettings("updates")}>
            Details
          </button>
        )}
        {primaryLabel && onPrimary && (
          <button
            type="button"
            className={primaryAccent ? "health-btn update-btn-primary" : "health-btn"}
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        )}
        {canDismiss && (
          <button
            type="button"
            className="icon-btn health-x"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setDismissedKey(key)}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
