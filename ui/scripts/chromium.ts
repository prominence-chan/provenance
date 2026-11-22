// Which Chromium the headless checks run: Playwright's own if installed (`npx playwright
// install chromium`), else a cached headless shell in ~/Library/Caches/ms-playwright, or
// CHROMIUM_PATH. Never your Chrome. undefined = Playwright's default.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

export function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined; // Playwright's own
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse()) {
    const bin = path.join(cache, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}
