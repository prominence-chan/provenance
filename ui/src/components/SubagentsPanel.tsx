import { useEffect, useMemo, useRef, useState } from "react";
import { loadSubagentPreview, openThread } from "../store/actions";
import { useAppState } from "../store/store";
import { IconBack, IconClose } from "../setup/parts";
import { IconAgents, IconChevron } from "./icons";
import { ItemView } from "./items/ItemView";
import { Markdown } from "./Markdown";
import {
  collectSubagents,
  inspectSubagent,
  isSubagentActive,
  isSubagentsPanelOpen,
  subagentStatusLabel,
  toggleSubagentsPanel,
  useSubagentsPanel,
  type SubagentInfo,
} from "./subagents";

function statusDotClass(status: SubagentInfo["status"]): string {
  if (isSubagentActive(status)) return "dot-busy";
  if (status === "completed") return "dot-ok";
  if (status === "errored") return "dot-err";
  return "dot-off";
}

/** Right-side panel showing active and completed subagents for the open thread, with inline drill-down. */
export function SubagentsPanel() {
  const threadId = useAppState((s) => s.selectedThreadId);
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const threads = useAppState((s) => s.threads);
  const panel = useSubagentsPanel();
  const [finishedToggle, setFinishedToggle] = useState<Record<string, boolean>>({});

  const subagents = useMemo(() => collectSubagents(view, threads), [view, threads]);
  const open = isSubagentsPanelOpen(panel, threadId, subagents.length > 0);
  const inspected = useMemo(
    () => (panel.inspectedId ? (subagents.find((a) => a.id === panel.inspectedId) ?? null) : null),
    [subagents, panel.inspectedId],
  );
  const activeAgents = useMemo(
    () => subagents.filter((a) => isSubagentActive(a.status)),
    [subagents],
  );
  const finishedAgents = useMemo(
    () => subagents.filter((a) => !isSubagentActive(a.status)),
    [subagents],
  );
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || inspected || !panel.focusedId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-subagent-id="${CSS.escape(panel.focusedId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open, inspected, panel.focusedId]);

  if (!open || !threadId) return null;

  const defaultFinishedOpen = activeAgents.length === 0 && finishedAgents.length <= 3;
  const finishedOpen = threadId in finishedToggle ? finishedToggle[threadId] : defaultFinishedOpen;

  return (
    <>
      {panel.overlay && (
        <div
          className="scrim subagents-scrim"
          onClick={() => toggleSubagentsPanel(threadId, false)}
        />
      )}
      <aside className={`subagents-panel ${panel.overlay ? "overlay" : ""}`} aria-label="Subagents">
        {inspected ? (
          <SubagentDetail
            threadId={threadId}
            agent={inspected}
            overlay={panel.overlay}
            onBack={() => inspectSubagent(threadId, null)}
            onClose={() => toggleSubagentsPanel(threadId, false)}
          />
        ) : (
          <>
            <div className="subagents-head">
              <div className="subagents-title">
                <IconAgents size={14} />
                <span>Subagents</span>
                <span className="meta subagents-count">
                  {activeAgents.length > 0
                    ? `${activeAgents.length} active`
                    : `${subagents.length}`}
                </span>
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
              {activeAgents.map((agent) => (
                <SubagentActiveRow
                  key={agent.id}
                  agent={agent}
                  focused={panel.focusedId === agent.id}
                  onInspect={() => inspectSubagent(threadId, agent.id)}
                />
              ))}
              {finishedAgents.length > 0 && (
                <div className="subagents-group" data-open={finishedOpen || undefined}>
                  <button
                    type="button"
                    className="subagents-group-toggle"
                    aria-expanded={finishedOpen}
                    onClick={() =>
                      setFinishedToggle((prev) => ({ ...prev, [threadId]: !finishedOpen }))
                    }
                  >
                    <IconChevron size={10} />
                    <span>Finished</span>
                    <span className="meta">{finishedAgents.length}</span>
                  </button>
                  {finishedOpen && (
                    <div className="subagents-group-body">
                      {finishedAgents.map((agent) => (
                        <SubagentFinishedRow
                          key={agent.id}
                          agent={agent}
                          focused={panel.focusedId === agent.id}
                          onInspect={() => inspectSubagent(threadId, agent.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function SubagentActiveRow({
  agent,
  focused,
  onInspect,
}: {
  agent: SubagentInfo;
  focused: boolean;
  onInspect: () => void;
}) {
  const metaParts = [agent.role, agent.model, agent.reasoningEffort].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`subagent-card active ${focused ? "focused" : ""}`}
      data-subagent-id={agent.id}
      data-status={agent.status}
      onClick={onInspect}
    >
      <div className="subagent-card-head">
        <span className={`dot ${statusDotClass(agent.status)}`} />
        <span className="subagent-name" title={agent.agentPath ?? agent.id}>
          {agent.name}
        </span>
        <span className="spacer" />
        <span className="meta subagent-status shimmer">{subagentStatusLabel(agent.status)}</span>
        <span className="subagent-chevron" aria-hidden>
          <IconChevron size={10} />
        </span>
      </div>
      {metaParts && <div className="subagent-meta meta">{metaParts}</div>}
      {agent.prompt && <p className="subagent-prompt">{agent.prompt}</p>}
      {agent.message && <p className="subagent-snippet">{agent.message}</p>}
    </button>
  );
}

function SubagentFinishedRow({
  agent,
  focused,
  onInspect,
}: {
  agent: SubagentInfo;
  focused: boolean;
  onInspect: () => void;
}) {
  return (
    <button
      type="button"
      className={`subagent-row-compact ${focused ? "focused" : ""}`}
      data-subagent-id={agent.id}
      data-status={agent.status}
      title={agent.prompt ?? agent.name}
      onClick={onInspect}
    >
      <span className={`dot ${statusDotClass(agent.status)}`} />
      <span className="subagent-name">{agent.name}</span>
      <span className="spacer" />
      <span className="meta subagent-status">{subagentStatusLabel(agent.status)}</span>
      <span className="subagent-chevron" aria-hidden>
        <IconChevron size={10} />
      </span>
    </button>
  );
}

function SubagentDetail({
  threadId,
  agent,
  overlay,
  onBack,
  onClose,
}: {
  threadId: string;
  agent: SubagentInfo;
  overlay: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const childId = agent.thread?.id ?? null;
  const subView = useAppState((s) => (childId ? s.views[childId] : undefined));
  const active = isSubagentActive(agent.status);
  const metaParts = [agent.role, agent.model, agent.reasoningEffort].filter(Boolean).join(" · ");

  useEffect(() => {
    if (childId) void loadSubagentPreview(childId);
  }, [childId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const turns = subView?.turns ?? [];
  const runningTurn = turns.some((t) => t.status === "inProgress");

  return (
    <div className="subagent-detail" data-subagent-id={agent.id} data-status={agent.status}>
      <div className="subagents-head subagent-detail-head">
        <button
          type="button"
          className="icon-btn subagent-back-btn"
          title="All subagents"
          aria-label="All subagents"
          onClick={onBack}
        >
          <IconBack />
        </button>
        <span className="subagent-detail-title" title={agent.agentPath ?? agent.name}>
          {agent.name}
        </span>
        {childId && (
          <button
            type="button"
            className="subagent-open-btn"
            title="Open subagent in main view"
            onClick={() => {
              if (overlay) toggleSubagentsPanel(threadId, false);
              void openThread(childId);
            }}
          >
            Full view
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title="Close subagents panel"
          aria-label="Close subagents panel"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      <div className="subagent-detail-status">
        <span className={`dot ${statusDotClass(agent.status)}`} />
        <span className={active ? "shimmer" : ""}>{subagentStatusLabel(agent.status)}</span>
        {metaParts && <span className="meta">· {metaParts}</span>}
      </div>

      <div className="subagent-detail-body">
        {agent.prompt && (
          <section className="subagent-detail-section">
            <div className="meta subagent-section-label">Task</div>
            <p className="subagent-detail-prompt">{agent.prompt}</p>
          </section>
        )}

        {childId && subView?.load === "loading" && !turns.length && (
          <div className="meta subagent-detail-note">Loading activity…</div>
        )}

        {childId && subView?.load === "error" && (
          <div className="subagent-detail-note bad">
            Couldn't load activity: {subView.loadError}{" "}
            <button
              type="button"
              className="subagent-open-btn"
              onClick={() => void loadSubagentPreview(childId, { force: true })}
            >
              Retry
            </button>
          </div>
        )}

        {turns.length > 0 ? (
          <section className="subagent-detail-section">
            <div className="meta subagent-section-label">Activity</div>
            <div className="subagent-transcript">
              {turns.map((turn) => (
                <div key={turn.id} className="subagent-turn">
                  {turn.items.map((item) => (
                    <ItemView key={item.id} item={item} />
                  ))}
                  {turn.error && <div className="error-card">{turn.error.message}</div>}
                </div>
              ))}
              {(runningTurn || active) && <div className="meta shimmer">Working…</div>}
            </div>
          </section>
        ) : (
          <>
            {agent.message && (
              <section className="subagent-detail-section">
                <div className="meta subagent-section-label">
                  {active ? "Latest update" : "Result"}
                </div>
                <div className="subagent-detail-message">
                  <Markdown text={agent.message} />
                </div>
              </section>
            )}
            {agent.events.length > 0 && (
              <section className="subagent-detail-section">
                <div className="meta subagent-section-label">Timeline</div>
                <ul className="subagent-events">
                  {agent.events.map((ev) => (
                    <li key={ev.id} className="subagent-event">
                      <span className="subagent-event-verb">{ev.verb}</span>
                      <span className="meta">{ev.status}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
