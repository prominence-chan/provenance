// Discord Rich Presence for the desktop app, spoken directly over Discord's local RPC socket
// (no dependency): frames of [op u32 LE][length u32 LE][JSON], op 0 handshake {v: 1, client_id},
// then op 1 frames (Discord answers the handshake with a READY dispatch; SET_ACTIVITY sets or,
// without an activity, clears). The socket is <dir>/discord-ipc-<0..9>, <dir> the first of
// XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP (else /tmp); \\?\pipe\discord-ipc-<n> on Windows.
//
// What it shows is only coarse: the selected tier or fallback, working or idle, and how long a
// turn has run. Never a thread title, prompt, file, folder, project, model output or account:
// the page sends just those values (sanitizePresence keeps nothing else), and buildActivity
// makes every string from the constants below.
//
// Off, silently, while no client id is configured (PRESENCE.clientId, or discordClientId in
// settings.json). Lazy: nothing connects until there is something to show. Discord not running:
// a quiet retry with backoff (5 s doubling to 60 s), so starting or restarting Discord is picked
// up. At most one activity update per 15 s (the latest state wins); a clear goes out at once.
//
// No Electron import, so scripts/presence-check.ts runs it on plain Node against a stand-in socket.

import { createConnection, type Socket } from "node:net";
import path from "node:path";

// ---- what the presence says (edit here) ------------------------------------------------------

const REPO_URL = "https://github.com/prominence-chan/provenance";

export const PRESENCE = {
  /**
   * The Discord application's id (developer portal -> the "Provenance" application -> General
   * Information -> Application ID). Empty: presence stays off. settings.json `discordClientId`
   * overrides it.
   */
  clientId: "",
  /** The state line, under the tier. */
  credit: "by SkyeNXT · coming soon",
  /** Hover text of the app icon. */
  largeText: "Provenance · made by Yufan at SkyeNXT",
  /** Clicking the app icon (newer Discord clients) opens this. */
  largeUrl: REPO_URL,
  /** Up to two; Discord shows them to everyone but you. Label 1-32 chars, https URL. */
  buttons: [{ label: "Provenance on GitHub", url: REPO_URL }],
  /**
   * Where the images come from: `${imageBase}/<key>.png`, an https URL Discord fetches itself, so
   * no art assets need uploading (ui/design/presence/ in the public repo). Set it to "" to use
   * art assets uploaded to the application under the same keys instead.
   */
  imageBase:
    "https://raw.githubusercontent.com/prominence-chan/provenance/provenance/ui/design/presence",
};

/** Tier / fallback -> its name on the first line, its image key and the image's hover text. */
const KINDS = {
  spark: { name: "Spark", image: "tier-spark", hover: "Spark tier · fast and small" },
  ember: { name: "Ember", image: "tier-ember", hover: "Ember tier · strong mid" },
  solstice: { name: "Solstice", image: "tier-solstice", hover: "Solstice tier · frontier" },
  nova: { name: "Nova", image: "tier-nova", hover: "Nova tier · hyperfrontier" },
  claude: { name: "Claude Code", image: "fallback-claude", hover: "Claude Code fallback" },
  codex: { name: "Codex", image: "fallback-codex", hover: "Codex fallback" },
} as const;
const LARGE_IMAGE = "provenance";

export type PresenceKind = keyof typeof KINDS;

/** The only thing the page tells the main process. */
export interface PresenceState {
  /** Selected tier or fallback; null when it is neither (a custom model). */
  kind: PresenceKind | null;
  working: boolean;
  /** When the running turn started (ms since epoch); null when idle or unknown. */
  since: number | null;
}

/** Keeps only the known coarse values of whatever the page sent; everything else is dropped. */
export function sanitizePresence(raw: unknown): PresenceState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind =
    typeof r.kind === "string" && Object.hasOwn(KINDS, r.kind) ? (r.kind as PresenceKind) : null;
  const working = r.working === true;
  const now = Date.now();
  const since =
    working &&
    typeof r.since === "number" &&
    Number.isFinite(r.since) &&
    r.since > now - 7 * 864e5 &&
    r.since <= now + 60e3
      ? Math.floor(r.since)
      : null;
  return { kind, working, since };
}

function image(key: string): string {
  return PRESENCE.imageBase ? `${PRESENCE.imageBase}/${key}.png` : key;
}

/** The activity for a state (lean: without the fields older Discord clients reject). */
export function buildActivity(s: PresenceState, lean = false): Record<string, unknown> {
  const k = s.kind ? KINDS[s.kind] : null;
  const verb = s.working ? "Working" : "Idle";
  const assets: Record<string, string> = {
    large_image: image(LARGE_IMAGE),
    large_text: PRESENCE.largeText,
  };
  if (!lean && PRESENCE.largeUrl) assets.large_url = PRESENCE.largeUrl;
  if (k) {
    assets.small_image = image(k.image);
    assets.small_text = k.hover;
  }
  const a: Record<string, unknown> = {
    type: 0,
    details: k ? `${verb} · ${k.name}` : verb,
    state: PRESENCE.credit,
    assets,
    instance: false,
  };
  if (s.working && s.since) a.timestamps = { start: s.since };
  const buttons = PRESENCE.buttons
    .filter((b) => b.label && /^https:\/\//.test(b.url))
    .slice(0, 2)
    .map((b) => ({ label: b.label.slice(0, 32), url: b.url }));
  if (buttons.length) a.buttons = buttons;
  return a;
}

// ---- the socket ------------------------------------------------------------------------------

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** Where Discord's socket may be, in the order Discord's own SDK looks. */
export function socketPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string[] {
  const out: string[] = [];
  if (platform === "win32") {
    for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return out;
  }
  const dir = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  const dirs = [dir];
  // Linux Flatpak / Snap builds put it one level down.
  if (platform === "linux")
    dirs.push(path.join(dir, "app/com.discordapp.Discord"), path.join(dir, "snap.discord"));
  for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function connectFirst(paths: string[], timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= paths.length) return resolve(null);
      const sock = createConnection(paths[i++]);
      const timer = setTimeout(() => sock.destroy(new Error("timeout")), timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.removeAllListeners("error");
        resolve(sock);
      });
      sock.once("error", () => {
        clearTimeout(timer);
        sock.destroy();
        next();
      });
    };
    next();
  });
}

// ---- the controller --------------------------------------------------------------------------

export interface PresenceOptions {
  clientId: string;
  enabled: boolean;
  /** Minimum gap between activity updates (Discord allows about one per 15 s). */
  minIntervalMs?: number;
  /** First retry after a failed connect; doubles up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

type Phase = "idle" | "connecting" | "handshake" | "ready";

/**
 * Keeps Discord's activity in step with the latest PresenceState, as far as the rate limit
 * allows. All methods are fire-and-forget and never throw; shutdown() is awaitable for quit.
 */
export class DiscordPresence {
  private clientId: string;
  private enabled: boolean;
  private readonly minInterval: number;
  private readonly backoffStart: number;
  private readonly backoffMax: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;

  private phase: Phase = "idle";
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private state: PresenceState | null = null;
  /** JSON of what Discord shows now ("" = nothing, null = unknown: a fresh connection). */
  private shown: string | null = null;
  private lastSend = 0;
  private sendTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private backoff: number;
  private lean = false;
  private nonce = 0;
  private stopped = false;
  /** Bumped by every connect and disconnect, so a connect that finishes late is dropped. */
  private gen = 0;
  /** A client id Discord refused: wait for another one rather than retrying it. */
  private rejectedId = "";
  private pending = new Map<string, (ok: boolean, err?: string) => void>();
  /** Counters for the check script. */
  readonly stats = { attempts: 0, connects: 0, sets: 0, clears: 0 };

  constructor(o: PresenceOptions) {
    this.clientId = o.clientId.trim();
    this.enabled = o.enabled;
    this.minInterval = o.minIntervalMs ?? 15_000;
    this.backoffStart = o.backoffMs ?? 5_000;
    this.backoffMax = o.maxBackoffMs ?? 60_000;
    this.backoff = this.backoffStart;
    this.env = o.env ?? process.env;
    this.log = o.log ?? (() => {});
  }

  /** On, and with an id Discord hasn't refused. */
  get active(): boolean {
    return (
      !this.stopped &&
      this.enabled &&
      /^\d{5,32}$/.test(this.clientId) &&
      this.clientId !== this.rejectedId
    );
  }

  /** The id and the switch (settings.json / the menu). Off clears the activity at once. */
  configure(clientId: string, enabled: boolean): void {
    const id = clientId.trim();
    const idChanged = id !== this.clientId;
    this.clientId = id;
    this.enabled = enabled;
    if (idChanged) {
      this.rejectedId = "";
      this.disconnect(); // the handshake names the id
    }
    if (!this.active) {
      // Clear, then let go of the socket (Discord also drops a closed client's activity).
      void this.clearNow(400).then(() => {
        if (!this.active) this.disconnect();
      });
      return;
    }
    this.kick();
  }

  update(s: PresenceState): void {
    this.state = s;
    if (this.active) this.kick();
  }

  /** Quit: clear the activity (briefly waiting for Discord to take it) and close the socket. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    await this.clearNow(400);
    this.stopped = true;
    this.disconnect();
  }

  // ---- internals ---------------------------------------------------------------------------

  /** Connect if needed, else schedule the next update. */
  private kick(): void {
    if (!this.active || !this.state) return;
    if (this.phase === "idle") {
      if (!this.retryTimer) void this.connect();
      return;
    }
    if (this.phase === "ready") this.schedule();
  }

  private schedule(): void {
    if (this.sendTimer || !this.state || this.phase !== "ready") return;
    const want = JSON.stringify(this.state);
    if (want === this.shown) return;
    const wait = Math.max(0, this.lastSend + this.minInterval - Date.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      this.flush();
    }, wait);
    this.sendTimer.unref?.();
  }

  private flush(): void {
    if (!this.active || !this.state || this.phase !== "ready") return;
    const s = this.state;
    const want = JSON.stringify(s);
    if (want === this.shown) return;
    this.lastSend = Date.now();
    this.shown = want;
    this.stats.sets++;
    const lean = this.lean;
    void this.command("SET_ACTIVITY", { pid: process.pid, activity: buildActivity(s, lean) }).then(
      (r) => {
        if (r.ok || lean) {
          if (!r.ok) this.log(`discord presence: activity refused (${r.err ?? "error"})`);
          return;
        }
        // An older client that doesn't know large_url: the same without it, once per connection.
        this.lean = true;
        this.shown = null;
        this.lastSend = 0;
        this.schedule();
      },
    );
  }

  /** Clears the activity now, if anything may be showing. */
  private async clearNow(waitMs = 0): Promise<void> {
    clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    if (this.phase !== "ready" || this.shown === "") return;
    this.shown = "";
    this.lastSend = Date.now();
    this.stats.clears++;
    const done = this.command("SET_ACTIVITY", { pid: process.pid });
    if (waitMs) await Promise.race([done, new Promise((r) => setTimeout(r, waitMs))]);
  }

  private command(
    cmd: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; err?: string }> {
    const sock = this.sock;
    if (!sock || this.phase !== "ready") return Promise.resolve({ ok: false });
    const nonce = `${process.pid}-${++this.nonce}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(nonce);
        resolve({ ok: false, err: "timeout" });
      }, 5000);
      t.unref?.();
      this.pending.set(nonce, (ok, err) => {
        clearTimeout(t);
        resolve({ ok, err });
      });
      try {
        sock.write(encode(OP_FRAME, { cmd, args, nonce }));
      } catch {
        this.pending.delete(nonce);
        clearTimeout(t);
        resolve({ ok: false });
      }
    });
  }

  private async connect(): Promise<void> {
    const gen = ++this.gen;
    this.phase = "connecting";
    this.stats.attempts++;
    const sock = await connectFirst(socketPaths(this.env), 1500);
    if (gen !== this.gen) {
      sock?.destroy(); // disconnected (or reconfigured) meanwhile
      return;
    }
    if (!sock) {
      this.phase = "idle";
      this.retryLater();
      return;
    }
    if (!this.active) {
      sock.destroy();
      this.phase = "idle";
      return;
    }
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.phase = "handshake";
    this.shown = null;
    this.lean = false;
    sock.on("data", (d: Buffer) => this.onData(sock, d));
    sock.on("error", () => {});
    sock.on("close", () => this.onClose(sock));
    // Discord answers with READY, or closes when the id is wrong; don't wait forever.
    const hs = setTimeout(() => {
      if (this.sock === sock && this.phase === "handshake") sock.destroy();
    }, 10_000);
    hs.unref?.();
    sock.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
  }

  private retryLater(): void {
    if (this.retryTimer || !this.active) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.backoffMax);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.active && this.phase === "idle" && this.state) void this.connect();
    }, wait);
    this.retryTimer.unref?.();
  }

  private onData(sock: Socket, d: Buffer): void {
    if (this.sock !== sock) return;
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (len > 1 << 20) return void sock.destroy(); // not Discord
      if (this.buf.length < 8 + len) return;
      const body = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      let msg: Record<string, unknown> = {};
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        // ignore
      }
      this.onFrame(sock, op, msg, body);
    }
  }

  private onFrame(sock: Socket, op: number, msg: Record<string, unknown>, raw: Buffer): void {
    if (op === OP_PING) {
      const pong = Buffer.alloc(8);
      pong.writeUInt32LE(OP_PONG, 0);
      pong.writeUInt32LE(raw.length, 4);
      sock.write(Buffer.concat([pong, raw]));
      return;
    }
    if (op === OP_CLOSE) {
      // 4000: invalid client id. Don't keep knocking with it.
      const code = Number(msg.code);
      if (code === 4000 || /client id/i.test(String(msg.message ?? ""))) {
        this.rejectedId = this.clientId;
        this.log("discord presence: Discord refused the client id; presence stays off");
      }
      sock.destroy();
      return;
    }
    if (op !== OP_FRAME) return;
    // READY carries the Discord user: read nothing from it, log nothing of it.
    if (msg.cmd === "DISPATCH" && msg.evt === "READY") {
      this.phase = "ready";
      this.backoff = this.backoffStart;
      this.stats.connects++;
      this.log("discord presence: connected");
      this.lastSend = 0;
      this.schedule();
      return;
    }
    const nonce = typeof msg.nonce === "string" ? msg.nonce : null;
    const done = nonce ? this.pending.get(nonce) : undefined;
    if (!done || !nonce) return;
    this.pending.delete(nonce);
    if (msg.evt === "ERROR") {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      done(false, String(data.message ?? "error").slice(0, 200));
    } else done(true);
  }

  private onClose(sock: Socket): void {
    if (this.sock !== sock) return;
    this.sock = null;
    this.phase = "idle";
    this.shown = null;
    clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    for (const done of this.pending.values()) done(false, "closed");
    this.pending.clear();
    // Discord quit or restarted: come back quietly when it does.
    if (this.active && this.state) this.retryLater();
  }

  private disconnect(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    const sock = this.sock;
    this.sock = null;
    this.gen++;
    this.phase = "idle";
    this.shown = null;
    this.backoff = this.backoffStart;
    for (const done of this.pending.values()) done(false, "closed");
    this.pending.clear();
    if (sock) {
      try {
        sock.end(encode(OP_CLOSE, {}));
      } catch {
        // ignore
      }
      setTimeout(() => sock.destroy(), 500).unref?.();
    }
  }
}
