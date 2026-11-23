import { DETAIL_FROM, TIER_GLYPHS } from "../../shared/tier-glyphs";
import { fallbackLabel, fallbackOf } from "../fallback/model";
import { useAppState } from "../store/store";
import { splitModel, tierOf, type TierId } from "../theme/tiers";
import { IconTerminal } from "./icons";

/**
 * Per-tier glyph, more points and reach as the tier rises: a spark, a glowing coal (ember),
 * the sun (solstice), a stellar burst (nova); drawn in shared/tier-glyphs.ts. From DETAIL_FROM
 * px up it adds a white-hot core. Colored via `color: var(--tier-<id>)`.
 */
export function TierGlyph({ tier, size = 12 }: { tier: TierId | null; size?: number }) {
  const g = tier ? TIER_GLYPHS[tier] : null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="tier-glyph"
      data-glyph={g ? tier : undefined}
      aria-hidden
    >
      {g ? (
        <>
          <path
            d={g.body}
            fill="currentColor"
            stroke={g.soften ? "currentColor" : undefined}
            strokeWidth={g.soften || undefined}
            strokeLinejoin="round"
          />
          {g.rays && (
            <path
              d={g.rays}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            />
          )}
          {size >= DETAIL_FROM && (
            <path
              d={g.core}
              className="tier-glyph-core"
              strokeWidth={g.coreSoften || 0}
              strokeLinejoin="round"
            />
          )}
        </>
      ) : (
        <circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.6" />
      )}
    </svg>
  );
}

/**
 * The pinned source's label for a model like "luna/solstice" ("GPT-6 Luna", or "luna" until
 * the router has listed its sources); null for a plain tier.
 */
export function useSourceLabel(model: string | null | undefined): string | null {
  return useAppState((s) => {
    if (!model) return null;
    const { tier, source } = splitModel(model);
    if (!source) return null;
    return s.sources[tier]?.find((x) => x.model === model)?.label ?? source;
  });
}

/**
 * Small pill: glyph + tier name (+ pinned source), tinted by tier; a fallback's terminal glyph and
 * name, tinted by its own colour. Unknown models render neutral.
 */
export function TierBadge({ model, compact }: { model: string | null; compact?: boolean }) {
  const source = useSourceLabel(model);
  const info = useAppState((s) => s.fallbackInfo);
  if (!model) return null;
  const fb = fallbackLabel(model, info);
  if (fb)
    return (
      <span
        className={`tier-badge ${compact ? "compact" : ""}`}
        data-fallback={fallbackOf(model) ?? undefined}
        title={`${fb.name} · ${fb.model}`}
      >
        <IconTerminal size={compact ? 10 : 11} />
        {!compact && (
          <span className="tier-name">
            {fb.name}
            <span className="tier-source"> · {fb.model}</span>
          </span>
        )}
      </span>
    );
  const tier = tierOf(model);
  return (
    <span
      className={`tier-badge ${compact ? "compact" : ""}`}
      data-tier={tier?.id}
      title={source ? `${tier?.id ?? model} via ${source}` : model}
    >
      <TierGlyph tier={tier?.id ?? null} size={compact ? 10 : 11} />
      {!compact && (
        <span className="tier-name">
          {source ? splitModel(model).tier : model}
          {source && <span className="tier-source"> · {source}</span>}
        </span>
      )}
    </span>
  );
}
