import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { openSetup } from "../setup/open";
import { refreshSources, updateSettings } from "../store/actions";
import type { Source } from "../store/state";
import { useAppState } from "../store/store";
import { sortTiers, splitModel, tierOf } from "../theme/tiers";
import { IconCheck, IconChevron, IconChevronDown } from "./icons";
import { TierGlyph, useSourceLabel } from "./TierBadge";

/**
 * One row of a tier's source submenu: Auto (the plain tier), a pinnable source, or a source
 * that needs something first (API keys, a sign-in), which opens Models & accounts there.
 */
interface SubItem {
  key: string;
  /** What gets sent as the model: "solstice" (Auto) or "luna/solstice". */
  model: string;
  label: string;
  meta: string | null;
  disabled: boolean;
  /** Set up what it needs instead of choosing it. */
  setup?: "keys" | "signin";
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

/** Hover delay before another tier's submenu replaces the open one (lets the pointer cross rows). */
const SWITCH_DELAY_MS = 140;

/**
 * Model tier dropdown (opens upward from the composer). Hovering or arrowing onto a tier
 * opens its source submenu: Auto (provenance-core picks) or one pinned source.
 */
export function TierPicker() {
  const tiers = useAppState((s) => s.tiers);
  const sources = useAppState((s) => s.sources);
  const model = useAppState((s) => s.settings.model);
  const pinnedLabel = useSourceLabel(model);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Submenu shown for the active tier (after a hover or arrow key, not on open). */
  const [subOpen, setSubOpen] = useState(false);
  /** Highlighted submenu row; null while the keyboard is in the tier list. */
  const [subActive, setSubActive] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const switchTimer = useRef<number | undefined>(undefined);
  const list = sortTiers(tiers);
  const { tier: currentTier } = splitModel(model);
  const current = tierOf(model);
  const subItems = open && subOpen && list[active] ? subItemsFor(list[active], sources) : [];

  useEffect(() => {
    if (!open) return;
    void refreshSources();
    setActive(Math.max(0, list.indexOf(currentTier)));
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

  // Place the submenu beside its tier row, never lower than the menu's bottom edge (the
  // composer is below it); without room on the right it sits above the menu instead.
  useLayoutEffect(() => {
    const sub = subRef.current;
    const menu = menuRef.current;
    const row = rowRefs.current[active];
    if (!sub || !menu || !row) return;
    const roomRight = window.innerWidth - menu.getBoundingClientRect().right - 8;
    if (roomRight >= sub.offsetWidth + 4) {
      const top = Math.min(row.offsetTop - 5, menu.clientHeight - sub.offsetHeight + 1);
      sub.style.left = "";
      sub.style.top = `${top}px`;
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
    if (!it.setup) return choose(it.model);
    setOpen(false);
    openSetup(null, it.setup === "keys" ? "keys" : undefined);
  };

  /** Pointer on a tier row: switch at once, or after a beat when another submenu is open. */
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
      setActive((i) =>
        e.key === "ArrowDown" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1),
      );
      setSubOpen(true);
    } else if (e.key === "ArrowRight") {
      const items = subItemsFor(list[active] ?? "", sources);
      if (!items.length) return;
      setSubOpen(true);
      const sel = items.findIndex((it) => it.model === model);
      setSubActive(sel >= 0 ? sel : 0);
    } else if (e.key === "Enter" || e.key === " ") {
      if (list[active]) choose(list[active]);
    }
  };

  const activeId = !open
    ? undefined
    : subActive !== null
      ? `tier-src-${subActive}`
      : list[active] && `tier-opt-${list[active]}`;

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
        onClick={() => setOpen((o) => !o)}
      >
        <TierGlyph tier={current?.id ?? null} size={12} />
        <span className="tier-name">{pinnedLabel ? currentTier : model}</span>
        {pinnedLabel && <span className="tier-source">· {pinnedLabel}</span>}
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="tier-menu" role="listbox" aria-label="Model tier" ref={menuRef}>
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
                aria-selected={m === currentTier}
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
                  {m === currentTier && <IconCheck size={14} />}
                </span>
                {hasSub && (
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
              aria-label={`Source for ${list[active]}`}
              data-tier={tierOf(list[active])?.id}
              ref={subRef}
              onPointerEnter={() => window.clearTimeout(switchTimer.current)}
              onPointerLeave={() => setSubActive(null)}
            >
              {subItems.map((it, j) => (
                <div
                  key={it.key}
                  id={`tier-src-${j}`}
                  role="option"
                  aria-selected={!it.setup && it.model === model}
                  aria-disabled={it.disabled || undefined}
                  data-source-model={it.model}
                  data-setup={it.setup}
                  className={`tier-sub-option ${j === subActive ? "active" : ""} ${it.setup ? "needs" : ""}`}
                  onPointerEnter={() => setSubActive(it.disabled ? null : j)}
                  onClick={() => pick(it)}
                >
                  <span className="tier-sub-label">{it.label}</span>
                  {it.meta && <span className="meta">{it.meta}</span>}
                  <span className="tier-option-check">
                    {!it.setup && it.model === model && <IconCheck size={13} />}
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
