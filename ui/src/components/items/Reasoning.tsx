import type { ThreadItem } from "../../protocol";
import { Markdown } from "../Markdown";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

/** Collapsed by default, like Codex desktop's "Thinking". */
export function Reasoning({ item }: { item: ReasoningItem }) {
  const summary = item.summary.filter(Boolean).join("\n\n");
  const raw = item.content.filter(Boolean).join("\n\n");
  const text = summary || raw;
  const done = item.completedAtMs != null;
  const headline = /\*\*(.+?)\*\*/.exec(summary)?.[1];
  return (
    <details className="reasoning">
      <summary>
        <span className={done ? "" : "shimmer"}>{done ? "Thought" : "Thinking"}</span>
        {headline && <span className="muted"> · {headline}</span>}
      </summary>
      {text ? <Markdown text={text} /> : <div className="muted small">No reasoning text.</div>}
    </details>
  );
}
