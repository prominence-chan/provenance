import type { ThreadItem } from "../../protocol";
import { IconChevron, IconTool } from "../icons";

/** Fallback for item types without a dedicated renderer (MCP tools, web search, ...). */
export function GenericItem({ item }: { item: ThreadItem }) {
  const title = titleFor(item);
  const { id: _id, type: _type, ...rest } = item as ThreadItem & Record<string, unknown>;
  return (
    <details className="card generic">
      <summary>
        <IconChevron size={13} />
        <IconTool size={14} />
        <span>{title}</span>
      </summary>
      <pre className="cmd-output">{JSON.stringify(rest, null, 2)}</pre>
    </details>
  );
}

function titleFor(item: ThreadItem): string {
  switch (item.type) {
    case "mcpToolCall":
      return `${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return `${item.namespace ? item.namespace + "." : ""}${item.tool}`;
    case "webSearch":
      return "Web search";
    case "imageView":
      return `Viewed image ${item.path}`;
    default:
      return item.type;
  }
}
