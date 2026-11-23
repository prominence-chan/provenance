// The links between a conversation and the backend sessions that served it
// (shared/thread-links.ts): one JSON file, <data>/thread-links.json, read once and rewritten
// whole on each change (it holds ids only, a few hundred bytes per moved conversation).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSegments, type LinkSegment, type ThreadLinks } from "../shared/thread-links.ts";

export class ThreadLinkStore {
  private file: string;
  private links: ThreadLinks | null = null;

  constructor(file: string) {
    this.file = file;
  }

  all(): ThreadLinks {
    if (this.links) return this.links;
    const links: ThreadLinks = {};
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        links?: Record<string, unknown>;
      };
      for (const [id, segs] of Object.entries(raw.links ?? {})) {
        const s = parseSegments(segs);
        if (s && s[0].threadId === id) links[id] = s;
      }
    } catch {
      // none yet, or unreadable: start empty
    }
    this.links = links;
    return links;
  }

  /** Set a conversation's segments; null forgets it (archived). */
  set(id: string, segments: LinkSegment[] | null): void {
    const links = { ...this.all() };
    if (segments) links[id] = segments;
    else delete links[id];
    this.links = links;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ links }));
    renameSync(tmp, this.file);
  }
}
