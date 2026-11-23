import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { parseFallbackModel } from "../../shared/fallback-api";
import { fallbacks, type Fallback } from "../fallback/available";
import { fallbackLabel, fallbackOf } from "../fallback/model";
import { openSetup } from "../setup/open";
import {
  refreshFallbacks,
  refreshSources,
  setFallbackPrefs,
  updateSettings,
} from "../store/actions";
import type { Source } from "../store/state";
import { useAppState } from "../store/store";
import { sortTiers, splitModel, tierOf } from "../theme/tiers";
import { IconCheck, IconChevron, IconChevronDown, IconTerminal } from "./icons";
import { TierGlyph, useSourceLabel } from "./TierBadge";

/**
 * One row of a submenu: for a tier, Auto (the plain tier), a pinnable source, or a source that
 * needs something first (API keys, a sign-in), which opens Models & accounts there; for a
 * fallback, one of the models its CLI offers, or (Codex) how its turns run.
 */
interface SubItem {
  key: string;
  /** What gets sent as the model: "solstice" (Auto), "luna/solstice", "claude:opus". */
  model: string;
  label: string;
  meta: string | null;
  disabled: boolean;
  /** Set up what it needs instead of choosing it. */
  setup?: "keys" | "signin";
  /** Codex: switch how turns run instead of choosing a model. */
  codexMode?: "background" | "provenance";
  /** Starts a group (a thin rule above it). */
  group?: boolean;
}

/** "79% left · 1 busy": usage left today, and live requests only when there are some. */
function usageText(s: Source): string | null {
  if (s.needs === "keys") return "Add API keys…";
  if (s.needs === "signin") return "Sign in…";
  if (!s.available) return "Unavailable";
  const parts: string[] = [];
  if (s.remaining !== null) parts.push(`${Math.round(s.remaining * 100)}% left`);
  if (s.busy > 0) parts.push(`${s.busy} busy`);
  return parts.join(" · ") || null;
}

/**
 * Auto first, then each source the router lets us pin, best first, then the ones that need
 * keys or a sign-in. Other sources that can't be pinned are left out (Auto may still use
 * them). Empty when the router lists no sources for the tier: then there is no submenu.
 */
function subItemsFor(tier: string, sources: Record<string, Source[]>): SubItem[] {
  const list = sources[tier] ?? [];
  const pins = list.filter((s) => s.pinnable);
  const needs = list.filter((s) => !s.pinnable && s.needs);
  if (!pins.length && !needs.length) return [];
  return [
    { key: "auto", model: tier, label: "Auto", meta: null, disabled: false },
    ...pins.map((s) => ({
      key: s.id,
      model: s.model,
      label: s.label,
      meta: usageText(s),
      disabled: !s.available,
    })),
    ...needs.map((s) => ({
      key: s.id,
      model: s.model,
      label: s.label,
      meta: usageText(s),
      disabled: false,
      setup: s.needs ?? undefined,
    })),
  ];
}

/** A ready fallback's models; for Codex, then the two ways its turns can run. */
function fallbackItems(f: Fallback, codexBgOk: boolean, codexPvOk: boolean): SubItem[] {
  if (!f.ready) return [];
  const items: SubItem[] = f.models.map((m) => ({
    key: `${f.mode}:${m.id}`,
    model: `${f.mode}:${m.id}`,
    label: m.label,
    meta: null,
    disabled: false,
  }));
  if (f.cli === "codex")
    items.push(
      {
        key: "mode-pv",
        model: "",
        label: "Through Provenance",
        meta: codexPvOk ? null : "Unavailable",
        disabled: !codexPvOk,
        codexMode: "provenance",
        group: true,
      },
      {
        key: "mode-bg",
        model: "",
        label: "In the background",
        meta: codexBgOk ? null : "Unavailable",
        disabled: !codexBgOk,
        codexMode: "background",
      },
    );
  return items;
}

/** Hover delay before another row's submenu replaces the open one (lets the pointer cross rows). */
const SWITCH_DELAY_MS = 140;

/**
 * Model dropdown (opens upward from the composer): the tiers, then the fallbacks (Claude Code,
 * Codex). Hovering or arrowing onto a row opens its submenu: a tier's sources (Auto, or one
 * pinned source), a fallback's models. A fallback that is off or not ready is a muted row that
 * opens its setup.
 */
export function TierPicker() {
  const tiers = useAppState((s) => s.tiers);
  const sources = useAppState((s) => s.sources);
  const model = useAppState((s) => s.settings.model);
  const prefs = useAppState((s) => s.settings.fallbacks);
  const info = useAppState((s) => s.fallbackInfo);
  const pinnedLabel = useSourceLabel(model);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Submenu shown for the active row (after a hover or arrow key, not on open). */
  const [subOpen, setSubOpen] = useState(false);
  /** Highlighted submenu row; null while the keyboard is in the main list. */
  const [subActive, setSubActive] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const switchTimer = useRef<number | undefined>(undefined);
  const list = sortTiers(tiers);
  const fbs = fallbacks(prefs, info);
  const codexBgOk = !!info?.codex.installed && info.codex.signedIn !== false && !info.codex.problem;
  const codexPvOk = !!info?.codex.provenance.ready;
  const picked = parseFallbackModel(model);
  const { tier: currentTier } = splitModel(model);
  const current = picked ? null : tierOf(model);
  const fbLabel = fallbackLabel(model, info);
  const rows = list.length + fbs.length;
  const itemsFor = (i: number): SubItem[] =>
    i < list.length
      ? subItemsFor(list[i], sources)
      : fbs[i - list.length]
        ? fallbackItems(fbs[i - list.length], codexBgOk, codexPvOk)
        : [];
  const subItems = open && subOpen ? itemsFor(active) : [];

  useEffect(() => {
    if (!open) return;
    void refreshSources();
    void refreshFallbacks();
    const fbIndex = picked
      ? fbs.findIndex((f) => f.cli === (picked.mode === "claude" ? "claude" : "codex"))
      : -1;
    setActive(fbIndex >= 0 ? list.length + fbIndex : Math.max(0, list.indexOf(currentTier)));
    setSubOpen(false);
    setSubActive(null);
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.clearTimeout(switchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Place the submenu beside its row, never lower than the menu's bottom edge (the composer is
  // below it); without room on the right it sits above the menu instead.
  useLayoutEffect(() => {
    const sub = subRef.current;
    const menu = menuRef.current;
    const row = rowRefs.current[active];
    if (!sub || !menu || !row) return;
    const roomRight = window.innerWidth - menu.getBoundingClientRect().right - 8;
    if (roomRight >= sub.offsetWidth + 4) {
      const top = Math.min(row.offsetTop - 5, menu.clientHeight - sub.offsetHeight + 1);
      sub.style.left = "";
      sub.style.top = `${Math.max(-1, top)}px`;
    } else {
      sub.style.left = "-1px";
      sub.style.top = `${-sub.offsetHeight - 5}px`;
    }
  });

  const choose = (m: string) => {
    updateSettings({ model: m });
    setOpen(false);
    btnRef.current?.focus();
  };
  const pick = (it: SubItem) => {
    if (it.disabled) return;
    if (it.codexMode) {
      setFallbackPrefs({ codex: it.codexMode });
      // The chosen Codex model moves over to the other way of running it.
      const was = parseFallbackModel(model);
      if (was && was.mode !== "claude")
        updateSettings({ model: `${it.codexMode === "provenance" ? "codex-pv" : "codex"}:` });
      return;
    }
    if (!it.setup) return choose(it.model);
    setOpen(false);
    openSetup(null, it.setup === "keys" ? "keys" : undefined);
  };
  /** A main-list row chosen (click, Enter): a tier, a ready fallback's default, or its setup. */
  const chooseRow = (i: number) => {
    if (i < list.length) return choose(list[i]);
    const f = fbs[i - list.length];
    if (!f) return;
    if (!f.ready) {
      setOpen(false);
      openSetup(null, "fallbacks");
      return;
    }
    const same = picked && picked.mode === f.mode ? model : `${f.mode}:`;
    choose(same);
  };

  /** Pointer on a row: switch at once, or after a beat when another submenu is open. */
  const hoverRow = (i: number) => {
    window.clearTimeout(switchTimer.current);
    const go = () => {
      setActive(i);
      setSubOpen(true);
      setSubActive(null);
    };
    if (subOpen && i !== active && subItems.length) {
      switchTimer.current = window.setTimeout(go, SWITCH_DELAY_MS);
    } else go();
  };

  const stepSub = (from: number | null, dir: 1 | -1): number | null => {
    for (let j = (from ?? (dir > 0 ? -1 : subItems.length)) + dir; ; j += dir) {
      if (j < 0 || j >= subItems.length) return from;
      if (!subItems[j].disabled) return j;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const keys = ["Escape", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter", " "];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    if (subActive !== null) {
      // In the submenu.
      if (e.key === "Escape" || e.key === "ArrowLeft") setSubActive(null);
      else if (e.key === "ArrowDown") setSubActive((j) => stepSub(j, 1));
      else if (e.key === "ArrowUp") setSubActive((j) => stepSub(j, -1));
      else if (e.key === "Enter" || e.key === " ") {
        const it = subItems[subActive];
        if (it) pick(it);
      }
      return;
    }
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setActive((i) => (e.key === "ArrowDown" ? Math.min(rows - 1, i + 1) : Math.max(0, i - 1)));
      setSubOpen(true);
    } else if (e.key === "ArrowRight") {
      const items = itemsFor(active);
      if (!items.length) return;
      setSubOpen(true);
      const sel = items.findIndex((it) => !it.codexMode && it.model === model);
      setSubActive(sel >= 0 ? sel : 0);
    } else if (e.key === "Enter" || e.key === " ") {
      chooseRow(active);
    }
  };

  const activeId = !open
    ? undefined
    : subActive !== null
      ? `tier-src-${subActive}`
      : active < list.length
        ? list[active] && `tier-opt-${list[active]}`
        : fbs[active - list.length] && `tier-opt-fb-${fbs[active - list.length].cli}`;

  const subChecked = (it: SubItem) =>
    it.codexMode ? prefs.codex === it.codexMode : !it.setup && it.model === model;

  return (
    <div className="tier-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className={`picker tier-picker-btn ${open ? "open" : ""}`}
        title="Model tier"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={activeId}
        data-tier={current?.id}
        data-fallback={fallbackOf(model) ?? undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {fbLabel ? (
          <>
            <IconTerminal size={12} />
            <span className="tier-name">{fbLabel.name}</span>
            <span className="tier-source">· {fbLabel.model}</span>
          </>
        ) : (
          <>
            <TierGlyph tier={current?.id ?? null} size={12} />
            <span className="tier-name">{pinnedLabel ? currentTier : model}</span>
            {pinnedLabel && <span className="tier-source">· {pinnedLabel}</span>}
          </>
        )}
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="tier-menu" role="listbox" aria-label="Model" ref={menuRef}>
          {list.map((m, i) => {
            const t = tierOf(m);
            const hasSub = subItemsFor(m, sources).length > 0;
            return (
              <div
                key={m}
                id={`tier-opt-${m}`}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                role="option"
                aria-selected={!picked && m === currentTier}
                aria-haspopup={hasSub ? "listbox" : undefined}
                aria-expanded={hasSub ? subOpen && i === active : undefined}
                data-tier={t?.id}
                data-model={m}
                className={`tier-option ${i === active ? "active" : ""}`}
                onPointerEnter={() => hoverRow(i)}
                onClick={() => choose(m)}
              >
                <span className="tier-option-glyph">
                  <TierGlyph tier={t?.id ?? null} size={14} />
                </span>
                <span className="tier-option-text">
                  <span className="tier-option-name">{m}</span>
                  {t && <span className="meta">{t.blurb}</span>}
                </span>
                {t && <span className="meta">{t.effort}</span>}
                <span className="tier-option-check">
                  {!picked && m === currentTier && <IconCheck size={14} />}
                </span>
                {hasSub && (
                  <span className="tier-option-more">
                    <IconChevron size={10} />
                  </span>
                )}
              </div>
            );
          })}
          <div className="tier-section meta" role="presentation">
            Fallbacks
          </div>
          {fbs.map((f, k) => {
            const i = list.length + k;
            const selected = !!picked && (picked.mode === "claude") === (f.cli === "claude");
            const meta = f.ready
              ? f.cli === "codex"
                ? f.mode === "codex-pv"
                  ? "Through Provenance"
                  : "In the background"
                : "Your Claude subscription"
              : f.on && f.problem && f.problem !== "Off"
                ? f.problem
                : "Set up…";
            return (
              <div
                key={f.cli}
                id={`tier-opt-fb-${f.cli}`}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                role="option"
                aria-selected={selected}
                aria-haspopup={f.ready ? "listbox" : undefined}
                aria-expanded={f.ready ? subOpen && i === active : undefined}
                data-fallback={f.cli}
                className={`tier-option fallback-option ${i === active ? "active" : ""} ${f.ready ? "" : "muted"}`}
                onPointerEnter={() => hoverRow(i)}
                onClick={() => chooseRow(i)}
              >
                <span className="tier-option-glyph">
                  <IconTerminal size={13} />
                </span>
                <span className="tier-option-text">
                  <span className="tier-option-name">{f.name}</span>
                  <span className="meta">{meta}</span>
                </span>
                <span className="tier-option-check">{selected && <IconCheck size={14} />}</span>
                {f.ready && (
                  <span className="tier-option-more">
                    <IconChevron size={10} />
                  </span>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="tier-setup"
            onPointerEnter={() => {
              window.clearTimeout(switchTimer.current);
              setSubOpen(false);
            }}
            onClick={() => {
              setOpen(false);
              openSetup();
            }}
          >
            Models &amp; accounts…
          </button>
          {subItems.length > 0 && (
            <div
              className="tier-sub"
              role="listbox"
              aria-label={
                active < list.length
                  ? `Source for ${list[active]}`
                  : `Model for ${fbs[active - list.length]?.name}`
              }
              data-tier={active < list.length ? tierOf(list[active])?.id : undefined}
              data-fallback={active >= list.length ? fbs[active - list.length]?.cli : undefined}
              ref={subRef}
              onPointerEnter={() => window.clearTimeout(switchTimer.current)}
              onPointerLeave={() => setSubActive(null)}
            >
              {subItems.map((it, j) => (
                <div
                  key={it.key}
                  id={`tier-src-${j}`}
                  role="option"
                  aria-selected={subChecked(it)}
                  aria-disabled={it.disabled || undefined}
                  data-source-model={it.codexMode ? undefined : it.model}
                  data-codex-mode={it.codexMode}
                  data-setup={it.setup}
                  className={`tier-sub-option ${j === subActive ? "active" : ""} ${it.setup ? "needs" : ""} ${it.group ? "group" : ""}`}
                  onPointerEnter={() => setSubActive(it.disabled ? null : j)}
                  onClick={() => pick(it)}
                >
                  <span className="tier-sub-label">{it.label}</span>
                  {it.meta && <span className="meta">{it.meta}</span>}
                  <span className="tier-option-check">
                    {subChecked(it) && <IconCheck size={13} />}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
