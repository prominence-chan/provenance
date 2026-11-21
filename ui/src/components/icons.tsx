// Tiny inline SVG icon set (stroke icons, inherit currentColor).
type P = { size?: number };
const base = (size = 16) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconPlus = ({ size }: P) => (
  <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconArrowUp = ({ size }: P) => (
  <svg {...base(size)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const IconStop = ({ size }: P) => (
  <svg {...base(size)}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
);
export const IconTerminal = ({ size }: P) => (
  <svg {...base(size)}><path d="M4 17l6-6-6-6M12 19h8" /></svg>
);
export const IconFile = ({ size }: P) => (
  <svg {...base(size)}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
);
export const IconChevron = ({ size }: P) => (
  <svg {...base(size)}><path d="M9 18l6-6-6-6" /></svg>
);
export const IconFolder = ({ size }: P) => (
  <svg {...base(size)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
export const IconArchive = ({ size }: P) => (
  <svg {...base(size)}><path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" /></svg>
);
export const IconRefresh = ({ size }: P) => (
  <svg {...base(size)}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>
);
export const IconShield = ({ size }: P) => (
  <svg {...base(size)}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>
);
export const IconTool = ({ size }: P) => (
  <svg {...base(size)}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" /></svg>
);
