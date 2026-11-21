// Dispatch a ThreadItem to its renderer. To render a new item type, add a
// component in this folder and a case here (the switch is typed from the
// generated ThreadItem union).
import { memo } from "react";
import type { ThreadItem } from "../../protocol";
import { Markdown } from "../Markdown";
import { CommandCard } from "./CommandCard";
import { FileChangeCard } from "./FileChangeCard";
import { GenericItem } from "./GenericItem";
import { Reasoning } from "./Reasoning";
import { UserMessage } from "./UserMessage";

export const ItemView = memo(function ItemView({ item }: { item: ThreadItem }) {
  switch (item.type) {
    case "userMessage":
      return <UserMessage item={item} />;
    case "agentMessage":
      return (
        <div className="agent-message">
          <Markdown text={item.text} />
        </div>
      );
    case "reasoning":
      return <Reasoning item={item} />;
    case "commandExecution":
      return <CommandCard item={item} />;
    case "fileChange":
      return <FileChangeCard item={item} />;
    case "plan":
      return (
        <div className="card plan">
          <div className="card-label">Plan</div>
          <Markdown text={item.text} />
        </div>
      );
    case "contextCompaction":
      return <div className="divider">Context compacted</div>;
    case "hookPrompt":
    case "functionCallOutput":
      return null;
    default:
      return <GenericItem item={item} />;
  }
});
