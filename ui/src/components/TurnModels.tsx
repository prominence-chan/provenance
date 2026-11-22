import { useLayoutEffect, useRef, useState } from "react";
import type { ModelUsage, TurnUsage } from "../store/state";
import { modelProvider, shortModelName } from "./modelName";

/** One model per short name, in ledger order (most requests first). */
function byShortName(models: ModelUsage[]): string[] {
  const seen = new Set<string>();
  for (const m of models) seen.add(shortModelName(m.model));
  return [...seen];
}

/**
 * The models that served a turn, in the turn footer next to the tier badge: one line,
 * names that don't fit become a "…" that opens the breakdown (requests and token share
 * per model). With one model, just its name.
 */
export function TurnModels({ usage }: { usage: TurnUsage }) {
  const names = byShortName(usage.models);
  const boxRef = useRef<HTMLSpanElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [fit, setFit] = useState(names.length);
  const multi = usage.models.length > 1;

  // Fit as many names as the footer has room for, measured from an invisible copy of all of
  // them (the visible list changes length, so it can't be its own ruler).
  useLayoutEffect(() => {
    const box = boxRef.current;
    const ghost = ghostRef.current;
    const footer = box?.parentElement;
    if (!box || !ghost || !footer) return;
    const measure = () => {
      const others = [...footer.children]
        .filter((c) => c !== box)
        .reduce((w, c) => w + (c as HTMLElement).offsetWidth, 0);
      const gap = parseFloat(getComputedStyle(footer).columnGap) || 0;
      const room = footer.clientWidth - others - gap * (footer.children.length - 1);
      const parts = [...ghost.children] as HTMLElement[];
      const more = parts.pop()!.offsetWidth; // the "…" button
      let n = 0;
      let used = 0;
      for (const p of parts) {
        const w = p.offsetWidth;
        const rest = n + 1 < parts.length ? more : 0;
        if (used + w + rest > room) break;
        used += w;
        n++;
      }
      setFit(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [names.join("\n")]);

  if (!names.length) return null;
  const shown = names.slice(0, fit);
  const truncated = fit < names.length;
  const open = () => dialogRef.current?.showModal();

  return (
    <span className="turn-models" ref={boxRef}>
      <span className="turn-models-ghost" ref={ghostRef} aria-hidden>
        {names.map((n, i) => (
          <span key={n}>
            {i ? ", " : ""}
            {n}
          </span>
        ))}
        <span className="turn-models-more">…</span>
      </span>
      {multi ? (
        <button
          type="button"
          className="turn-models-list"
          onClick={open}
          title={`${usage.models.length} models served this turn`}
          aria-haspopup="dialog"
        >
          {shown.join(", ")}
          {truncated && <span className="turn-models-more">…</span>}
        </button>
      ) : (
        <span className="turn-models-list" title={usage.models[0].model}>
          {shown[0]}
        </span>
      )}
      {multi && <UsageDialog ref={dialogRef} usage={usage} />}
    </span>
  );
}

function UsageDialog({
  usage,
  ref,
}: {
  usage: TurnUsage;
  ref: React.RefObject<HTMLDialogElement | null>;
}) {
  const tokens = (m: ModelUsage) => m.input_tokens + m.output_tokens;
  const totalTokens = usage.models.reduce((s, m) => s + tokens(m), 0);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      className="usage-dialog"
      aria-labelledby="usage-dialog-title"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="usage-panel">
        <div className="usage-head">
          <h2 id="usage-dialog-title">Models this turn</h2>
          <span className="usage-total">
            {usage.requests} request{usage.requests === 1 ? "" : "s"}
            {totalTokens > 0 && ` · ${formatTokens(totalTokens)} tokens`}
          </span>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="num">
                Requests
              </th>
              {totalTokens > 0 && (
                <th scope="col" className="num">
                  Tokens
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {usage.models.map((m) => {
              const reqShare = usage.requests ? m.requests / usage.requests : 0;
              const tokShare = totalTokens ? tokens(m) / totalTokens : 0;
              return (
                <tr key={m.model} data-tier={m.tier ?? undefined}>
                  <th scope="row">
                    <span className="usage-name">{shortModelName(m.model)}</span>
                    <span className="usage-id" title={m.model}>
                      {modelProvider(m.model) ? `${modelProvider(m.model)} · ` : ""}
                      {m.model.slice(m.model.indexOf("/") + 1)}
                    </span>
                    <span className="usage-bar" aria-hidden>
                      <span style={{ width: `${Math.max(2, reqShare * 100)}%` }} />
                    </span>
                  </th>
                  <td className="num">
                    {m.requests} <span className="usage-pct">{pct(reqShare)}</span>
                  </td>
                  {totalTokens > 0 && (
                    <td className="num">
                      {formatTokens(tokens(m))} <span className="usage-pct">{pct(tokShare)}</span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="usage-foot">
          <button type="button" className="btn-small" onClick={close} autoFocus>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
