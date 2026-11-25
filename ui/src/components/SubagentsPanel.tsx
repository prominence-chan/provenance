import { useEffect, useMemo, useRef } from "react";
import { openThread } from "../store/actions";
import { useAppState } from "../store/store";
import { IconClose } from "../setup/parts";
import { IconAgents } from "./icons";
import { Markdown } from "./Markdown";
import {
  collectSubagents,
  focusSubagent,
  isSubagentActive,
  isSubagentsPanelOpen,
  subagentStatusLabel,
  toggleSubagentsPanel,
  useSubagentsPanel,
  type SubagentInfo,
} from "./subagents";

/** Right-side panel showing active and completed subagents for the open thread. */
export function SubagentsPanel() {
  const threadId = useAppState((s) => s.selectedThreadId);
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const threads = useAppState((s) => s.threads);
  const panel = useSubagentsPanel();

  const subagents = useMemo(() => collectSubagents(view, threads), [view, threads]);
  const open = isSubagentsPanelOpen(panel, threadId, subagents.length > 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !panel.focusedId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-subagent-id="${CSS.escape(panel.focusedId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open, panel.focusedId]);

  if (!open || !threadId) return null;

  return (
    <>
      {panel.overlay && (
        <div
          className="scrim subagents-scrim"
          onClick={() => toggleSubagentsPanel(threadId, false)}
        />
      )}
      <aside className={`subagents-panel ${panel.overlay ? "overlay" : ""}`} aria-label="Subagents">
        <div className="subagents-head">
          <div className="subagents-title">
            <IconAgents size={14} />
            <span>Subagents</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Close subagents panel"
            aria-label="Close subagents panel"
            onClick={() => toggleSubagentsPanel(threadId, false)}
          >
            <IconClose />
          </button>
        </div>
        <div className="subagents-list" ref={listRef}>
          {subagents.map((agent) => (
            <SubagentRow
              key={agent.id}
              agent={agent}
              focused={panel.focusedId === agent.id}
              onFocus={() => focusSubagent(threadId, agent.id)}
              onOpen={
                agent.thread
                  ? () => {
                      if (panel.overlay) toggleSubagentsPanel(threadId, false);
                      void openThread(agent.thread!.id);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      </aside>
    </>
  );
}

function SubagentRow({
  agent,
  focused,
  onFocus,
  onOpen,
}: {
  agent: SubagentInfo;
  focused: boolean;
  onFocus: () => void;
  onOpen?: () => void;
}) {
  const active = isSubagentActive(agent.status);
  const dotCls = active
    ? "dot-busy"
    : agent.status === "completed"
      ? "dot-ok"
      : agent.status === "errored"
        ? "dot-err"
        : "dot-off";
  const metaParts = [agent.role, agent.model, agent.reasoningEffort].filter(Boolean).join(" · ");
  return (
    <article
      className={`subagent-card ${focused ? "focused" : ""} ${active ? "active" : ""}`}
      data-subagent-id={agent.id}
      data-status={agent.status}
      onClick={onFocus}
    >
      <div className="subagent-card-head">
        <span className={`dot ${dotCls}`} />
        <span className="subagent-name" title={agent.agentPath ?? agent.id}>
          {agent.name}
        </span>
        <span className="spacer" />
        <span className={`meta subagent-status ${active ? "shimmer" : ""}`}>
          {subagentStatusLabel(agent.status)}
        </span>
        {onOpen && (
          <button
            type="button"
            className="subagent-open-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            Open
          </button>
        )}
      </div>
      {metaParts && <div className="subagent-meta meta">{metaParts}</div>}
      {agent.prompt && <p className="subagent-prompt">{agent.prompt}</p>}
      {agent.message && (
        <div className="subagent-message">
          <Markdown text={agent.message} />
        </div>
      )}
    </article>
  );
}
