import { tierOf, type TierId } from "../theme/tiers";

/**
 * Per-tier glyph, brighter as the tier rises: a coal (ember), a spark, a sun
 * (solstice), a starburst (nova). Colored via `color: var(--tier-<id>)`.
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
    case "ember":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4" fill="currentColor" opacity="0.9" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" opacity="0.25" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common}>
          <path d="M8 1.5l1.5 5 5 1.5-5 1.5-1.5 5-1.5-5-5-1.5 5-1.5z" fill="currentColor" />
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
          <circle cx="8" cy="8" r="2" fill="var(--fx-nova-core)" />
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

/** Small pill: glyph + model name, tinted by tier. Unknown models render neutral. */
export function TierBadge({ model, compact }: { model: string | null; compact?: boolean }) {
  if (!model) return null;
  const tier = tierOf(model);
  return (
    <span className={`tier-badge ${compact ? "compact" : ""}`} data-tier={tier?.id} title={model}>
      <TierGlyph tier={tier?.id ?? null} size={compact ? 10 : 11} />
      {!compact && <span className="tier-name">{model}</span>}
    </span>
  );
}
