import type { ThreadItem } from "../../protocol";
import { IconChevron, IconStack } from "../icons";
import { ItemView } from "./ItemView";

/**
 * A run of consecutive tool items. While it runs every row shows live; once the assistant starts
 * writing after it (or the turn ends) the run folds into one line ("Ran 6 commands, edited 3
 * files, read 2 files") that opens back to the rows, which open to their output / diffs as
 * before. The fold is an uncontrolled <details>: once the user opens it, later renders (more
 * streamed text, the turn ending) leave it as they set it.
 */
export function ToolGroup({ items, collapsed }: { items: ThreadItem[]; collapsed: boolean }) {
  const s = summarize(items);
  const rows = (
    <div className="tool-group">
      {items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
    </div>
  );
  // Thinking alone, or a single row, is already one line: nothing to fold.
  if (!collapsed || !s.phrases.length || items.length < 2) return rows;
  return (
    <details className="tool-row tool-summary">
      <summary>
        <IconChevron size={11} />
        <IconStack size={13} />
        <span className="tool-verb">{s.phrases.join(", ")}</span>
        <span className="tool-meta">
          {s.failed > 0 && <span className="bad">{s.failed} failed</span>}
          {(s.adds > 0 || s.dels > 0) && (
            <span className="diffstat">
              <span className="good">+{s.adds}</span> <span className="bad">−{s.dels}</span>
            </span>
          )}
        </span>
      </summary>
      <div className="tool-summary-body">{rows}</div>
    </details>
  );
}

type Kind =
  "command" | "read" | "search" | "list" | "edit" | "create" | "delete" | "tool" | "web" | "image";

// Order of the phrases, and how each one reads for 1 and for n.
const PHRASES: [Kind, (n: number) => string][] = [
  ["command", (n) => `ran ${n} command${n === 1 ? "" : "s"}`],
  ["read", (n) => `read ${n} file${n === 1 ? "" : "s"}`],
  ["search", (n) => `searched ${n === 1 ? "once" : `${n} times`}`],
  ["list", (n) => `listed ${n} folder${n === 1 ? "" : "s"}`],
  ["edit", (n) => `edited ${n} file${n === 1 ? "" : "s"}`],
  ["create", (n) => `created ${n} file${n === 1 ? "" : "s"}`],
  ["delete", (n) => `deleted ${n} file${n === 1 ? "" : "s"}`],
  ["tool", (n) => `called ${n} tool${n === 1 ? "" : "s"}`],
  ["web", (n) => `searched the web${n === 1 ? "" : ` ${n} times`}`],
  ["image", (n) => `viewed ${n} image${n === 1 ? "" : "s"}`],
];

export function summarize(items: ThreadItem[]) {
  const counts = new Map<Kind, number>();
  const bump = (k: Kind, by = 1) => counts.set(k, (counts.get(k) ?? 0) + by);
  // A file edited twice counts once; created-then-edited counts as created.
  const files = new Map<string, Kind>();
  let failed = 0;
  let adds = 0;
  let dels = 0;
  for (const item of items) {
    switch (item.type) {
      case "commandExecution": {
        const acts = item.commandActions;
        if (acts.length && acts.every((a) => a.type === "read")) bump("read", acts.length);
        else if (acts.length === 1 && acts[0].type === "search") bump("search");
        else if (acts.length === 1 && acts[0].type === "listFiles") bump("list");
        else bump("command");
        if (item.status === "failed" || (item.exitCode != null && item.exitCode !== 0)) failed++;
        break;
      }
      case "fileChange":
        if (item.status === "failed") failed++;
        for (const c of item.changes) {
          const k: Kind =
            c.kind.type === "add" ? "create" : c.kind.type === "delete" ? "delete" : "edit";
          const prev = files.get(c.path);
          if (!prev || (prev === "edit" && k !== "edit")) files.set(c.path, k);
          for (const l of c.diff.split("\n")) {
            if (l.startsWith("+") && !l.startsWith("+++")) adds++;
            else if (l.startsWith("-") && !l.startsWith("---")) dels++;
          }
        }
        break;
      case "mcpToolCall":
      case "dynamicToolCall":
        bump("tool");
        break;
      case "webSearch":
        bump("web");
        break;
      case "imageView":
        bump("image");
        break;
      default:
        break; // reasoning: shown in the rows, not counted
    }
  }
  for (const k of files.values()) bump(k);
  const phrases = PHRASES.filter(([k]) => counts.has(k)).map(([k, f]) => f(counts.get(k)!));
  if (phrases.length) phrases[0] = phrases[0][0].toUpperCase() + phrases[0].slice(1);
  return { phrases, failed, adds, dels };
}
