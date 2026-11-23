import { splitBrief } from "../../fallback/brief";
import type { ThreadItem } from "../../protocol";
import { parseNote, splitAssistBrief } from "../../setup/assist-text";

type UserItem = Extract<ThreadItem, { type: "userMessage" }>;

export function UserMessage({ item }: { item: UserItem }) {
  const first = item.content[0];
  // What the app told the token pool's setup assistant (a key saved, skipped): a quiet line.
  const note = item.content.length === 1 && first?.type === "text" ? parseNote(first.text) : null;
  if (note)
    return (
      <div className="assist-sent" data-tone={note.tone}>
        <span
          className={`dot ${note.tone === "ok" ? "dot-ok" : note.tone === "off" ? "dot-off" : "dot-warn"}`}
        />
        <span>{note.text}</span>
        <span className="meta">sent by Provenance</span>
      </div>
    );
  return (
    <div className="user-message">
      <div className="user-bubble">
        {item.content.map((c, i) => {
          switch (c.type) {
            case "text": {
              // The token pool's setup assistant starts with its brief: folded.
              const a = splitAssistBrief(c.text);
              if (a)
                return (
                  <span key={i}>
                    <details className="user-brief">
                      <summary>Setup brief for the assistant</summary>
                      {a.brief}
                    </details>
                    {a.rest}
                  </span>
                );
              // A thread carried over from another one starts with a brief of it: folded.
              const b = splitBrief(c.text);
              if (!b) return <span key={i}>{c.text}</span>;
              return (
                <span key={i}>
                  <details className="user-brief">
                    <summary>Brief of the earlier thread</summary>
                    {b.brief}
                  </details>
                  {b.rest}
                </span>
              );
            }
            case "localImage":
              return (
                <span key={i} className="chip">
                  image: {c.path}
                </span>
              );
            case "mention":
            case "skill":
              return (
                <span key={i} className="chip">
                  @{c.name}
                </span>
              );
            default:
              return (
                <span key={i} className="chip">
                  {c.type}
                </span>
              );
          }
        })}
      </div>
    </div>
  );
}
