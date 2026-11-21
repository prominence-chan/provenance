import { useAppState } from "../store/store";
import { compactNumber, shortPath } from "./format";
import { threadTitle } from "./Sidebar";
import { TierBadge } from "./TierBadge";

/** Top bar: thread title, cwd, model, token usage. */
export function ThreadHeader() {
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  if (!view) return <header className="thread-header" />;
  return (
    <header className="thread-header">
      <div className="thread-header-title">{threadTitle(view.thread)}</div>
      <div className="thread-header-meta">
        {view.cwd && <span className="mono">{shortPath(view.cwd)}</span>}
        <TierBadge model={view.model} />
        <TokenUsage threadId={view.id} />
      </div>
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
  return (
    <span className="token-usage" title={title}>
      {pct !== null && (
        <span className="ctx-meter">
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {compactNumber(total.totalTokens)} tokens{pct !== null && ` · ${pct}% ctx`}
    </span>
  );
}
