import type { FileUpdateChange, ThreadItem } from "../../protocol";
import { DiffView } from "../DiffView";
import { IconChevron, IconFile } from "../icons";

type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;

/** One line per file ("Edited ui/src/x.ts +3 −1"), the diff on demand. */
export function FileChangeCard({ item }: { item: FileChangeItem }) {
  return (
    <div className={`filechange ${item.status === "failed" ? "failed" : ""}`}>
      {item.changes.map((c) => (
        <FileDiff key={c.path} change={c} status={item.status} />
      ))}
    </div>
  );
}

function FileDiff({
  change,
  status,
}: {
  change: FileUpdateChange;
  status: FileChangeItem["status"];
}) {
  const { adds, dels } = countLines(change.diff);
  const kind = change.kind.type;
  const verb =
    status === "inProgress"
      ? kind === "add"
        ? "Creating"
        : kind === "delete"
          ? "Deleting"
          : "Editing"
      : status === "declined"
        ? "Declined"
        : status === "failed"
          ? "Failed"
          : kind === "add"
            ? "Created"
            : kind === "delete"
              ? "Deleted"
              : "Edited";
  const moved =
    change.kind.type === "update" && change.kind.move_path ? ` → ${change.kind.move_path}` : "";
  return (
    <details className={`tool-row file-diff ${status === "failed" ? "failed" : ""}`}>
      <summary title={change.path + moved}>
        <IconChevron size={11} />
        <IconFile size={13} />
        <span className={`tool-verb ${status === "inProgress" ? "shimmer" : ""}`}>{verb}</span>
        <code className="tool-target">
          {change.path}
          {moved}
        </code>
        <span className="tool-meta diffstat">
          <span className="good">+{adds}</span>
          <span className="bad">−{dels}</span>
        </span>
      </summary>
      <div className="tool-body">
        <DiffView diff={change.diff} />
      </div>
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
