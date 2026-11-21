import type { ThreadItem } from "../../protocol";
import { IconChevron, IconTool } from "../icons";

/** Fallback for item types without a dedicated renderer (MCP tools, web search, ...). */
export function GenericItem({ item }: { item: ThreadItem }) {
  const { verb, target } = titleFor(item);
  const { id: _id, type: _type, ...rest } = item as ThreadItem & Record<string, unknown>;
  return (
    <details className="tool-row generic">
      <summary>
        <IconChevron size={11} />
        <IconTool size={13} />
        <span className="tool-verb">{verb}</span>
        {target && <code className="tool-target">{target}</code>}
      </summary>
      <div className="tool-body">
        <pre className="cmd-output">{JSON.stringify(rest, null, 2)}</pre>
      </div>
    </details>
  );
}

function titleFor(item: ThreadItem): { verb: string; target?: string } {
  switch (item.type) {
    case "mcpToolCall":
      return { verb: "Called", target: `${item.server}.${item.tool}` };
    case "dynamicToolCall":
      return {
        verb: "Called",
        target: `${item.namespace ? item.namespace + "." : ""}${item.tool}`,
      };
    case "webSearch":
      return { verb: "Searched the web" };
    case "imageView":
      return { verb: "Viewed", target: item.path };
    default:
      return { verb: item.type };
  }
}
