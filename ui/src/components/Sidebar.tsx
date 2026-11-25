import { Fragment, useMemo, useState } from "react";
import { parseFallbackModel } from "../../shared/fallback-api";
import { carriedTitle } from "../fallback/brief";
import { fallbackOf, MODE_NAME } from "../fallback/model";
import type { Thread } from "../protocol";
import { archiveThread, newThread, openThread, refreshThreads } from "../store/actions";
import { isThreadActive, type Source } from "../store/state";
import { useAppState } from "../store/store";
import { setTheme, useTheme } from "../theme/theme";
import { splitModel, tierOf } from "../theme/tiers";
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
  const [dragOver, setDragOver] = useState<{ cwd: string; position: "before" | "after" } | null>(
    null,
  );

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Hide child subagent threads from the top-level list unless searched or currently selected.
    const visibleThreads = threads.filter((t) => !t.parentThreadId || t.id === selected || !!q);
    if (mostRecent) {
      let list = sortByMostRecent(visibleThreads);
      if (q) {
        list = list.filter(
          (t) => threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q),
        );
      }
      return { kind: "flat" as const, threads: list };
    }
    let list = visibleThreads;
    if (q) {
      list = list.filter(
        (t) => threadTitle(t).toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q),
      );
    }
    const grouped = applyOrder(groupByProject(list), folderOrder);
    return { kind: "grouped" as const, groups: grouped };
  }, [threads, query, mostRecent, folderOrder, selected]);

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

  const handleDragOverProject = (cwd: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      // ignore
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position: "before" | "after" =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDragOver((prev) =>
      prev && prev.cwd === cwd && prev.position === position ? prev : { cwd, position },
    );
  };

  const handleDragEnd = () => {
    setDragging(null);
    setDragOver(null);
  };

  const handleDropProject = (targetCwd: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const src = dragging || e.dataTransfer.getData("text/plain");
    const position = dragOver?.cwd === targetCwd ? dragOver.position : "before";
    setDragging(null);
    setDragOver(null);
    if (!src || src === targetCwd) return;
    const current = groups.kind === "grouped" ? groups.groups.map((g) => g.cwd) : [];
    const next = current.filter((c) => c !== src);
    const idx = next.indexOf(targetCwd);
    if (idx < 0) next.push(src);
    else if (position === "before") next.splice(idx, 0, src);
    else next.splice(idx + 1, 0, src);
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
          {groups.kind === "flat" &&
            groups.threads.map((t) => (
              <ThreadRow key={t.id} thread={t} selected={t.id === selected} query={query.trim()} />
            ))}
          {groups.kind === "grouped" &&
            groups.groups.map((g) => {
              const open = !collapsed.has(g.cwd) || !!query.trim();
              const isDragging = dragging === g.cwd;
              const isDropTarget =
                dragOver?.cwd === g.cwd && dragging !== null && dragging !== g.cwd;
              const dropLineBefore = isDropTarget && dragOver?.position === "before";
              const dropLineAfter = isDropTarget && dragOver?.position === "after";
              return (
                <Fragment key={g.cwd}>
                  {dropLineBefore && <div className="project-drop-line" aria-hidden />}
                  <div
                    className={`project${isDragging ? " project-dragging" : ""}${isDropTarget ? " project-drop-target" : ""}`}
                    draggable
                    onDragStart={handleDragStart(g.cwd)}
                    onDragOver={handleDragOverProject(g.cwd)}
                    onDragLeave={() => setDragOver((prev) => (prev?.cwd === g.cwd ? null : prev))}
                    onDrop={handleDropProject(g.cwd)}
                    onDragEnd={handleDragEnd}
                  >
                    <div
                      className="project-head"
                      role="button"
                      tabIndex={0}
                      title={shortPath(g.cwd)}
                      aria-expanded={open}
                      onClick={() => toggleGroup(g.cwd)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleGroup(g.cwd);
                        }
                      }}
                    >
                      <span className="project-icon">
                        <IconFolder size={13} />
                        <IconChevron size={11} />
                      </span>
                      <span className="project-name">{baseName(g.cwd) || g.cwd}</span>
                      <span className="project-end">
                        {!open && <span className="project-count">{g.threads.length}</span>}
                        <button
                          type="button"
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
                      </span>
                    </div>
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
                  {dropLineAfter && <div className="project-drop-line" aria-hidden />}
                </Fragment>
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
  // (a thread carried over before conversations stayed one never shows its brief, title included)
  return t.name || carriedTitle(t.preview) || t.preview?.split("\n")[0] || "Untitled thread";
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

function formatResetDelta(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const diff = Math.max(0, ms - Date.now());
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `resets in ${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM ? `resets in ${hrs}h ${remM}m` : `resets in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH ? `resets in ${days}d ${remH}h` : `resets in ${days}d`;
}

function ConnectionStatus() {
  const socketOpen = useAppState((s) => s.socketOpen);
  const bridge = useAppState((s) => s.bridge);
  const model = useAppState((s) => s.settings.model);
  const sources = useAppState((s) => s.sources);
  const fallbackUsage = useAppState((s) => s.fallbackUsage);
  const fallbackInfo = useAppState((s) => s.fallbackInfo);

  if (!socketOpen || bridge?.state !== "ready") {
    let label = "Connecting…";
    let cls = "dot-warn";
    if (!socketOpen) {
      label = "Bridge disconnected";
      cls = "dot-err";
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

  const fb = parseFallbackModel(model);
  const fbCli = fallbackOf(model);
  const tier = fb ? null : tierOf(model);

  let label: string;
  let remaining: number | null = null;
  let valueText = "—";
  let tooltip = "";

  if (fb && fbCli) {
    const name = MODE_NAME[fb.mode];
    const u = fallbackUsage[fbCli] ?? fallbackInfo?.[fbCli]?.usage ?? null;
    const agyBucketKey =
      fb.mode === "antigravity" ? (/claude|gpt/i.test(fb.model) ? "claude_gpt" : "gemini") : null;
    const bucket = agyBucketKey && u?.buckets?.[agyBucketKey] ? u.buckets[agyBucketKey] : u;
    const groupSuffix =
      agyBucketKey === "claude_gpt"
        ? " (Claude & GPT)"
        : agyBucketKey === "gemini" && u?.buckets?.gemini
          ? " (Gemini)"
          : "";
    label = "Weekly";
    if (bucket && bucket.weeklyRemaining != null) {
      remaining = Math.max(0, Math.min(1, bucket.weeklyRemaining));
      const pct = Math.round(remaining * 100);
      valueText = `${pct}%`;
      const parts = [`${name}${groupSuffix} weekly remaining: ${pct}%`];
      const reset = formatResetDelta(bucket.weeklyResetsAt);
      if (reset) parts.push(reset);
      if (bucket.primaryRemaining != null) {
        parts.push(`5h window: ${Math.round(bucket.primaryRemaining * 100)}% left`);
      }
      tooltip = parts.join(" · ");
    } else if (bucket && bucket.primaryRemaining != null) {
      label = "5h limit";
      remaining = Math.max(0, Math.min(1, bucket.primaryRemaining));
      const pct = Math.round(remaining * 100);
      valueText = `${pct}%`;
      const reset = formatResetDelta(bucket.primaryResetsAt);
      tooltip = `${name}${groupSuffix} 5h window remaining: ${pct}%${reset ? ` · ${reset}` : ""}`;
    } else {
      tooltip =
        fb.mode === "codex"
          ? `${name} weekly usage appears after a turn or when running through Provenance`
          : `${name} weekly usage will appear once reported`;
    }
  } else {
    const { tier: tierName, source: pinnedSource } = splitModel(model);
    const list: Source[] = sources[tierName] ?? [];
    if (pinnedSource) {
      const s = list.find((x) => x.model === model);
      label = s?.label ?? pinnedSource;
      if (s) {
        if (!s.available) {
          remaining = 0;
          valueText = s.needs ? "Setup" : "0%";
          tooltip = `${s.label}: ${s.needs === "keys" ? "Add API keys" : s.needs === "signin" ? "Sign in required" : "Unavailable"}`;
        } else if (s.remaining != null) {
          remaining = Math.max(0, Math.min(1, s.remaining));
          const pct = Math.round(remaining * 100);
          valueText = `${pct}%`;
          tooltip = `${s.label} (${tierName}): ${pct}% daily usage left${s.busy ? ` · ${s.busy} busy` : ""}`;
        } else {
          tooltip = `${s.label} (${tierName}): usage not reported`;
        }
      } else {
        tooltip = `${model}: usage not reported`;
      }
    } else {
      label = tierName;
      const measured = list.filter((x) => !x.needs && x.remaining != null);
      if (measured.length) {
        const avg =
          measured.reduce((sum, x) => sum + Math.max(0, Math.min(1, x.remaining!)), 0) /
          measured.length;
        remaining = avg;
        const pct = Math.round(avg * 100);
        valueText = `${pct}%`;
        const detail = measured
          .map((x) => `${x.label}: ${Math.round(x.remaining! * 100)}%`)
          .join("\n");
        tooltip = `${tierName} remaining: ${pct}%\n${detail}`;
      } else if (list.length && list.every((x) => !x.available)) {
        remaining = 0;
        valueText = "0%";
        tooltip = `${tierName}: no sources available`;
      } else {
        tooltip = `${tierName}: usage not reported`;
      }
    }
  }

  const pctWidth = remaining != null ? Math.round(remaining * 100) : 0;
  const level =
    remaining == null
      ? "unknown"
      : remaining <= 0.05
        ? "critical"
        : remaining <= 0.2
          ? "low"
          : "ok";

  return (
    <div
      className="conn conn-usage"
      data-tier={tier?.id}
      data-fallback={fbCli ?? undefined}
      data-level={level}
      title={tooltip}
    >
      <span className="dot dot-ok" />
      <div className="meter-stack">
        <div className="meter-head">
          <span className="meter-name">{label}</span>
          <span className="meter-pct">{valueText}</span>
        </div>
        <div
          className="meter-track"
          role="progressbar"
          aria-label={`${label} remaining usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remaining != null ? pctWidth : undefined}
        >
          <div className="meter-fill" style={{ width: `${pctWidth}%` }} />
        </div>
      </div>
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
