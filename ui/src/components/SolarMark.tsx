import { useId } from "react";

/**
 * The Provenance mark: a solid sun disc with a prominence arch and the limb's horizon cut
 * out of it as negative space. One silhouette, no hairlines, so it stays legible at 16px
 * (geometry sits on a 2-unit grid = whole pixels at 16px; cuts are 2px and 1px wide).
 * Colours come from theme vars so it follows the light theme. The only motion is a slow
 * glow breathe (styles.css, `.solar-mark`), off under prefers-reduced-motion.
 * index.html carries a static dark-theme copy as the favicon.
 */
export function SolarMark({ size = 20, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={`solar-mark ${className ?? ""}`}
      aria-hidden
    >
      <defs>
        <radialGradient id={`${id}-disc`} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="var(--corona)" />
          <stop offset="0.55" stopColor="var(--ember)" />
          <stop offset="1" stopColor="var(--crimson)" />
        </radialGradient>
        <mask id={`${id}-cut`}>
          <rect width="32" height="32" fill="#fff" />
          <path
            d="M10 23 C 10 9, 22 9, 22 23"
            fill="none"
            stroke="#000"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <rect y="22" width="32" height="2" fill="#000" />
        </mask>
      </defs>
      <circle cx="16" cy="16" r="14" fill={`url(#${id}-disc)`} mask={`url(#${id}-cut)`} />
    </svg>
  );
}
