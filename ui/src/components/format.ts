export function shortPath(p: string | null | undefined): string {
  if (!p) return "";
  const home = /^\/Users\/[^/]+/.exec(p)?.[0];
  return home ? "~" + p.slice(home.length) : p;
}

export function baseName(p: string | null | undefined): string {
  if (!p) return "";
  return p.replace(/\/$/, "").split("/").pop() || p;
}

/** app-server timestamps are unix seconds. */
export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * A message the provenance binary wrote (a turn's error, a retry note) for a turn the tiers
 * ran: upstream's wording calls the agent "Codex" ("Codex ran out of room in the model's
 * context window"); here it is Provenance. The other product keeps its name (Codex Cloud,
 * Codex Apps, the Codex CLI), and so does every message of a fallback's turn, where Codex is
 * what actually ran (pass `fallback` true).
 */
export function harnessMessage(message: string, fallback = false): string {
  if (fallback) return message;
  return message.replace(/(?<![\w-])Codex(?![\w]| (?:CLI|Cloud|Apps|Desktop)\b)/g, "Provenance");
}
