import { newThread } from "../store/actions";
import { useAppState } from "../store/store";
import { toggleSidebar, useSidebar } from "../theme/ui";
import { compactNumber, shortPath } from "./format";
import { IconCompose, IconSidebar } from "./icons";
import { threadTitle } from "./Sidebar";

/** Slim top bar: sidebar toggle (when hidden), thread title + cwd, tier, context use. */
export function ThreadHeader() {
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const { visible } = useSidebar();
  return (
    <header className="thread-header">
      {!visible && (
        <div className="header-tools">
          <button
            className="icon-btn"
            title="Show sidebar (⌘B)"
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
            <span className="thread-header-name">{threadTitle(view.thread)}</span>
          </div>
          <div className="thread-header-meta">
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
    <span className="token-usage" title={title}>
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
      {pct !== null && <span className="token-pct">{pct}%</span>}
    </span>
  );
}
