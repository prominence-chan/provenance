import { useId } from "react";

/**
 * The Provenance mark: the app icon's sun disc with a black terminal prompt ">_" on it, no
 * tile. Geometry comes from ui/design/icon/gen.py (32-unit grid, disc r 15); the glyph's
 * stroke thickens at small sizes so it still reads at 16 px. The disc's gradient is fixed
 * (the brand's sun, yellow to deep red) and holds on both themes. The only motion is a slow
 * glow breathe (styles.css, `.solar-mark`), off under prefers-reduced-motion.
 * public/favicon.svg is the static copy at the tab-sized stroke.
 */
export function SolarMark({ size = 20, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const stroke = size <= 18 ? 3.6 : size <= 26 ? 3.2 : 2.8;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={`solar-mark ${className ?? ""}`}
      aria-hidden
    >
      <defs>
        <linearGradient
          id={`${id}-disc`}
          x1="0"
          y1="1"
          x2="0"
          y2="31"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffe94a" />
          <stop offset="0.3" stopColor="#ffb000" />
          <stop offset="0.55" stopColor="#ff7a0a" />
          <stop offset="0.8" stopColor="#e2440e" />
          <stop offset="1" stopColor="#a8261a" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id}-disc)`} />
      <g
        fill="none"
        stroke="#140b08"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7.82 10.92 L11.07 15.82 L7.82 20.72" />
        <path d="M16.62 20.72 H24.18" />
      </g>
    </svg>
  );
}
