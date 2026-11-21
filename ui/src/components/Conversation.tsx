import { useEffect, useLayoutEffect, useRef } from "react";
import { openThread } from "../store/actions";
import type { TurnView } from "../store/state";
import { useAppState } from "../store/store";
import { Approvals } from "./Approvals";
import { DiffView } from "./DiffView";
import { formatDuration } from "./format";
import { ItemView } from "./items/ItemView";

/** Centered, scrolling transcript of one thread. */
export function Conversation({ threadId }: { threadId: string }) {
  const view = useAppState((s) => s.views[threadId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Stay pinned to the bottom while streaming, unless the user scrolled up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [threadId]);

  if (!view) return <div className="conversation" />;

  return (
    <div className="conversation" ref={scrollRef} onScroll={onScroll}>
      <div className="conversation-inner">
        {view.load === "loading" && !view.turns.length && <div className="muted center-note">Loading thread…</div>}
        {view.load === "error" && (
          <div className="error-card">
            Couldn't load thread: {view.loadError}{" "}
            <button className="btn-small" onClick={() => void openThread(threadId, { force: true })}>
              Retry
            </button>
          </div>
        )}
        {view.turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        <Approvals threadId={threadId} />
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: TurnView }) {
  const running = turn.status === "inProgress";
  const last = turn.items[turn.items.length - 1];
  const streamingText = running && last?.type === "agentMessage" && !last.completedAtMs;
  return (
    <section className="turn">
      {turn.items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
      {turn.errors
        .filter((e) => e.willRetry)
        .slice(-1)
        .map((e, i) => (
          <div key={i} className="turn-note warn">
            {e.message} — retrying…
          </div>
        ))}
      {turn.error && <div className="error-card">{turn.error.message}</div>}
      {running && !streamingText && (
        <div className="working">
          <span className="shimmer">Working…</span>
        </div>
      )}
      {turn.status === "interrupted" && <div className="turn-note">Interrupted</div>}
      {turn.diff && !running && (
        <details className="card turn-diff">
          <summary>Turn diff</summary>
          <DiffView diff={turn.diff} />
        </details>
      )}
      {!running && turn.durationMs != null && turn.status === "completed" && (
        <div className="turn-footer">Worked for {formatDuration(turn.durationMs)}</div>
      )}
    </section>
  );
}
