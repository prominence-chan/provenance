// An assistant message. In the token pool's setup thread, a line `[[provenance:pool-key <id>]]`
// (or `<id> add`) becomes a key card (setup/PoolAssist.tsx) in place of the text: the newest one,
// once its turn has finished, takes a key; earlier ones show what came of them. A line
// `[[provenance:pool-steps <id> {…}]]` is the app's (setup/pool-outcome.ts reads it): not shown.

import type { ThreadItem } from "../../protocol";
import { HAS_MARKER, isAssistView, parseNote, splitMarkers } from "../../setup/assist-text";
import { PoolKeyCard } from "../../setup/PoolAssist";
import { useAppState } from "../../store/store";
import { Markdown } from "../Markdown";

type AgentItem = Extract<ThreadItem, { type: "agentMessage" }>;

export function AgentMessage({ item }: { item: AgentItem }) {
  const marked = item.text.includes(HAS_MARKER) || item.text.trimEnd().endsWith("[");
  // "live|outcome text|tone" for this message, in the selected thread; "" when not a setup thread.
  const facts = useAppState((s) => {
    if (!marked) return "";
    const id = s.selectedThreadId;
    const v = id ? s.views[id] : undefined;
    if (!v || !isAssistView(v)) return "";
    const ti = v.turns.findIndex((t) => t.items.some((i) => i.id === item.id));
    if (ti < 0) return "x||";
    const turn = v.turns[ti];
    const lastAgent = turn.items.findLast((i) => i.type === "agentMessage");
    const live =
      ti === v.turns.length - 1 &&
      turn.status !== "inProgress" &&
      lastAgent?.id === item.id &&
      !s.sending;
    const next = v.turns[ti + 1]?.items.find((i) => i.type === "userMessage");
    const c = next?.type === "userMessage" ? next.content[0] : undefined;
    const note = c?.type === "text" ? parseNote(c.text) : null;
    return `${live ? "1" : "0"}|${note?.text ?? ""}|${note?.tone ?? ""}`;
  });
  const threadId = useAppState((s) => s.selectedThreadId);
  if (!facts)
    return (
      <div className="agent-message">
        <Markdown text={item.text} />
      </div>
    );
  const [live, noteText, tone] = facts.split("|");
  const parts = splitMarkers(item.text, !item.completedAtMs);
  const lastCard = parts.findLastIndex((p) => p.kind === "card");
  return (
    <div className="agent-message">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <Markdown key={i} text={p.text} />
        ) : p.kind === "steps" ? null : (
          <PoolKeyCard
            key={`${item.id}-${i}`}
            id={p.id}
            add={p.add}
            threadId={threadId}
            live={live === "1" && i === lastCard}
            outcome={i === lastCard && noteText ? { text: noteText, tone } : null}
          />
        ),
      )}
    </div>
  );
}
