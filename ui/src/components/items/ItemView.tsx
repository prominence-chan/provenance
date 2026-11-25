// Dispatch a ThreadItem to its renderer. To render a new item type, add a
// component in this folder and a case here (the switch is typed from the
// generated ThreadItem union).
import { memo } from "react";
import type { ThreadItem } from "../../protocol";
import { Markdown } from "../Markdown";
import { AgentMessage } from "./AgentMessage";
import { CollabAgentCard } from "./CollabAgentCard";
import { CommandCard } from "./CommandCard";
import { FileChangeCard } from "./FileChangeCard";
import { GenericItem } from "./GenericItem";
import { Reasoning } from "./Reasoning";
import { UserMessage } from "./UserMessage";

const TOOL_TYPES = new Set<ThreadItem["type"]>([
  "reasoning",
  "commandExecution",
  "fileChange",
  "collabAgentToolCall",
  "subAgentActivity",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageView",
]);

/** Items that render as one-line tool rows (grouped together in a turn). */
export function isToolItem(item: ThreadItem): boolean {
  return TOOL_TYPES.has(item.type);
}

export const ItemView = memo(function ItemView({ item }: { item: ThreadItem }) {
  switch (item.type) {
    case "userMessage":
      return <UserMessage item={item} />;
    case "agentMessage":
      return <AgentMessage item={item} />;
    case "reasoning":
      return <Reasoning item={item} />;
    case "commandExecution":
      return <CommandCard item={item} />;
    case "fileChange":
      return <FileChangeCard item={item} />;
    case "collabAgentToolCall":
    case "subAgentActivity":
      return <CollabAgentCard item={item} />;
    case "plan":
      return (
        <div className="plan">
          <div className="plan-label">Plan</div>
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
