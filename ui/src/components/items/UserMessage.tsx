import { splitBrief } from "../../fallback/brief";
import type { ThreadItem } from "../../protocol";

type UserItem = Extract<ThreadItem, { type: "userMessage" }>;

export function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="user-message">
      <div className="user-bubble">
        {item.content.map((c, i) => {
          switch (c.type) {
            case "text": {
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
