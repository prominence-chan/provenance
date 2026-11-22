import { useEffect, useLayoutEffect, useRef } from "react";
import { loadTurnUsage, openThread } from "../store/actions";
import type { TurnView } from "../store/state";
import { useAppState } from "../store/store";
import { Approvals } from "./Approvals";
import { DiffView } from "./DiffView";
import { formatDuration } from "./format";
import { isToolItem, ItemView } from "./items/ItemView";
import { ToolGroup } from "./items/ToolGroup";
import type { ThreadItem } from "../protocol";
import { IconChevron, IconDiff } from "./icons";
import { tierOf } from "../theme/tiers";
import { TierBadge } from "./TierBadge";
import { TurnModels } from "./TurnModels";

/** Centered, scrolling transcript of one thread. */
export function Conversation({ threadId }: { threadId: string }) {
  const view = useAppState((s) => s.views[threadId]);
  // Re-render (and so re-pin to the bottom) when an approval for this thread arrives.
  const pending = useAppState(
    (s) =>
      s.serverRequests.filter((r) => (r.params as { threadId?: string }).threadId === threadId)
        .length,
  );
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
        {view.load === "loading" && !view.turns.length && (
          <div className="muted center-note">Loading thread…</div>
        )}
        {view.load === "error" && (
          <div className="error-card">
            Couldn't load thread: {view.loadError}{" "}
            <button
              className="btn-small"
              onClick={() => void openThread(threadId, { force: true })}
            >
              Retry
            </button>
          </div>
        )}
        {view.turns.map((turn) => (
          <Turn
            key={turn.id}
            threadId={threadId}
            turn={turn}
            model={turn.model ?? view.model}
            waiting={pending > 0}
          />
        ))}
        <Approvals threadId={threadId} />
      </div>
    </div>
  );
}

function Turn({
  threadId,
  turn,
  model,
  waiting,
}: {
  threadId: string;
  turn: TurnView;
  model: string | null;
  waiting: boolean;
}) {
  const running = turn.status === "inProgress";
  const usage = useAppState((s) => s.usage[turn.id]);
  const showFooter = !running && turn.durationMs != null && turn.status === "completed";
  useEffect(() => {
    if (showFooter && !usage) void loadTurnUsage(threadId, turn);
    // once per finished turn (loadTurnUsage reads the turn it is given)
  }, [showFooter, threadId, turn.id]);
  const last = turn.items[turn.items.length - 1];
  const streamingText = running && last?.type === "agentMessage" && !last.completedAtMs;
  return (
    <section className="turn" data-tier={tierOf(model)?.id}>
      {groupItems(turn.items).map((g) =>
        Array.isArray(g) ? (
          <ToolGroup key={g[0].id} items={g} collapsed={!running} />
        ) : (
          <ItemView key={g.id} item={g} />
        ),
      )}
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
          <TierBadge model={model} compact />
          {waiting ? (
            <span className="working-wait">Waiting for your approval</span>
          ) : (
            <span className="shimmer">Working…</span>
          )}
        </div>
      )}
      {turn.status === "interrupted" && <div className="turn-note">Interrupted</div>}
      {turn.diff && !running && (
        <details className="tool-row turn-diff">
          <summary>
            <IconChevron size={11} />
            <IconDiff size={13} />
            <span className="tool-verb">Changes</span>
            <DiffStat diff={turn.diff} />
          </summary>
          <div className="tool-body">
            <DiffView diff={turn.diff} />
          </div>
        </details>
      )}
      {showFooter && (
        <div className="turn-footer">
          <TierBadge model={model} />
          {usage && usage.models.length > 0 && <TurnModels usage={usage} />}
          <span className="turn-dur">Worked for {formatDuration(turn.durationMs!)}</span>
        </div>
      )}
    </section>
  );
}

/** Runs of consecutive tool items (commands, edits, thinking) render as one compact group. */
function groupItems(items: ThreadItem[]): (ThreadItem | ThreadItem[])[] {
  const out: (ThreadItem | ThreadItem[])[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (isToolItem(item)) {
      if (Array.isArray(prev)) prev.push(item);
      else out.push([item]);
    } else out.push(item);
  }
  return out;
}

function DiffStat({ diff }: { diff: string }) {
  let adds = 0;
  let dels = 0;
  let files = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++")) files++;
    else if (l.startsWith("+")) adds++;
    else if (l.startsWith("-") && !l.startsWith("---")) dels++;
  }
  return (
    <span className="tool-target">
      {files} file{files === 1 ? "" : "s"} <span className="good">+{adds}</span>{" "}
      <span className="bad">−{dels}</span>
    </span>
  );
}
