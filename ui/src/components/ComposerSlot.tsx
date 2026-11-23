import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DEFAULT_ORCHESTRATOR,
  ORCHESTRATORS,
  type FallbackEffort,
  type Orchestrator,
} from "../../shared/orchestrator-api";
import { EFFORT_LABEL, effortsFor, chosenEffort } from "../fallback/effort";
import { fallbackOf } from "../fallback/model";
import { threadOrchestrator } from "../orchestrator/thread";
import { updateSettings } from "../store/actions";
import { tierSegmentOf } from "../store/segments";
import { useAppState } from "../store/store";
import { IconCheck, IconChevronDown } from "./icons";

/**
 * The composer's slot after the model picker: a fallback's reasoning effort (Claude Code, Codex),
 * or, on a tier, who orchestrates the thread (Provenance, Experimental, Hyperexperimental). Same
 * look and keys as the model picker: a quiet button that opens a list above the composer.
 */
export function ComposerSlot() {
  const model = useAppState((s) => s.settings.model);
  const cli = fallbackOf(model);
  return cli ? <EffortPicker /> : <OrchestratorPicker />;
}

function EffortPicker() {
  const settings = useAppState((s) => s.settings);
  const info = useAppState((s) => s.fallbackInfo);
  const cli = fallbackOf(settings.model)!;
  const choice = effortsFor(settings.model, info);
  const efforts = choice?.efforts ?? [];
  // Nothing to choose (an older Claude Code without --effort, or not checked yet): no control.
  if (!efforts.length) return null;
  const current = chosenEffort(settings, info);
  const level = (e: FallbackEffort | null) => (e ? efforts.indexOf(e) + 1 : 0);
  const options: SlotOption[] = [
    {
      id: "default",
      name: "Default",
      meta: choice?.defaultEffort ? EFFORT_LABEL[choice.defaultEffort] : null,
      glyph: <Meter n={efforts.length} filled={0} />,
    },
    ...efforts.map((e) => ({
      id: e,
      name: EFFORT_LABEL[e],
      meta: null,
      glyph: <Meter n={efforts.length} filled={level(e)} />,
    })),
  ];
  return (
    <SlotMenu
      kind="effort"
      heading="Reasoning effort"
      title={`Reasoning effort: ${current ? EFFORT_LABEL[current] : "Default"}`}
      options={options}
      value={current ?? "default"}
      fallback={cli}
      button={
        <>
          <Meter n={efforts.length} filled={level(current)} />
          <span className={`slot-label ${current ? "" : "quiet"}`}>
            {current ? EFFORT_LABEL[current] : "Effort"}
          </span>
        </>
      }
      onChoose={(id) =>
        updateSettings({
          fallbackEffort: {
            ...settings.fallbackEffort,
            [cli]: id === "default" ? null : (id as FallbackEffort),
          },
        })
      }
    />
  );
}

function OrchestratorPicker() {
  const chosen = useAppState((s) => s.settings.orchestrator);
  const thread = useAppState((s) =>
    s.selectedThreadId ? s.views[s.selectedThreadId]?.thread : null,
  );
  // An open conversation keeps the tier harness it ran on (the one it goes back to from a
  // fallback, store/segments.ts): shown, not changed here.
  const tierThread = useAppState((s) =>
    s.selectedThreadId ? (tierSegmentOf(s, s.selectedThreadId)?.threadId ?? null) : null,
  );
  const own = tierThread ? threadOrchestrator(tierThread, thread) : null;
  const value = own ?? chosen ?? DEFAULT_ORCHESTRATOR;
  const o = ORCHESTRATORS.find((x) => x.id === value) ?? ORCHESTRATORS[0];
  const options: SlotOption[] = ORCHESTRATORS.map((x, i) => ({
    id: x.id,
    name: x.name,
    meta: x.blurb,
    glyph: <OrchestratorGlyph id={x.id} size={18} />,
    group: i === 1,
  }));
  return (
    <SlotMenu
      kind="orchestrator"
      heading="Orchestrator"
      title={
        own
          ? `This thread runs on ${o.name}. New threads use your choice.`
          : `Orchestrator: ${o.name}. ${o.blurb}.`
      }
      options={options}
      value={value}
      readOnly={!!own}
      button={
        <>
          <OrchestratorGlyph id={value} size={15} />
          <span className="slot-label">{o.name}</span>
        </>
      }
      onChoose={(id) => updateSettings({ orchestrator: id as Orchestrator })}
    />
  );
}

// ---- the shared menu -------------------------------------------------------------------------

interface SlotOption {
  id: string;
  name: string;
  meta: string | null;
  glyph: ReactNode;
  /** Starts a group (a thin rule above it). */
  group?: boolean;
}

function SlotMenu(props: {
  kind: "effort" | "orchestrator";
  heading: string;
  title: string;
  options: SlotOption[];
  value: string;
  button: ReactNode;
  onChoose: (id: string) => void;
  readOnly?: boolean;
  fallback?: string;
}) {
  const { kind, options, value, readOnly } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.id === value)));
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (readOnly) setOpen(false);
  }, [readOnly]);

  // The list opens above the composer (like the model picker's), lined up with its button.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const btn = btnRef.current;
    const box = menu?.offsetParent as HTMLElement | null;
    if (!menu || !btn || !box) return;
    const left = btn.getBoundingClientRect().left - box.getBoundingClientRect().left - 5;
    menu.style.left = `${Math.max(0, Math.min(left, box.clientWidth - menu.offsetWidth))}px`;
  });

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    props.onChoose(o.id);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (readOnly) return;
    if (!open) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (!["Escape", "ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") setActive((i) => Math.min(options.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else choose(active);
  };

  const optId = (o: SlotOption) => `slot-${kind}-${o.id}`;
  return (
    <div className={`slot-picker slot-${kind}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className={`picker slot-btn ${open ? "open" : ""} ${readOnly ? "readonly" : ""}`}
        title={props.title}
        aria-label={props.title}
        aria-haspopup={readOnly ? undefined : "listbox"}
        aria-expanded={readOnly ? undefined : open}
        aria-disabled={readOnly || undefined}
        aria-activedescendant={open && options[active] ? optId(options[active]) : undefined}
        data-fallback={props.fallback}
        data-value={value}
        onClick={() => !readOnly && setOpen((o) => !o)}
      >
        {props.button}
        {!readOnly && <IconChevronDown size={12} />}
      </button>
      {open && (
        <div
          className={`tier-menu slot-menu slot-menu-${kind}`}
          role="listbox"
          aria-label={props.heading}
          ref={menuRef}
          data-fallback={props.fallback}
        >
          <div className="slot-menu-head meta" role="presentation">
            {props.heading}
          </div>
          {options.map((o, i) => (
            <div
              key={o.id}
              id={optId(o)}
              role="option"
              aria-selected={o.id === value}
              data-value={o.id}
              data-fallback={props.fallback}
              className={`tier-option slot-option ${i === active ? "active" : ""} ${o.group ? "group" : ""}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="slot-option-glyph">{o.glyph}</span>
              <span className="tier-option-text">
                <span className="tier-option-name">{o.name}</span>
                {o.meta && kind === "orchestrator" && <span className="meta">{o.meta}</span>}
              </span>
              {o.meta && kind === "effort" && <span className="meta">{o.meta}</span>}
              <span className="tier-option-check">
                {o.id === value && <IconCheck size={13} />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- glyphs ----------------------------------------------------------------------------------

/** A level meter: `n` rising bars, the first `filled` lit (0: Default, all unlit). */
function Meter({ n, filled }: { n: number; filled: number }) {
  const w = 2;
  const gap = 1.25;
  const W = n * w + (n - 1) * gap;
  return (
    <svg
      className="effort-meter"
      width={Math.max(10, W)}
      height={11}
      viewBox={`0 0 ${Math.max(10, W)} 11`}
      aria-hidden
    >
      {Array.from({ length: n }, (_, i) => {
        const h = 3 + ((i + 1) / n) * 8;
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={11 - h}
            width={w}
            height={h}
            rx={0.6}
            className={i < filled ? "on" : "off"}
          />
        );
      })}
    </svg>
  );
}

/**
 * What each orchestrator does, drawn: one thread (a single line); split into small tasks for
 * fresh workers (one node fanning out); every step in new chats carrying a summary (separate
 * steps with only a dot passed between them).
 */
function OrchestratorGlyph({ id, size = 14 }: { id: Orchestrator; size?: number }) {
  return (
    <svg
      className="orch-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {id === "provenance" && (
        <>
          <circle cx="5" cy="12" r="2" />
          <path d="M7 12h10" />
          <circle cx="19" cy="12" r="2" />
        </>
      )}
      {id === "experimental" && (
        <>
          <circle cx="5" cy="12" r="2" />
          <path d="M7 12h3l6-6M10 12h6M10 12l6 6" />
          <circle cx="18.5" cy="6" r="1.5" />
          <circle cx="18.5" cy="12" r="1.5" />
          <circle cx="18.5" cy="18" r="1.5" />
        </>
      )}
      {id === "hyperexperimental" && (
        <>
          <rect x="2" y="9" width="5" height="6" rx="1.5" />
          <rect x="9.5" y="9" width="5" height="6" rx="1.5" />
          <rect x="17" y="9" width="5" height="6" rx="1.5" />
          <path d="M8.25 12h0M15.75 12h0" strokeWidth={1.6} />
        </>
      )}
    </svg>
  );
}
