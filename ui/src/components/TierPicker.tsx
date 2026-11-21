import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { updateSettings } from "../store/actions";
import { useAppState } from "../store/store";
import { sortTiers, tierOf } from "../theme/tiers";
import { IconCheck, IconChevronDown } from "./icons";
import { TierGlyph } from "./TierBadge";

/** Model tier dropdown (opens upward from the composer). */
export function TierPicker() {
  const tiers = useAppState((s) => s.tiers);
  const model = useAppState((s) => s.settings.model);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const list = sortTiers(tiers);
  const current = tierOf(model);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, list.indexOf(model)));
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (m: string) => {
    updateSettings({ model: m });
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (list[active]) choose(list[active]);
    }
  };

  return (
    <div className="tier-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className={`picker tier-picker-btn ${open ? "open" : ""}`}
        title="Model tier"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tier={current?.id}
        onClick={() => setOpen((o) => !o)}
      >
        <TierGlyph tier={current?.id ?? null} size={12} />
        <span className="tier-name">{model}</span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="tier-menu" role="listbox" aria-label="Model tier">
          {list.map((m, i) => {
            const t = tierOf(m);
            return (
              <div
                key={m}
                role="option"
                aria-selected={m === model}
                data-tier={t?.id}
                data-model={m}
                className={`tier-option ${i === active ? "active" : ""}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(m)}
              >
                <span className="tier-option-glyph">
                  <TierGlyph tier={t?.id ?? null} size={14} />
                </span>
                <span className="tier-option-text">
                  <span className="tier-option-name">{m}</span>
                  {t && <span className="tier-option-blurb">{t.blurb}</span>}
                </span>
                {t && <RankPips rank={t.rank} />}
                <span className="tier-option-check">{m === model && <IconCheck size={14} />}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RankPips({ rank }: { rank: number }) {
  return (
    <span className="rank-pips" aria-label={`rank ${rank} of 4`}>
      {[1, 2, 3, 4].map((n) => (
        <span key={n} className={n <= rank ? "on" : ""} />
      ))}
    </span>
  );
}
