import { useMemo, useState } from "react";
import type { Thread } from "../protocol";
import { archiveThread, newThread, openThread, refreshThreads } from "../store/actions";
import { isThreadActive } from "../store/state";
import { useAppState } from "../store/store";
import { baseName, relativeTime } from "./format";
import { IconArchive, IconPlus, IconRefresh } from "./icons";

export function Sidebar() {
  const threads = useAppState((s) => s.threads);
  const selected = useAppState((s) => s.selectedThreadId);
  const loading = useAppState((s) => s.threadsLoading);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q));
  }, [threads, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">Provenance</div>
        <button className="btn-new" onClick={newThread}>
          <IconPlus size={15} /> New thread
        </button>
        <input
          className="sidebar-search"
          placeholder="Search threads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="sidebar-section">
        <span>Threads</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refreshThreads()} disabled={loading}>
          <IconRefresh size={13} />
        </button>
      </div>
      <nav className="thread-list">
        {filtered.map((t) => (
          <ThreadRow key={t.id} thread={t} selected={t.id === selected} />
        ))}
        {!filtered.length && <div className="muted thread-empty">{loading ? "Loading…" : "No threads yet"}</div>}
      </nav>
      <ConnectionStatus />
    </aside>
  );
}

function ThreadRow({ thread, selected }: { thread: Thread; selected: boolean }) {
  const waiting = useAppState((s) => s.serverRequests.some((r) => (r.params as { threadId?: string }).threadId === thread.id));
  return (
    <div className={`thread-row ${selected ? "selected" : ""}`} onClick={() => void openThread(thread.id)}>
      <div className="thread-row-main">
        <div className="thread-title">
          {isThreadActive(thread.status) && <span className={`dot ${waiting ? "dot-warn" : "dot-busy"}`} />}
          {threadTitle(thread)}
        </div>
        <div className="thread-meta">
          <span>{baseName(thread.cwd)}</span>
          <span>{relativeTime(thread.updatedAt)}</span>
        </div>
      </div>
      <button
        className="icon-btn thread-archive"
        title="Archive"
        onClick={(e) => {
          e.stopPropagation();
          void archiveThread(thread.id);
        }}
      >
        <IconArchive size={13} />
      </button>
    </div>
  );
}

export function threadTitle(t: Thread): string {
  return t.name || t.preview?.split("\n")[0] || "New thread";
}

function ConnectionStatus() {
  const socketOpen = useAppState((s) => s.socketOpen);
  const bridge = useAppState((s) => s.bridge);
  let label = "Connecting…";
  let cls = "dot-warn";
  if (!socketOpen) {
    label = "Bridge disconnected";
    cls = "dot-err";
  } else if (bridge?.state === "ready") {
    label = "app-server ready";
    cls = "dot-ok";
  } else if (bridge?.state === "down") {
    label = `app-server down: ${bridge.error}`;
    cls = "dot-err";
  } else if (bridge?.state === "starting") {
    label = "Starting app-server…";
  }
  return (
    <div className="conn" title={label}>
      <span className={`dot ${cls}`} />
      <span className="conn-label">{label}</span>
    </div>
  );
}
