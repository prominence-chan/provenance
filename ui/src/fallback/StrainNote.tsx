// Under a tier thread whose history has outgrown the free models (strain.ts): one line, with a
// button per ready fallback that moves the conversation there (the same thread goes on, its model
// handed a brief it never shows, and carries on with the work), or a link to set one up.
// Dismissible; once per thread unless it gets clearly worse.

import { useState } from "react";
import { openSetup } from "../setup/open";
import { backendOf, continueElsewhere } from "../store/actions";
import { useAppState } from "../store/store";
import { IconClose } from "../setup/parts";
import { fallbacks } from "./available";
import { dismissStrain, shouldShow, threadStrain } from "./strain";

export function StrainNote({ threadId }: { threadId: string }) {
  const view = useAppState((s) => s.views[threadId]);
  const usage = useAppState((s) => s.usage);
  const prefs = useAppState((s) => s.settings.fallbacks);
  const info = useAppState((s) => s.fallbackInfo);
  const sending = useAppState((s) => s.sending);
  const [, setTick] = useState(0);
  if (!view || backendOf(threadId) !== "main") return null;
  if (view.turns.some((t) => t.status === "inProgress")) return null;
  const strain = threadStrain(view, usage);
  if (!shouldShow(threadId, strain)) return null;
  const ready = fallbacks(prefs, info).filter((f) => f.ready);
  return (
    <div className="strain-note" role="status" title={strain.reasons.join("; ")}>
      <span className="strain-text">
        This thread has grown too large for the free models to handle well.
      </span>
      <span className="strain-actions">
        {ready.length ? (
          ready.map((f) => (
            <button
              key={f.cli}
              className="btn"
              disabled={sending}
              onClick={() => void continueElsewhere(threadId, `${f.mode}:`)}
            >
              Continue in {f.name}
            </button>
          ))
        ) : (
          <button className="btn" onClick={() => openSetup(null, "fallbacks")}>
            Set up Codex or Claude Code…
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => {
            dismissStrain(threadId, strain.score);
            setTick((n) => n + 1);
          }}
        >
          <IconClose />
        </button>
      </span>
    </div>
  );
}
