import type { ThreadItem } from "../../protocol";
import { formatDuration } from "../format";
import { IconChevron, IconTerminal } from "../icons";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

export function CommandCard({ item }: { item: CommandItem }) {
  const running = item.status === "inProgress";
  const failed = item.status === "failed" || (item.exitCode != null && item.exitCode !== 0);
  const output = item.aggregatedOutput ?? "";
  const label = describe(item);
  return (
    <details className={`card cmd ${failed ? "cmd-failed" : ""}`} open={running}>
      <summary>
        <IconChevron size={13} />
        <IconTerminal size={14} />
        <span className={running ? "shimmer" : ""}>{running ? "Running" : item.status === "declined" ? "Declined" : "Ran"}</span>
        <code className="cmd-text">{label}</code>
        <span className="cmd-meta">
          {item.exitCode != null && item.exitCode !== 0 && <span className="bad">exit {item.exitCode}</span>}
          {item.durationMs != null && <span>{formatDuration(item.durationMs)}</span>}
        </span>
      </summary>
      <pre className="cmd-output">
        <span className="cmd-prompt">$ {item.command}</span>
        {"\n"}
        {output || (running ? "" : "(no output)")}
      </pre>
    </details>
  );
}

/** Prefer app-server's parsed action ("Read foo.rs") over the raw shell line. */
function describe(item: CommandItem): string {
  const a = item.commandActions.length === 1 ? item.commandActions[0] : null;
  if (a?.type === "read") return `read ${a.name}`;
  if (a?.type === "listFiles") return `ls ${a.path ?? ""}`.trim();
  if (a?.type === "search") return `search ${a.query ?? ""}${a.path ? ` in ${a.path}` : ""}`;
  return item.command;
}
