import type { ThreadItem } from "../../protocol";

type UserItem = Extract<ThreadItem, { type: "userMessage" }>;

export function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="user-message">
      <div className="user-bubble">
        {item.content.map((c, i) => {
          switch (c.type) {
            case "text":
              return <span key={i}>{c.text}</span>;
            case "localImage":
              return <span key={i} className="chip">image: {c.path}</span>;
            case "mention":
            case "skill":
              return <span key={i} className="chip">@{c.name}</span>;
            default:
              return <span key={i} className="chip">{c.type}</span>;
          }
        })}
      </div>
    </div>
  );
}
