import { fallbackLabel, fallbackOf } from "../fallback/model";
import { useAppState } from "../store/store";
import { splitModel, tierOf, type TierId } from "../theme/tiers";
import { IconTerminal } from "./icons";

/**
 * Per-tier glyph, brighter as the tier rises: a small spark, a glowing coal (ember),
 * a sun (solstice), a starburst (nova). Colored via `color: var(--tier-<id>)`.
 */
export function TierGlyph({ tier, size = 12 }: { tier: TierId | null; size?: number }) {
  const common = {
    "width": size,
    "height": size,
    "viewBox": "0 0 16 16",
    "className": "tier-glyph",
    "aria-hidden": true,
  };
  switch (tier) {
    case "spark":
      return (
        <svg {...common}>
          <path
            d="M8 3l1.1 3.9 3.9 1.1-3.9 1.1-1.1 3.9-1.1-3.9-3.9-1.1 3.9-1.1z"
            fill="currentColor"
          />
        </svg>
      );
    case "ember":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4" fill="currentColor" opacity="0.9" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" opacity="0.25" />
        </svg>
      );
    case "solstice":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3.4" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" />
          </g>
        </svg>
      );
    case "nova":
      return (
        <svg {...common}>
          <path
            d="M8 0.5l1.3 4.6 4.1-2.5-2.5 4.1L15.5 8l-4.6 1.3 2.5 4.1-4.1-2.5L8 15.5l-1.3-4.6-4.1 2.5 2.5-4.1L0.5 8l4.6-1.3-2.5-4.1 4.1 2.5z"
            fill="currentColor"
          />
          <circle cx="8" cy="8" r="2" fill="var(--glint)" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3.5" fill="currentColor" opacity="0.6" />
        </svg>
      );
  }
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
