import type { ThreadItem } from "../../protocol";
import { useAppState } from "../../store/store";
import { IconAgents, IconChevron } from "../icons";
import {
  collectSubagents,
  focusSubagent,
  formatActivityVerb,
  formatCollabVerb,
  isSubagentActive,
  subagentStatusLabel,
} from "../subagents";

type CollabItem = Extract<ThreadItem, { type: "collabAgentToolCall" | "subAgentActivity" }>;

/** Renders `collabAgentToolCall` and `subAgentActivity` cleanly instead of raw JSON fallback. */
export function CollabAgentCard({ item }: { item: CollabItem }) {
  const threadId = useAppState((s) => s.selectedThreadId);
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const threads = useAppState((s) => s.threads);
  const subagents = collectSubagents(view, threads);
  const nameOf = (id: string) => subagents.find((a) => a.id === id)?.name ?? id.slice(0, 12);

  if (item.type === "subAgentActivity") {
    const label = nameOf(item.agentThreadId);
    const active = item.kind === "started" || item.kind === "interacted";
    return (
      <div className="tool-row collab-card collab-activity">
        <div className="collab-inline">
          <IconAgents size={13} />
          <span className={`tool-verb ${active ? "shimmer" : ""}`}>
            {formatActivityVerb(item.kind)}
          </span>
          <code className="tool-target">{label}</code>
          {item.model && <span className="meta">{item.model}</span>}
          {threadId && (
            <button
              type="button"
              className="collab-inspect"
              onClick={() => focusSubagent(threadId, item.agentThreadId)}
            >
              Inspect
            </button>
          )}
        </div>
      </div>
    );
  }

  const inProgress = item.status === "inProgress";
  const failed = item.status === "failed";
  const targets = [
    ...new Set([...item.receiverThreadIds, ...Object.keys(item.agentsStates ?? {})]),
  ].filter(Boolean);
  const verb = formatCollabVerb(item.tool, inProgress);
  const primaryId = targets[0] ?? null;
  const targetLabel =
    targets.length === 1
      ? nameOf(targets[0])
      : targets.length > 1
        ? `${targets.length} subagents`
        : item.prompt
          ? item.prompt.slice(0, 60)
          : null;

  const states = Object.entries(item.agentsStates ?? {}).filter(
    (entry): entry is [string, NonNullable<(typeof item.agentsStates)[string]>] => !!entry[1],
  );
  const activeCount = states.filter(([, st]) => isSubagentActive(st.status)).length;
  const statusText = inProgress
    ? activeCount
      ? `${activeCount} running`
      : "running"
    : failed
      ? "failed"
      : item.status === "interrupted"
        ? "stopped"
        : states.length === 1
          ? subagentStatusLabel(states[0][1].status)
          : null;

  return (
    <details className={`tool-row collab-card ${failed ? "failed" : ""}`}>
      <summary>
        <IconChevron size={11} />
        <IconAgents size={13} />
        <span className={`tool-verb ${inProgress ? "shimmer" : ""}`}>{verb}</span>
        {targetLabel && <code className="tool-target">{targetLabel}</code>}
        <span className="tool-meta">
          {statusText && (
            <span
              className={`collab-pill ${failed ? "bad" : inProgress || activeCount ? "busy" : ""}`}
            >
              {statusText}
            </span>
          )}
          {threadId && primaryId && (
            <button
              type="button"
              className="collab-inspect"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                focusSubagent(threadId, primaryId);
              }}
            >
              Panel
            </button>
          )}
        </span>
      </summary>
      <div className="tool-body collab-body">
        {item.prompt && (
          <div className="collab-section">
            <div className="meta">Task</div>
            <p className="collab-prompt">{item.prompt}</p>
          </div>
        )}
        {states.length > 0 && (
          <div className="collab-section">
            <div className="meta">Subagents</div>
            <ul className="collab-states">
              {states.map(([id, st]) => (
                <li key={id} className="collab-state-row">
                  <span
                    className={`dot ${
                      isSubagentActive(st.status)
                        ? "dot-busy"
                        : st.status === "completed"
                          ? "dot-ok"
                          : st.status === "errored"
                            ? "dot-err"
                            : "dot-off"
                    }`}
                  />
                  <span className="collab-state-name">{nameOf(id)}</span>
                  <span className="meta">{subagentStatusLabel(st.status)}</span>
                  {st.message && <p className="collab-state-msg">{st.message}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!item.prompt && states.length === 0 && (
          <div className="meta">No additional details reported for this step.</div>
        )}
      </div>
    </details>
  );
}
