import type { ServerRequest, ThreadItem } from "../protocol";
import {
  answerCommandApproval,
  answerFileChangeApproval,
  rejectServerRequest,
} from "../store/actions";
import { useAppState } from "../store/store";
import { DiffView } from "./DiffView";
import { IconShield } from "./icons";

/**
 * Pending server->client requests for this thread. app-server blocks the turn
 * until the client answers, so these must always render somewhere visible.
 */
export function Approvals({ threadId }: { threadId: string }) {
  const requests = useAppState((s) => s.serverRequests);
  const mine = requests.filter((r) => (r.params as { threadId?: string }).threadId === threadId);
  if (!mine.length) return null;
  return (
    <div className="approvals">
      {mine.map((r) => (
        <ApprovalCard key={String(r.id)} req={r} threadId={threadId} />
      ))}
    </div>
  );
}

function ApprovalCard({ req, threadId }: { req: ServerRequest; threadId: string }) {
  const item = useAppState((s) => {
    const itemId = (req.params as { itemId?: string }).itemId;
    if (!itemId) return undefined;
    for (const t of s.views[threadId]?.turns ?? []) {
      const it = t.items.find((i) => i.id === itemId);
      if (it) return it;
    }
    return undefined;
  });

  if (req.method === "item/commandExecution/requestApproval") {
    const p = req.params;
    const command = p.command ?? (item?.type === "commandExecution" ? item.command : "(command)");
    return (
      <div className="card approval">
        <div className="approval-head">
          <IconShield size={15} /> Run this command?
        </div>
        <pre className="approval-cmd">{command}</pre>
        {p.cwd && <div className="muted mono small">in {p.cwd}</div>}
        {p.reason && <div className="approval-reason">{p.reason}</div>}
        <div className="approval-actions">
          <button className="btn-primary" onClick={() => answerCommandApproval(req, "accept")}>
            Approve
          </button>
          <button className="btn" onClick={() => answerCommandApproval(req, "acceptForSession")}>
            Approve for session
          </button>
          <button className="btn btn-danger" onClick={() => answerCommandApproval(req, "decline")}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (req.method === "item/fileChange/requestApproval") {
    const p = req.params;
    const changes = item?.type === "fileChange" ? item.changes : [];
    return (
      <div className="card approval">
        <div className="approval-head">
          <IconShield size={15} /> Apply these changes?
        </div>
        {p.reason && <div className="approval-reason">{p.reason}</div>}
        {p.grantRoot && <div className="muted small">Requests write access to {p.grantRoot}</div>}
        {changes.map((c) => (
          <div key={c.path} className="approval-file">
            <div className="mono small">{c.path}</div>
            <DiffView diff={c.diff} />
          </div>
        ))}
        <div className="approval-actions">
          <button className="btn-primary" onClick={() => answerFileChangeApproval(req, "accept")}>
            Approve
          </button>
          <button className="btn" onClick={() => answerFileChangeApproval(req, "acceptForSession")}>
            Approve for session
          </button>
          <button
            className="btn btn-danger"
            onClick={() => answerFileChangeApproval(req, "decline")}
          >
            Deny
          </button>
        </div>
      </div>
    );
  }

  // Not implemented yet (user input prompts, MCP elicitation, permissions, ...).
  return <UnsupportedRequest req={req} item={item} />;
}

function UnsupportedRequest({ req }: { req: ServerRequest; item?: ThreadItem }) {
  return (
    <div className="card approval">
      <div className="approval-head">
        <IconShield size={15} /> {req.method}
      </div>
      <div className="muted small">Provenance can't handle this request type yet.</div>
      <pre className="approval-cmd">{JSON.stringify(req.params, null, 2)}</pre>
      <div className="approval-actions">
        <button className="btn btn-danger" onClick={() => rejectServerRequest(req)}>
          Dismiss (reply with error)
        </button>
      </div>
    </div>
  );
}
