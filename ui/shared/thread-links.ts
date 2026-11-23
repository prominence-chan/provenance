// One conversation, several backend sessions. When a conversation moves to another backend (a
// tier thread continued in Claude Code, Codex, Codex through Provenance, or back), it stays ONE
// thread on the page: same sidebar entry, same title, the earlier turns where they were. Behind
// it, each backend that served it has its own session ("segment"): the first segment's thread id
// is the conversation's id; each later segment is a thread started on the new backend whose
// model was handed a brief of everything before it (src/fallback/brief.ts), never shown.
//
// The UI server keeps the links (server/links.ts, <data>/thread-links.json; GET /api/links,
// PUT / DELETE /api/links/<id>); the page stitches the segments' turns into one view and sends
// each message to the last segment (src/store/segments.ts). A conversation that never moved has
// no entry.

/** Which server a segment's thread lives on (the page's BackendId). */
export type LinkBackend = "main" | "codex" | "fallback" | "orchestrator";

export interface LinkSegment {
  backend: LinkBackend;
  /** That backend's own thread id. */
  threadId: string;
  /** The model key it was started with ("solstice", "claude:opus", "codex-pv:"). */
  model: string | null;
  /** Unix seconds when the conversation moved there. */
  at: number;
}

/** Conversation id (= its first segment's thread id) -> its segments, oldest first (two or more). */
export type ThreadLinks = Record<string, LinkSegment[]>;

const BACKENDS = new Set<string>(["main", "codex", "fallback", "orchestrator"]);

/** A stored or sent list of segments, checked; null when it isn't one. */
export function parseSegments(v: unknown): LinkSegment[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > 64) return null;
  const out: LinkSegment[] = [];
  for (const s of v as Record<string, unknown>[]) {
    if (
      !s ||
      typeof s.threadId !== "string" ||
      !s.threadId ||
      s.threadId.length > 200 ||
      typeof s.backend !== "string" ||
      !BACKENDS.has(s.backend)
    )
      return null;
    out.push({
      backend: s.backend as LinkBackend,
      threadId: s.threadId,
      model: typeof s.model === "string" ? s.model.slice(0, 200) : null,
      at: typeof s.at === "number" && Number.isFinite(s.at) ? s.at : 0,
    });
  }
  return out;
}
