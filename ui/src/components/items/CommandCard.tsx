import type { ThreadItem } from "../../protocol";
import { formatDuration } from "../format";
import { IconChevron, IconEye, IconFolder, IconSearch, IconTerminal } from "../icons";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

/** One line ("Ran npm test · 5.5s"), output on demand. Open while it runs. */
export function CommandCard({ item }: { item: CommandItem }) {
  const running = item.status === "inProgress";
  const failed = item.status === "failed" || (item.exitCode != null && item.exitCode !== 0);
  const output = item.aggregatedOutput ?? "";
  const { verb, target, Icon } = describe(item, running);
  return (
    <details className={`tool-row cmd ${failed ? "failed" : ""}`} open={running}>
      <summary title={item.command}>
        <IconChevron size={11} />
        <Icon size={13} />
        <span className={`tool-verb ${running ? "shimmer" : ""}`}>
          {item.status === "declined" ? "Declined" : verb}
        </span>
        <code className="tool-target">{target}</code>
        <span className="tool-meta">
          {item.exitCode != null && item.exitCode !== 0 && (
            <span className="bad">exit {item.exitCode}</span>
          )}
          {item.durationMs != null && (
            <span className="tool-dur">{formatDuration(item.durationMs)}</span>
          )}
        </span>
      </summary>
      <div className="tool-body">
        <pre className="cmd-output">
          <span className="cmd-prompt">$ {item.command}</span>
          {"\n"}
          {output || (running ? "" : "(no output)")}
        </pre>
      </div>
    </details>
  );
}

/** Prefer app-server's parsed action ("Read foo.rs") over the raw shell line. */
function describe(item: CommandItem, running: boolean) {
  const a = item.commandActions.length === 1 ? item.commandActions[0] : null;
  if (a?.type === "read")
    return { verb: running ? "Reading" : "Read", target: a.name, Icon: IconEye };
  if (a?.type === "listFiles")
    return { verb: running ? "Listing" : "Listed", target: a.path ?? ".", Icon: IconFolder };
  if (a?.type === "search")
    return {
      verb: running ? "Searching" : "Searched",
      target: `${a.query ?? ""}${a.path ? ` in ${a.path}` : ""}`,
      Icon: IconSearch,
    };
  return { verb: running ? "Running" : "Ran", target: item.command, Icon: IconTerminal };
}
