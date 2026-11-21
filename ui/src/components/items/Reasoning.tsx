import type { ThreadItem } from "../../protocol";
import { IconChevron, IconThought } from "../icons";
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
    <details className="tool-row reasoning">
      <summary>
        <IconChevron size={11} />
        <IconThought size={13} />
        <span className={`tool-verb ${done ? "" : "shimmer"}`}>
          {done ? "Thought" : "Thinking"}
        </span>
        {headline && <span className="tool-target plain">{headline}</span>}
      </summary>
      <div className="reasoning-body">
        {text ? <Markdown text={text} /> : <div className="muted small">No reasoning text.</div>}
      </div>
    </details>
  );
}
