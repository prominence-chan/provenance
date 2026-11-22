// "Run Codex through Provenance" goes through provenance-core: the second app-server keeps its
// own ChatGPT sign-in (codex-home.ts) but sends its model requests to the router's pass-through,
// which forwards them to OpenAI's Codex backend with our history pruning applied
// (provenance-core codex_sub.py):
//
//   provenance app-server -c model_provider="openai"
//     -c openai_base_url="<router>/codex-sub/<key>/backend-api/codex"
//     -c features.enable_request_compression=false
//
// The binary's Authorization header is its own (OpenAI's), so the router can't ask for its bearer
// token there: the key in the path stands in for it. It is derived from the router's token (a
// hash, so it never gives the token away and opens no other route), "open" for a router without
// one. Request compression is off so the router can read the body (it forwards an unreadable one
// unchanged). chatgpt_base_url is left alone on purpose: pointing it here too would let the
// binary's workspace routing send model requests straight to OpenAI again.

import { createHash } from "node:crypto";

export interface RouterRef {
  url: string;
  token?: string;
}

/** The pass-through's path key for a router (codex_sub.path_key). */
export function codexSubKey(token?: string): string {
  if (!token) return "open";
  return createHash("sha256").update(`provenance-codex-sub\0${token}`).digest("hex").slice(0, 32);
}

/** What openai_base_url is set to. */
export function codexSubBase(router: RouterRef): string {
  return `${router.url.replace(/\/$/, "")}/codex-sub/${codexSubKey(router.token)}/backend-api/codex`;
}

/** `provenance app-server` arguments for "through Provenance". */
export function codexPvArgs(router: RouterRef): string[] {
  return [
    "-c",
    'model_provider="openai"',
    "-c",
    `openai_base_url="${codexSubBase(router)}"`,
    "-c",
    "features.enable_request_compression=false",
  ];
}

/** Hides the key in a line app-server prints (an error message names the URL it failed on). */
export function maskCodexSubKey(line: string): string {
  return line.replace(/(\/codex-sub\/)[^/\s"'?]+/g, "$1***");
}

/**
 * Is the router's pass-through there and does it take our key? null when it does, else one line
 * for the page. Local only: nothing is forwarded to OpenAI.
 */
export async function checkCodexRoute(router: RouterRef): Promise<string | null> {
  const url = `${router.url.replace(/\/$/, "")}/codex-sub/${codexSubKey(router.token)}/_health`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return null;
    if (r.status === 404) return "Provenance's router is too old for this: update Provenance";
    if (r.status === 401) return "Provenance's router didn't accept the app's key";
    return `Provenance's router answered ${r.status}`;
  } catch {
    return "Provenance's router isn't running";
  }
}
