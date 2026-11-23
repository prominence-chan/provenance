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
  // Such a thread's first message: a quiet line says where it came from, the brief never shows.
  const carried =
    first?.type === "text" && !splitAssistBrief(first.text) ? splitBrief(first.text) : null;
  if (carried && !carried.rest && item.content.length === 1)
    return <p className="carry-line">This was continued from another conversation</p>;
  return (
    <>
      {carried && <p className="carry-line">This was continued from another conversation</p>}
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
                // A thread carried over from another one, before conversations stayed one thread:
                // it starts with a brief of the other. Only what the person wrote shows.
                const b = splitBrief(c.text);
                return <span key={i}>{b ? b.rest : c.text}</span>;
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
    </>
  );
}
