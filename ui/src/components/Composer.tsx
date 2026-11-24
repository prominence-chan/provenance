import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { appShell } from "../app-shell";
import type { SandboxMode } from "../protocol";
import { backendOfModel, MODE_NAME, servedByName } from "../fallback/model";
import { parseFallbackModel } from "../../shared/fallback-api";
import { findKey, isAssistView } from "../setup/assist-text";
import { KeyIntercept, usePoolData } from "../setup/PoolAssist";
import { interrupt, sendMessage, updateSettings } from "../store/actions";
import { movesConversation } from "../store/segments";
import type { Settings } from "../store/state";
import { useAppState } from "../store/store";
import { useFx } from "./effects/useFx";
import { IconArrowUp, IconFolder, IconShield, IconStop } from "./icons";
import { shortPath } from "./format";
import { ComposerSlot } from "./ComposerSlot";
import { TierPicker } from "./TierPicker";

/** Bottom composer: prompt box + model / permissions / cwd controls. */
export function Composer() {
  const selected = useAppState((s) => s.selectedThreadId);
  const view = useAppState((s) => (s.selectedThreadId ? s.views[s.selectedThreadId] : undefined));
  const settings = useAppState((s) => s.settings);
  const sending = useAppState((s) => s.sending);
  const target = backendOfModel(settings.model);
  // The codex backend starts on first use (sendMessage waits for it).
  const ready = useAppState((s) =>
    target === "main"
      ? s.socketOpen && s.bridge?.state === "ready"
      : target === "fallback"
        ? s.backendReady.fallback
        : true,
  );
  // The token pool's setup assistant: its thread stays where it is, read only, and a key typed
  // or pasted here is caught before it is sent (setup/PoolAssist.tsx).
  const assist = useAppState((s) =>
    s.selectedThreadId ? isAssistView(s.views[s.selectedThreadId]) : false,
  );
  // The open conversation runs elsewhere than the picker says: sending moves it there, in this
  // same thread (store/actions.ts handOver).
  const handoff = useAppState((s) =>
    s.selectedThreadId && !assist
      ? movesConversation(s, s.selectedThreadId, s.settings.model)
      : false,
  );
  const fb = parseFallbackModel(settings.model);
  const movedTo = servedByName(settings.model);
  const placeholder = !selected
    ? "Ask Provenance anything"
    : assist
      ? "Answer the assistant, or tell it to stop"
      : handoff
        ? `Continue in ${movedTo}`
        : "Ask for follow-up changes";
  const [text, setText] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [caught, setCaught] = useState<{ text: string; key: string; guess: string | null } | null>(
    null,
  );
  const pool = usePoolData(assist);
  useEffect(() => setCaught(null), [selected]);
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

  // While a turn runs, a message can still move the conversation: the turn stops first.
  const canSend = ready && !sending && (!running || handoff) && text.trim().length > 0;
  const stopButton = running && !(handoff && text.trim());
  // Claude Code and Codex in the background can't ask the page for approval: "Ask every time"
  // runs them like Auto (server/fallback/backend.ts). Say so before sending, without blocking.
  const noAsk =
    fb && fb.mode !== "codex-pv" && settings.approvalPolicy === "untrusted"
      ? fb.mode === "codex"
        ? "Codex in the background"
        : MODE_NAME[fb.mode]
      : null;

  const submit = () => {
    if (!canSend) return;
    const msg = text.trim();
    if (assist && selected) {
      const k = findKey(msg, pool?.help?.providers ?? []);
      if (k) {
        setText("");
        setCaught({ text: msg, key: k.key, guess: k.provider });
        return;
      }
    }
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
        data-fallback={fx.fallback ?? undefined}
        data-streaming={fx.streaming ? "" : undefined}
      >
        <div className="composer">
          {caught && selected && (
            <KeyIntercept
              threadId={selected}
              text={caught.text}
              keyText={caught.key}
              guess={caught.guess}
              onEdit={() => {
                setText(caught.text);
                setCaught(null);
                ref.current?.focus();
              }}
              onDone={() => setCaught(null)}
            />
          )}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-bar">
            <TierPicker />
            <ComposerSlot />
            {assist ? (
              <span className="assist-perms" title="The setup assistant runs read only">
                <IconShield size={12} />
                Read only
              </span>
            ) : (
              <PermissionsPicker settings={settings} />
            )}
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
                readOnly={assist}
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
            {stopButton ? (
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
                title={running ? `Stop, then continue in ${movedTo} (Enter)` : "Send (Enter)"}
                disabled={!canSend}
                onClick={submit}
              >
                <IconArrowUp size={14} />
              </button>
            )}
          </div>
          {noAsk && (
            <p className="composer-note warn" role="note">
              {noAsk} can't ask for approval here: it will run without asking, like Auto.
            </p>
          )}
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
