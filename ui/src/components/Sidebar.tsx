import { useMemo, useState } from "react";
import type { Thread } from "../protocol";
import { archiveThread, newThread, openThread, refreshThreads } from "../store/actions";
import { isThreadActive } from "../store/state";
import { useAppState } from "../store/store";
import { setTheme, useTheme } from "../theme/theme";
import { closeDrawer, toggleSidebar, useSidebar } from "../theme/ui";
import { baseName, relativeTime, shortPath } from "./format";
import {
  IconArchive,
  IconChevron,
  IconCompose,
  IconFolder,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconSun,
} from "./icons";
import { SolarMark } from "./SolarMark";

const GROUPS_KEY = "provenance-ui.collapsed-projects";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** Threads grouped by working directory (like Codex's projects), most recent project first. */
function groupByProject(threads: Thread[]): { cwd: string; threads: Thread[] }[] {
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const list = groups.get(t.cwd);
    if (list) list.push(t);
    else groups.set(t.cwd, [t]);
  }
  return [...groups].map(([cwd, threads]) => ({ cwd, threads }));
}

export function Sidebar() {
  const threads = useAppState((s) => s.threads);
  const selected = useAppState((s) => s.selectedThreadId);
  const loading = useAppState((s) => s.threadsLoading);
  const { narrow, visible } = useSidebar();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? threads.filter(
          (t) => threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q),
        )
      : threads;
    return groupByProject(list);
  }, [threads, query]);

  const toggleGroup = (cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <>
      {narrow && visible && <div className="scrim" onClick={() => toggleSidebar(false)} />}
      <aside className="sidebar" aria-hidden={!visible} inert={!visible}>
        <div className="sidebar-head">
          <div className="brand">
            <SolarMark size={16} />
            <span>Provenance</span>
          </div>
          <button
            className="icon-btn"
            title="Hide sidebar (⌘B)"
            aria-label="Hide sidebar"
            onClick={() => toggleSidebar(false)}
          >
            <IconSidebar size={15} />
          </button>
        </div>
        <div className="sidebar-actions">
          <button
            className="side-item btn-new"
            onClick={() => {
              newThread();
              closeDrawer();
            }}
          >
            <IconCompose size={14} />
            <span>New thread</span>
          </button>
          <label className="side-item sidebar-search">
            <IconSearch size={14} />
            <input
              placeholder="Search threads"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            />
          </label>
        </div>
        <div className="sidebar-section">
          <span>Threads</span>
          <button
            className="icon-btn"
            title="Refresh"
            aria-label="Refresh threads"
            onClick={() => void refreshThreads()}
            disabled={loading}
          >
            <IconRefresh size={12} />
          </button>
        </div>
        <nav className="thread-list">
          {groups.map((g) => {
            const open = !collapsed.has(g.cwd) || !!query.trim();
            return (
              <div key={g.cwd} className="project">
                <button
                  className="project-head"
                  title={shortPath(g.cwd)}
                  aria-expanded={open}
                  onClick={() => toggleGroup(g.cwd)}
                >
                  <span className="project-icon">
                    <IconFolder size={13} />
                    <IconChevron size={11} />
                  </span>
                  <span className="project-name">{baseName(g.cwd) || g.cwd}</span>
                  {!open && <span className="project-count">{g.threads.length}</span>}
                </button>
                {open &&
                  g.threads.map((t) => (
                    <ThreadRow
                      key={t.id}
                      thread={t}
                      selected={t.id === selected}
                      query={query.trim()}
                    />
                  ))}
              </div>
            );
          })}
          {!groups.length && (
            <div className="thread-empty">
              {loading ? "Loading…" : query ? "No matches" : "No threads yet"}
            </div>
          )}
        </nav>
        <div className="sidebar-foot">
          <ConnectionStatus />
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}

function ThreadRow({
  thread,
  selected,
  query,
}: {
  thread: Thread;
  selected: boolean;
  query: string;
}) {
  const waiting = useAppState((s) =>
    s.serverRequests.some((r) => (r.params as { threadId?: string }).threadId === thread.id),
  );
  const active = isThreadActive(thread.status);
  const title = threadTitle(thread);
  return (
    <div
      className={`thread-row ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      title={title}
      aria-current={selected ? "page" : undefined}
      onClick={() => {
        void openThread(thread.id);
        closeDrawer();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openThread(thread.id);
          closeDrawer();
        }
      }}
    >
      {(active || waiting) && (
        <span
          className={`dot ${waiting ? "dot-warn" : "dot-busy"}`}
          title={waiting ? "Waiting for approval" : "Working"}
        />
      )}
      <span className="thread-title">
        <Highlight text={title} query={query} />
      </span>
      <span className="thread-end">
        <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
        <button
          className="icon-btn thread-archive"
          title="Archive"
          aria-label="Archive thread"
          onClick={(e) => {
            e.stopPropagation();
            void archiveThread(thread.id);
          }}
        >
          <IconArchive size={12} />
        </button>
      </span>
    </div>
  );
}

/** Marks the search match; a match past the visible part pulls the title's start forward. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  const start = i > 24 ? i - 12 : 0;
  return (
    <>
      {start > 0 && "…"}
      {text.slice(start, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

export function threadTitle(t: Thread): string {
  return t.name || t.preview?.split("\n")[0] || "Untitled thread";
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

function ThemeToggle() {
  const mode = useTheme();
  const next = mode === "dark" ? "light" : "dark";
  return (
    <button
      className="icon-btn"
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {mode === "dark" ? <IconSun size={13} /> : <IconMoon size={13} />}
    </button>
  );
}
