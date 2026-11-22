import { useId } from "react";

/**
 * The Provenance mark: the limb of a sun with a prominence arching off it, its far foot
 * lifting as it erupts. Animated in CSS
 * (styles.css, `.solar-mark`): the glow under the arch breathes, plasma flows along the arch
 * and a fainter inner loop rises and settles, each on its own period so it never looks
 * looped. Static under prefers-reduced-motion.
 */
export function SolarMark({ size = 20, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const arch = "M9.5 27.2 C 9 9, 27 1.5, 33 23.5";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`solar-mark ${className ?? ""}`}
      aria-hidden
    >
      <defs>
        <radialGradient id={`${id}-limb`} cx="48%" cy="0%" r="95%">
          <stop offset="0%" stopColor="var(--glint)" />
          <stop offset="18%" stopColor="var(--corona)" />
          <stop offset="50%" stopColor="var(--ember)" />
          <stop offset="100%" stopColor="var(--crimson)" />
        </radialGradient>
        <radialGradient id={`${id}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--ember)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--ember)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-arch`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--corona)" />
          <stop offset="50%" stopColor="var(--magenta)" />
          <stop offset="100%" stopColor="var(--ember)" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx="20" cy="20" r="19.5" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <ellipse className="sm-halo" cx="20" cy="22" rx="17" ry="14" fill={`url(#${id}-halo)`} />
        <path
          className="sm-loop2"
          d="M16 26.2 C 16 15.5, 25.5 11.5, 27.5 25.4"
          fill="none"
          stroke="var(--magenta)"
          strokeOpacity="0.35"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d={arch}
          fill="none"
          stroke={`url(#${id}-arch)`}
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <path
          className="sm-flow"
          d={arch}
          fill="none"
          stroke="var(--glint)"
          strokeOpacity="0.8"
          strokeWidth="1.1"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="16 84"
          strokeDashoffset={-30}
        />
        <circle cx="20" cy="58" r="33" fill={`url(#${id}-limb)`} />
      </g>
    </svg>
  );
}
