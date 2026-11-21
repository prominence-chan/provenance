import { useId } from "react";

/** The Provenance mark: a sun's limb with a prominence loop arcing off it. */
export function SolarMark({ size = 20, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`solar-mark ${className ?? ""}`}
      aria-hidden
    >
      <defs>
        <radialGradient id={`${id}-disc`} cx="42%" cy="40%" r="62%">
          <stop offset="0%" stopColor="var(--fx-nova-core)" />
          <stop offset="35%" stopColor="var(--corona)" />
          <stop offset="75%" stopColor="var(--ember)" />
          <stop offset="100%" stopColor="var(--crimson)" />
        </radialGradient>
        <linearGradient id={`${id}-loop`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--ember)" />
          <stop offset="55%" stopColor="var(--magenta)" />
          <stop offset="100%" stopColor="var(--crimson)" />
        </linearGradient>
      </defs>
      <circle cx="17" cy="23" r="13" fill={`url(#${id}-disc)`} />
      <path
        d="M24.5 13.2 C 25 5, 35.5 3.5, 36 11 C 36.4 16.5, 31.5 19.5, 29.2 17.8"
        fill="none"
        stroke={`url(#${id}-loop)`}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M27.6 15.4 C 29 10.5, 33.2 10.6, 33 13.4"
        fill="none"
        stroke="var(--magenta)"
        strokeOpacity="0.55"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
