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
  IconClock,
  IconCompose,
  IconFolder,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconSun,
  IconTrash,
} from "./icons";
import { SolarMark } from "./SolarMark";
import { firstGapStep, openSetup, openWelcome, useSetupGaps, type SetupGaps } from "../setup/open";
import { IconAccounts } from "../setup/SetupDialog";

const GROUPS_KEY = "provenance-ui.collapsed-projects";
const ORDER_KEY = "provenance-ui.folder-order";
const MOST_RECENT_KEY = "provenance-ui.most-recent";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function loadMostRecent(): boolean {
  try {
    return JSON.parse(localStorage.getItem(MOST_RECENT_KEY) ?? "false");
  } catch {
    return false;
  }
}

function saveMostRecent(v: boolean): void {
  try {
    localStorage.setItem(MOST_RECENT_KEY, JSON.stringify(v));
  } catch {
    // ignore
  }
}

function loadOrder(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
}

/** Threads grouped by working directory (like Codex's projects). */
function groupByProject(threads: Thread[]): { cwd: string; threads: Thread[] }[] {
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const list = groups.get(t.cwd);
    if (list) list.push(t);
    else groups.set(t.cwd, [t]);
  }
  return [...groups].map(([cwd, threads]) => ({ cwd, threads }));
}

/** Apply a saved folder order to the grouped list. */
function applyOrder(
  groups: { cwd: string; threads: Thread[] }[],
  order: string[],
): { cwd: string; threads: Thread[] }[] {
  if (!order.length) return groups;
  const byCwd = new Map(groups.map((g) => [g.cwd, g]));
  const ordered: { cwd: string; threads: Thread[] }[] = [];
  for (const cwd of order) {
    const g = byCwd.get(cwd);
    if (g) {
      ordered.push(g);
      byCwd.delete(cwd);
    }
  }
  // append any new folders not in saved order
  for (const g of byCwd.values()) ordered.push(g);
  return ordered;
}

/** Threads sorted globally by most recently updated, regardless of project. */
function sortByMostRecent(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function Sidebar() {
  const threads = useAppState((s) => s.threads);
  const selected = useAppState((s) => s.selectedThreadId);
  const loading = useAppState((s) => s.threadsLoading);
  const { narrow, visible } = useSidebar();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [mostRecent, setMostRecent] = useState(loadMostRecent);
  const [folderOrder, setFolderOrder] = useState(loadOrder);
  const [dragging, setDragging] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (mostRecent) {
      let list = sortByMostRecent(threads);
      if (q) {
        list = list.filter(
          (t) => threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q),
        );
      }
      return { kind: "flat" as const, threads: list };
    }
    let list = threads;
    if (q) {
      list = list.filter(
        (t) => threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q),
      );
    }
    const grouped = applyOrder(groupByProject(list), folderOrder);
    return { kind: "grouped" as const, groups: grouped };
  }, [threads, query, mostRecent, folderOrder]);

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

  const toggleMostRecent = () => {
    setMostRecent((prev) => {
      const next = !prev;
      saveMostRecent(next);
      return next;
    });
  };

  const handleDeleteFolder = async (cwd: string) => {
    const toArchive = threads.filter((t) => t.cwd === cwd);
    if (!toArchive.length) return;
    const ok = window.confirm(
      `Delete folder "${baseName(cwd) || cwd}" and archive all ${toArchive.length} thread(s) inside?`,
    );
    if (!ok) return;
    for (const t of toArchive) {
      await archiveThread(t.id);
    }
    await refreshThreads();
  };

  const handleDragStart = (cwd: string) => (e: React.DragEvent) => {
    setDragging(cwd);
    try {
      e.dataTransfer.setData("text/plain", cwd);
      e.dataTransfer.effectAllowed = "move";
    } catch {
      // ignore
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      // ignore
    }
  };

  const handleDrop = (targetCwd: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    const src = dragging || e.dataTransfer.getData("text/plain");
    setDragging(null);
    if (!src || src === targetCwd) return;
    // reorder
    const current = groups.kind === "grouped" ? groups.groups.map((g) => g.cwd) : [];
    const next = current.filter((c) => c !== src);
    const idx = next.indexOf(targetCwd);
    if (idx < 0) next.push(src);
    else next.splice(idx, 0, src);
    setFolderOrder(next);
    saveOrder(next);
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
          <div style={{ display: "flex", gap: "2px" }}>
            <button
              className="icon-btn"
              title="Refresh"
              aria-label="Refresh threads"
              onClick={() => void refreshThreads()}
              disabled={loading}
            >
              <IconRefresh size={12} />
            </button>
            <button
              className={`icon-btn most-recent-toggle ${mostRecent ? "active" : ""}`}
              title={mostRecent ? "Sort by project" : "Sort by most recent"}
              aria-label={mostRecent ? "Sort by project" : "Sort by most recent"}
              onClick={toggleMostRecent}
            >
              <IconClock size={12} />
            </button>
          </div>
        </div>
        <nav className="thread-list">
          {groups.kind === "flat" && groups.threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              selected={t.id === selected}
              query={query.trim()}
            />
          ))}
          {groups.kind === "grouped" && groups.groups.map((g) => {
            const open = !collapsed.has(g.cwd) || !!query.trim();
            return (
              <div
                key={g.cwd}
                className="project"
                draggable
                onDragStart={handleDragStart(g.cwd)}
                onDragOver={handleDragOver}
                onDrop={handleDrop(g.cwd)}
                style={dragging === g.cwd ? { opacity: 0.5 } : undefined}
              >
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
                  <button
                    className="icon-btn project-delete"
                    title="Delete folder"
                    aria-label="Delete folder"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteFolder(g.cwd);
                    }}
                  >
                    <IconTrash size={11} />
                  </button>
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
          {((groups.kind === "flat" && !groups.threads.length) ||
            (groups.kind === "grouped" && !groups.groups.length)) && (
            <div className="thread-empty">
              {loading ? "Loading…" : query ? "No matches" : "No threads yet"}
            </div>
          )}
        </nav>
        <SetupHint />
        <div className="sidebar-foot">
          <ConnectionStatus />
          <button
            className="icon-btn"
            title="Models & accounts"
            aria-label="Models & accounts"
            onClick={() => openSetup()}
          >
            <IconAccounts size={14} />
          </button>
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

/**
 * "Finish setting up", above the sidebar foot, only while something is still missing (a site, an
 * API key of your own, a fallback): opens the welcome on the first step with something left. The
 * ring shows how much is set up; it never moves and goes away once everything is.
 */
function SetupHint() {
  const gaps = useSetupGaps();
  if (!gaps) return null;
  const parts: [keyof SetupGaps, string][] = [
    ["sites", "a chat site"],
    ["keys", "API keys"],
    ["fallbacks", "a fallback"],
  ];
  const left = parts.filter(([k]) => gaps[k]).map(([, name]) => name);
  const done = parts.length - left.length;
  return (
    <button
      className="side-item btn-new sidebar-setup"
      title={`Still to set up: ${left.join(", ")}`}
      onClick={() => {
        openWelcome(firstGapStep(gaps));
        closeDrawer();
      }}
    >
      <SetupRing done={done} of={parts.length} />
      <span>Finish setting up</span>
    </button>
  );
}

/** A small ring, filled as far as the setup has got. */
function SetupRing({ done, of }: { done: number; of: number }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden className="setup-ring">
      <circle cx="7" cy="7" r={r} className="setup-ring-track" />
      <circle
        cx="7"
        cy="7"
        r={r}
        className="setup-ring-fill"
        strokeDasharray={`${(c * done) / of} ${c}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
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
