import type { FileUpdateChange, ThreadItem } from "../../protocol";
import { DiffView } from "../DiffView";
import { IconChevron, IconFile } from "../icons";

type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;

export function FileChangeCard({ item }: { item: FileChangeItem }) {
  const verb =
    item.status === "inProgress"
      ? "Editing"
      : item.status === "declined"
        ? "Declined"
        : item.status === "failed"
          ? "Failed to edit"
          : "Edited";
  return (
    <div className={`card filechange ${item.status === "failed" ? "cmd-failed" : ""}`}>
      <div className="card-label">
        <IconFile size={14} /> {verb} {item.changes.length} file
        {item.changes.length === 1 ? "" : "s"}
      </div>
      {item.changes.map((c) => (
        <FileDiff key={c.path} change={c} />
      ))}
    </div>
  );
}

function FileDiff({ change }: { change: FileUpdateChange }) {
  const { adds, dels } = countLines(change.diff);
  const kind = change.kind.type === "add" ? "A" : change.kind.type === "delete" ? "D" : "M";
  const moved =
    change.kind.type === "update" && change.kind.move_path ? ` → ${change.kind.move_path}` : "";
  return (
    <details className="file-diff">
      <summary>
        <IconChevron size={12} />
        <span className={`kind kind-${kind}`}>{kind}</span>
        <span className="mono">
          {change.path}
          {moved}
        </span>
        <span className="diffstat">
          <span className="good">+{adds}</span> <span className="bad">-{dels}</span>
        </span>
      </summary>
      <DiffView diff={change.diff} />
    </details>
  );
}

function countLines(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) adds++;
    else if (l.startsWith("-") && !l.startsWith("---")) dels++;
  }
  return { adds, dels };
}
