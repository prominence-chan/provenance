import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { appShell } from "../app-shell";
import type { SandboxMode } from "../protocol";
import { interrupt, sendMessage, updateSettings } from "../store/actions";
import type { Settings } from "../store/state";
import { useAppState } from "../store/store";
import { useFx } from "./effects/useFx";
import { IconArrowUp, IconFolder, IconShield, IconStop } from "./icons";
import { shortPath } from "./format";
import { TierPicker } from "./TierPicker";

/** Bottom composer: prompt box + model / permissions / cwd controls. */
export function Composer() {
  const selected = useAppState((s) => s.selectedThreadId);
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const settings = useAppState((s) => s.settings);
  const sending = useAppState((s) => s.sending);
  const ready = useAppState((s) => s.socketOpen && s.bridge?.state === "ready");
  const [text, setText] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const fx = useFx();

  const running = !!view?.turns.some((t) => t.status === "inProgress");

  // The cwd box shows the thread's cwd for existing threads, the default for new ones.
  useEffect(() => {
    setCwdDraft(view?.cwd ?? settings.cwd);
    ref.current?.focus();
    // settings.cwd: the default arrives from /api/info after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, view?.cwd, settings.cwd]);

  // Auto-grow the textarea.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const canSend = ready && !sending && !running && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    const msg = text.trim();
    setText("");
    if (!selected) updateSettings({ cwd: cwdDraft });
    void sendMessage(msg, cwdDraft);
  };

  const pickCwd = async () => {
    const dir = await appShell?.pickDirectory(cwdDraft || undefined);
    if (!dir) return;
    setCwdDraft(dir);
    if (!selected) updateSettings({ cwd: dir });
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      <div
        className="composer-shell"
        data-tier={fx.tier?.id}
        data-streaming={fx.streaming ? "" : undefined}
      >
        <div className="composer">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={selected ? "Ask for follow-up changes" : "Ask Provenance anything"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-bar">
            <TierPicker />
            <PermissionsPicker settings={settings} />
            <label className="cwd-input" title={`Working directory: ${cwdDraft}`}>
              {appShell ? (
                <button
                  type="button"
                  className="cwd-pick"
                  title="Choose folder…"
                  aria-label="Choose working directory"
                  onClick={(e) => {
                    e.preventDefault();
                    void pickCwd();
                  }}
                >
                  <IconFolder size={12} />
                </button>
              ) : (
                <IconFolder size={12} />
              )}
              <input
                value={cwdDraft}
                onChange={(e) => setCwdDraft(e.target.value)}
                spellCheck={false}
                placeholder="working directory"
              />
              {/* At rest, show the end of the path (the part that tells folders apart). */}
              {cwdDraft && (
                <span className="cwd-display" aria-hidden>
                  <bdi>{shortPath(cwdDraft)}</bdi>
                </span>
              )}
            </label>
            <div className="spacer" />
            {running ? (
              <button
                className="send-btn stop"
                title="Interrupt"
                onClick={() => selected && void interrupt(selected)}
              >
                <IconStop size={12} />
              </button>
            ) : (
              <button
                className="send-btn"
                title="Send (Enter)"
                disabled={!canSend}
                onClick={submit}
              >
                <IconArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Codex-style presets over (approvalPolicy, sandbox). */
const PRESETS: {
  id: string;
  label: string;
  approvalPolicy: Settings["approvalPolicy"];
  sandbox: SandboxMode;
}[] = [
  { id: "ask", label: "Ask every time", approvalPolicy: "untrusted", sandbox: "workspace-write" },
  { id: "auto", label: "Auto", approvalPolicy: "on-request", sandbox: "workspace-write" },
  { id: "readonly", label: "Read only", approvalPolicy: "on-request", sandbox: "read-only" },
  { id: "full", label: "Full access", approvalPolicy: "never", sandbox: "danger-full-access" },
];

function PermissionsPicker({ settings }: { settings: Settings }) {
  const current = PRESETS.find(
    (p) => p.approvalPolicy === settings.approvalPolicy && p.sandbox === settings.sandbox,
  );
  return (
    <label
      className="picker-wrap"
      title={`approval: ${settings.approvalPolicy}, sandbox: ${settings.sandbox}`}
    >
      <IconShield size={12} />
      <select
        className="picker"
        title={`approval: ${settings.approvalPolicy}, sandbox: ${settings.sandbox}`}
        value={current?.id ?? "custom"}
        onChange={(e) => {
          const p = PRESETS.find((x) => x.id === e.target.value);
          if (p) updateSettings({ approvalPolicy: p.approvalPolicy, sandbox: p.sandbox });
        }}
      >
        {!current && <option value="custom">Custom</option>}
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
