import { useMemo } from "react";
import { newThread, openThread } from "../store/actions";
import { useAppState } from "../store/store";
import { toggleSidebar, useSidebar } from "../theme/ui";
import { compactNumber, modKey, shortPath } from "./format";
import { IconAgents, IconCompose, IconSidebar } from "./icons";
import { threadTitle } from "./Sidebar";
import {
  collectSubagents,
  isSubagentActive,
  isSubagentsPanelOpen,
  toggleSubagentsPanel,
  useSubagentsPanel,
} from "./subagents";

/** Slim top bar: sidebar toggle (when hidden), thread title + cwd, tier, context use. */
export function ThreadHeader() {
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const threads = useAppState((s) => s.threads);
  const { visible } = useSidebar();
  const panel = useSubagentsPanel();
  const subagents = useMemo(() => collectSubagents(view, threads), [view, threads]);
  const activeSubagents = subagents.filter((a) => isSubagentActive(a.status)).length;
  const subPanelOpen = isSubagentsPanelOpen(panel, view?.id ?? null, subagents.length > 0);
  const parentId = view?.thread.parentThreadId ?? null;
  return (
    <header className="thread-header">
      {!visible && (
        <div className="header-tools">
          <button
            className="icon-btn"
            title={`Show sidebar (${modKey()}B)`}
            aria-label="Show sidebar"
            onClick={() => toggleSidebar(true)}
          >
            <IconSidebar size={15} />
          </button>
          <button
            className="icon-btn"
            title="New thread"
            aria-label="New thread"
            onClick={newThread}
          >
            <IconCompose size={14} />
          </button>
        </div>
      )}
      {view && (
        <>
          <div className="thread-header-title" title={view.cwd ? shortPath(view.cwd) : undefined}>
            {parentId && (
              <button
                type="button"
                className="parent-back-btn"
                onClick={() => void openThread(parentId)}
                title="Back to parent thread"
              >
                ← Parent
              </button>
            )}
            <span className="thread-header-name">{threadTitle(view.thread)}</span>
          </div>
          <div className="thread-header-meta">
            {subagents.length > 0 && (
              <button
                type="button"
                className={`subagents-toggle ${subPanelOpen ? "active" : ""}`}
                aria-pressed={subPanelOpen}
                title={subPanelOpen ? "Hide subagents panel" : "Show subagents panel"}
                onClick={() => toggleSubagentsPanel(view.id)}
              >
                {activeSubagents > 0 && <span className="dot dot-busy" />}
                <IconAgents size={13} />
                <span>
                  {activeSubagents > 0
                    ? `${activeSubagents} active · ${subagents.length}`
                    : `${subagents.length} subagent${subagents.length === 1 ? "" : "s"}`}
                </span>
              </button>
            )}
            <TokenUsage threadId={view.id} />
          </div>
        </>
      )}
    </header>
  );
}

export function TokenUsage({ threadId }: { threadId: string }) {
  const usage = useAppState((s) => s.views[threadId]?.tokenUsage);
  if (!usage) return null;
  const { total, last, modelContextWindow } = usage;
  const pct = modelContextWindow
    ? Math.min(100, Math.round((last.totalTokens / modelContextWindow) * 100))
    : null;
  const title =
    `Total: ${total.totalTokens.toLocaleString()} tokens ` +
    `(in ${total.inputTokens.toLocaleString()}, cached ${total.cachedInputTokens.toLocaleString()}, ` +
    `out ${total.outputTokens.toLocaleString()}, reasoning ${total.reasoningOutputTokens.toLocaleString()})\n` +
    `Last turn context: ${last.totalTokens.toLocaleString()}` +
    (modelContextWindow ? ` / ${modelContextWindow.toLocaleString()}` : "");
  // A ring for the share of the context window in use; the total sits beside it.
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <span className="token-usage meta" title={title}>
      {pct !== null && (
        <svg width="14" height="14" viewBox="0 0 14 14" className="ctx-ring" aria-hidden>
          <circle cx="7" cy="7" r={r} className="ctx-ring-track" />
          <circle
            cx="7"
            cy="7"
            r={r}
            className="ctx-ring-fill"
            strokeDasharray={`${(pct / 100) * c} ${c}`}
          />
        </svg>
      )}
      {compactNumber(total.totalTokens)}
      {pct !== null && <span>{pct}%</span>}
    </span>
  );
}
