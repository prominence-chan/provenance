// Renders the Discord Rich Presence images (electron/discord-presence.ts) into this folder:
//   provenance.png       1024 x 1024, the app icon full-bleed (Discord rounds the corners itself)
//   tier-<id>.png        512 x 512, each tier's glyph (TierBadge.tsx) in its colours (tokens.css)
//   fallback-<id>.png    512 x 512, the fallbacks' terminal glyph in their colours
// Discord crops the small image to a circle, so the glyphs sit on a dark disc.
//   cd ui && node design/presence/render.ts      (headless Chromium, scripts/chromium.ts)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { findChromium } from "../../scripts/chromium.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// Dark-theme stops of --tier-<id>-grad / --fallback-<id>-grad (src/theme/tokens.css).
const GRADS: Record<string, string[]> = {
  "tier-spark": ["#fff3c4", "#9cc8ff", "#4b84ff"],
  "tier-ember": ["#f09a6c", "#c9663f", "#8f3b22"],
  "tier-solstice": ["#ffc061", "#ff6a3d", "#e23a52"],
  "tier-nova": ["#ffe3f1", "#ff4fa3", "#c2185b", "#7a1fa2"],
  "fallback-claude": ["#e9e0ff", "#b794ff", "#7d55f0"],
  "fallback-codex": ["#dcfff9", "#45d3c7", "#129488"],
};
const GLOW: Record<string, string> = {
  "tier-spark": "#9cc8ff",
  "tier-ember": "#c9663f",
  "tier-solstice": "#ff6a3d",
  "tier-nova": "#ff4fa3",
  "fallback-claude": "#b794ff",
  "fallback-codex": "#45d3c7",
};

// TierBadge.tsx's glyphs (16-unit box) and icons.tsx's IconTerminal (24-unit box).
const G = "url(#g)";
const GLYPHS: Record<string, { box: number; body: string }> = {
  "tier-spark": {
    box: 16,
    body: `<path d="M8 3l1.1 3.9 3.9 1.1-3.9 1.1-1.1 3.9-1.1-3.9-3.9-1.1 3.9-1.1z" fill="${G}"/>`,
  },
  "tier-ember": {
    box: 16,
    body: `<circle cx="8" cy="8" r="4" fill="${G}"/><circle cx="8" cy="8" r="6" fill="none" stroke="${G}" stroke-width="0.9" opacity="0.4"/>`,
  },
  "tier-solstice": {
    box: 16,
    body: `<circle cx="8" cy="8" r="3.4" fill="${G}"/><g stroke="${G}" stroke-width="1.4" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g>`,
  },
  "tier-nova": {
    box: 16,
    body: `<path d="M8 0.5l1.3 4.6 4.1-2.5-2.5 4.1L15.5 8l-4.6 1.3 2.5 4.1-4.1-2.5L8 15.5l-1.3-4.6-4.1 2.5 2.5-4.1L0.5 8l4.6-1.3-2.5-4.1 4.1 2.5z" fill="${G}"/><circle cx="8" cy="8" r="2" fill="#fff1f7"/>`,
  },
  "fallback-claude": {
    box: 24,
    body: `<path d="M4 17l6-6-6-6M12 19h8" fill="none" stroke="${G}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};
GLYPHS["fallback-codex"] = GLYPHS["fallback-claude"];

function smallSvg(key: string): string {
  const { box, body } = GLYPHS[key];
  const stops = GRADS[key]
    .map((c, i, a) => `<stop offset="${i / (a.length - 1)}" stop-color="${c}"/>`)
    .join("");
  // Glyph box drawn at 66% of the disc, centred.
  const size = 512 * 0.66;
  const k = size / box;
  const off = (512 - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="256" cy="200" r="320" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1c161d"/><stop offset="1" stop-color="#08070a"/>
    </radialGradient>
    <radialGradient id="glow" cx="256" cy="256" r="230" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${GLOW[key]}" stop-opacity="0.28"/><stop offset="1" stop-color="${GLOW[key]}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="g" x1="0" y1="0" x2="${box}" y2="${box}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>
  </defs>
  <circle cx="256" cy="256" r="256" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="230" fill="url(#glow)"/>
  <g transform="translate(${off} ${off}) scale(${k})">${body}</g>
</svg>`;
}

const browser = await chromium.launch({ executablePath: findChromium() });
async function render(svg: string, size: number, out: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  await page.waitForFunction(() => document.querySelector("img")?.complete);
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
}

const touch = readFileSync(path.join(here, "../icon/provenance-icon-touch.svg"), "utf8");
await render(touch, 1024, path.join(here, "provenance.png"));
for (const key of Object.keys(GLYPHS))
  await render(smallSvg(key), 512, path.join(here, `${key}.png`));
await browser.close();
console.log(`wrote provenance.png and ${Object.keys(GLYPHS).length} small images to ${here}`);
