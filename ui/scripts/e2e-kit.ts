// Helpers the headless checks of Models & accounts share (setup-e2e.ts against the mock router,
// router-e2e.ts against a real one): checks that log, screenshots, the dialog's title and
// steps, and the layout rules every step must keep.

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

export const dialog = ".setup-dialog[open]";
export const welcomeDialog = ".welcome-dialog[open]";

export function kit(name: string, shots: string) {
  mkdirSync(shots, { recursive: true });
  const log = (...a: unknown[]) => console.log(`[${name}]`, ...a);
  let n = 0;
  return {
    log,
    shots,
    async shot(page: Page, what: string): Promise<void> {
      const file = path.join(shots, `${String(++n).padStart(2, "0")}-${what}.png`);
      await page.screenshot({ path: file });
      log(`  screenshot ${file}`);
    },
    check(cond: unknown, what: string): void {
      if (!cond) throw new Error(`expected: ${what}`);
      log(`  ok: ${what}`);
    },
  };
}

export const title = (page: Page) => page.locator(`${dialog} .setup-title`).innerText();
export const currentStep = (page: Page) =>
  page.locator(`${dialog} .setup-rail li.current`).innerText();

export async function waitTitle(page: Page, re: RegExp, timeout = 10_000): Promise<string> {
  await page.waitForFunction(
    ([src, flags]) => {
      const el = document.querySelector(".setup-dialog[open] .setup-title");
      return !!el && new RegExp(src, flags).test(el.textContent ?? "");
    },
    [re.source, re.flags] as const,
    { timeout },
  );
  return title(page);
}

export async function pickSite(page: Page, id: string): Promise<void> {
  await page.click(`${dialog} .setup-site[data-provider="${id}"]`);
  await page.waitForSelector(`${dialog} .setup-accounts`);
}

export function account(page: Page, id: string) {
  return page.locator(`${dialog} .setup-accounts li[data-account="${id}"]`);
}

/**
 * A first launch with nothing set up opens the welcome (src/fallback/WelcomeDialog.tsx): skip it
 * and open Models & accounts from the sidebar, where checks written before the welcome start.
 */
export async function skipWelcome(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForSelector(welcomeDialog, { timeout });
  await page.locator(welcomeDialog).getByRole("button", { name: "Close" }).click();
  await page.waitForSelector(welcomeDialog, { state: "detached" });
  await page.click('button[title="Models & accounts"]');
}

/** No sideways scroll inside the panel, and no button label wrapping to two lines. */
export async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = ":is(.setup-dialog, .welcome-dialog)[open]";
    const body = document.querySelector(`${sel} .setup-body`);
    if (body && body.scrollWidth > body.clientWidth + 1) out.push("body scrolls sideways");
    for (const b of document.querySelectorAll<HTMLElement>(`${sel} button`)) {
      const lh = parseFloat(getComputedStyle(b).lineHeight) || 16;
      if (
        b.offsetParent &&
        b.innerText.trim() &&
        b.scrollHeight > Math.max(b.clientHeight, lh * 1.6)
      )
        out.push(`button wraps: ${b.innerText}`);
    }
    return out;
  });
}
