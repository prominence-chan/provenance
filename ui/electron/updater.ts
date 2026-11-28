// Built-in self-updater for Provenance across macOS (ad-hoc signed), Windows (NSIS), and Linux
// (AppImage / deb). Uses GitHub Releases + SHA256SUMS.txt verification with zero extra runtime
// dependencies so ad-hoc signed macOS builds update cleanly without Squirrel.Mac.
//
// No Electron imports in this module: main.ts injects quit/open callbacks, and scripts/updater-check.ts
// exercises all pure helpers and mock-HTTP download/verification flows directly under Node.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  CliSyncStatus,
  UpdateInstallMode,
  UpdateReleaseInfo,
  UpdateState,
} from "../shared/updater-api.ts";

export const DEFAULT_RELEASES_API =
  "https://api.github.com/repos/prominence-chan/provenance/releases/latest";

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
}

// ---- pure semver & checksum helpers -----------------------------------------

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: (number | string)[];
}

export function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw
    .trim()
    .replace(/^provenance-app-v/i, "")
    .replace(/^v/i, "");
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(cleaned);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [];
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Invalid versions compare as 0. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y ? 1 : -1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** Parse standard sha256sum / shasum output into lowercase filename -> 64-hex hash. */
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    const file = path.posix.basename(m[2].trim().replace(/\\/g, "/"));
    if (file) map.set(file, hash);
  }
  return map;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("error", reject);
    s.on("end", () => resolve());
  });
  return hash.digest("hex").toLowerCase();
}

export interface AssetPick {
  asset: GitHubAsset | null;
  installMode: UpdateInstallMode;
}

/** Pick the best downloadable asset and install strategy for this platform + arch. */
export function selectReleaseAsset(
  assets: GitHubAsset[],
  opts: {
    platform: string;
    arch: string;
    appImagePath?: string;
  },
): AssetPick {
  const byRe = (re: RegExp, exclude?: RegExp) =>
    assets.find((a) => re.test(a.name) && (!exclude || !exclude.test(a.name))) ?? null;

  if (opts.platform === "darwin") {
    if (opts.arch === "arm64") {
      const zip = byRe(/arm64.*mac\.zip$/i) ?? byRe(/arm64.*\.zip$/i);
      if (zip) return { asset: zip, installMode: "replace-mac-app" };
      const dmg = byRe(/arm64.*\.dmg$/i);
      return { asset: dmg, installMode: "manual" };
    }
    const zip = byRe(/(x64.*mac|mac)\.zip$/i, /arm64/i) ?? byRe(/\.zip$/i, /(arm64|win|linux)/i);
    if (zip) return { asset: zip, installMode: "replace-mac-app" };
    const dmg = byRe(/\.dmg$/i, /arm64/i);
    return { asset: dmg, installMode: "manual" };
  }

  if (opts.platform === "win32") {
    const setup = byRe(/-setup\.exe$/i) ?? byRe(/\.exe$/i);
    if (setup) return { asset: setup, installMode: "nsis-installer" };
    const zip = byRe(/x64\.zip$/i, /mac/i);
    return { asset: zip, installMode: "manual" };
  }

  if (opts.platform === "linux") {
    if (opts.appImagePath) {
      const appImage = byRe(/\.AppImage$/i);
      if (appImage) return { asset: appImage, installMode: "replace-appimage" };
    }
    const deb = byRe(/\.deb$/i);
    if (deb) return { asset: deb, installMode: "deb-package" };
    const appImage = byRe(/\.AppImage$/i);
    if (appImage) return { asset: appImage, installMode: "manual" };
  }

  return { asset: null, installMode: "manual" };
}

/** Walk up from an executable inside a macOS .app bundle to the .app root. */
export function findMacAppBundle(exePath: string): string | null {
  let cur = path.resolve(exePath);
  for (let i = 0; i < 8; i++) {
    if (cur.endsWith(".app")) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function standaloneCliPath(opts: {
  platform: string;
  homeDir: string;
  localAppData?: string;
}): string {
  if (opts.platform === "win32") {
    return path.join(opts.localAppData ?? opts.homeDir, "Provenance", "bin", "provenance.exe");
  }
  return path.join(opts.homeDir, ".local", "bin", "provenance");
}

/**
 * Sync the user's standalone CLI binary (`~/.local/bin/provenance` or `%LOCALAPPDATA%\Provenance\bin\provenance.exe`)
 * from the app's bundled `Resources/agent/` copy, if the standalone CLI already exists.
 *
 * When `onlyIfNewer` is true (used at launch), only overwrites if the bundled copy's mtime is newer
 * than the standalone binary so a developer's freshly-compiled local binary is never clobbered.
 */
export async function syncStandaloneCli(opts: {
  bundledAgentDir: string;
  platform: string;
  homeDir: string;
  localAppData?: string;
  onlyIfNewer?: boolean;
}): Promise<CliSyncStatus> {
  const isWin = opts.platform === "win32";
  const binName = isWin ? "provenance.exe" : "provenance";
  const helperName = isWin ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const targetBin = standaloneCliPath(opts);
  if (!existsSync(targetBin)) {
    return { synced: false, path: null };
  }
  const sourceBin = path.join(opts.bundledAgentDir, binName);
  if (!existsSync(sourceBin)) {
    return { synced: false, path: targetBin, error: "Bundled agent binary not found" };
  }
  try {
    const [srcHash, dstHash] = await Promise.all([sha256File(sourceBin), sha256File(targetBin)]);
    if (srcHash === dstHash) {
      return { synced: true, path: targetBin, updated: false };
    }
    if (opts.onlyIfNewer) {
      const srcMtime = statSync(sourceBin).mtimeMs;
      const dstMtime = statSync(targetBin).mtimeMs;
      if (srcMtime <= dstMtime) {
        return { synced: true, path: targetBin, updated: false };
      }
    }
    const targetDir = path.dirname(targetBin);
    mkdirSync(targetDir, { recursive: true });
    const atomicCopy = (src: string, dst: string) => {
      const tmp = `${dst}.updating.${process.pid}`;
      copyFileSync(src, tmp);
      if (!isWin) chmodSync(tmp, 0o755);
      renameSync(tmp, dst);
    };
    atomicCopy(sourceBin, targetBin);
    const sourceHelper = path.join(opts.bundledAgentDir, helperName);
    if (existsSync(sourceHelper)) {
      atomicCopy(sourceHelper, path.join(targetDir, helperName));
    }
    return { synced: true, path: targetBin, updated: true };
  } catch (e) {
    return {
      synced: false,
      path: targetBin,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Escape a POSIX shell single-quoted literal. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildMacUpdateScript(opts: {
  pid: number;
  stagedApp: string;
  targetApp: string;
  stageRoot: string;
  syncCliPath: string | null;
}): string {
  const backupApp = `${opts.targetApp}.prev`;
  const lines = [
    "#!/bin/sh",
    "set -eu",
    `PID=${opts.pid}`,
    `STAGED=${shQuote(opts.stagedApp)}`,
    `TARGET=${shQuote(opts.targetApp)}`,
    `BACKUP=${shQuote(backupApp)}`,
    `STAGE_ROOT=${shQuote(opts.stageRoot)}`,
    "",
    "# Wait up to 30s for the running Provenance app to finish quitting.",
    "i=0",
    'while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 150 ]; do',
    "  sleep 0.2",
    "  i=$((i + 1))",
    "done",
    "",
    'rm -rf "$BACKUP"',
    'if [ -e "$TARGET" ]; then',
    '  mv "$TARGET" "$BACKUP"',
    "fi",
    'if ! mv "$STAGED" "$TARGET"; then',
    '  if [ -e "$BACKUP" ]; then mv "$BACKUP" "$TARGET" || true; fi',
    "  exit 1",
    "fi",
    'rm -rf "$BACKUP" || true',
    'xattr -cr "$TARGET" 2>/dev/null || true',
  ];
  if (opts.syncCliPath) {
    const cliDir = path.dirname(opts.syncCliPath);
    lines.push(
      "",
      `CLI_TARGET=${shQuote(opts.syncCliPath)}`,
      `CLI_DIR=${shQuote(cliDir)}`,
      'BUNDLED_AGENT="$TARGET/Contents/Resources/agent"',
      'if [ -f "$CLI_TARGET" ] && [ -f "$BUNDLED_AGENT/provenance" ]; then',
      '  cp "$BUNDLED_AGENT/provenance" "$CLI_TARGET.tmp" && chmod 755 "$CLI_TARGET.tmp" && mv "$CLI_TARGET.tmp" "$CLI_TARGET" || true',
      '  if [ -f "$BUNDLED_AGENT/codex-code-mode-host" ]; then',
      '    cp "$BUNDLED_AGENT/codex-code-mode-host" "$CLI_DIR/codex-code-mode-host.tmp" && chmod 755 "$CLI_DIR/codex-code-mode-host.tmp" && mv "$CLI_DIR/codex-code-mode-host.tmp" "$CLI_DIR/codex-code-mode-host" || true',
      "  fi",
      "fi",
    );
  }
  lines.push("", 'rm -rf "$STAGE_ROOT" || true', 'open -n "$TARGET"', "");
  return lines.join("\n");
}

export function buildLinuxAppImageScript(opts: {
  pid: number;
  downloadedPath: string;
  targetAppImage: string;
}): string {
  const backup = `${opts.targetAppImage}.prev`;
  return [
    "#!/bin/sh",
    "set -eu",
    `PID=${opts.pid}`,
    `SRC=${shQuote(opts.downloadedPath)}`,
    `DST=${shQuote(opts.targetAppImage)}`,
    `BAK=${shQuote(backup)}`,
    "",
    "i=0",
    'while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 150 ]; do',
    "  sleep 0.2",
    "  i=$((i + 1))",
    "done",
    "",
    'chmod 755 "$SRC"',
    'rm -f "$BAK"',
    'if [ -e "$DST" ]; then mv "$DST" "$BAK"; fi',
    'if ! mv "$SRC" "$DST"; then',
    '  if [ -e "$BAK" ]; then mv "$BAK" "$DST" || true; fi',
    "  exit 1",
    "fi",
    'rm -f "$BAK" || true',
    'nohup "$DST" >/dev/null 2>&1 &',
    "",
  ].join("\n");
}

export function buildWindowsNsisScript(opts: {
  pid: number;
  installerPath: string;
  relaunchExe: string;
  silent: boolean;
  syncCliPath: string | null;
}): string {
  // PowerShell script launched with -WindowStyle Hidden so zero terminal window appears.
  const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const args = opts.silent ? "'-ArgumentList', '/S', " : "";
  const lines = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$pidToWait = ${opts.pid}`,
    `for ($i = 0; $i -lt 150; $i++) {`,
    `  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break }`,
    `  Start-Sleep -Milliseconds 200`,
    `}`,
    `$installer = ${psQuote(opts.installerPath)}`,
    opts.silent
      ? `Start-Process -FilePath $installer -ArgumentList '/S' -Wait`
      : `Start-Process -FilePath $installer -Wait`,
  ];
  void args;
  if (opts.syncCliPath) {
    const cliDir = path.win32.dirname(opts.syncCliPath);
    const installDir = path.win32.dirname(opts.relaunchExe);
    lines.push(
      `$cliTarget = ${psQuote(opts.syncCliPath)}`,
      `$cliDir = ${psQuote(cliDir)}`,
      `$agentDir = Join-Path ${psQuote(installDir)} 'resources\\agent'`,
      `$srcBin = Join-Path $agentDir 'provenance.exe'`,
      `if ((Test-Path $cliTarget) -and (Test-Path $srcBin)) {`,
      `  Copy-Item -Force $srcBin $cliTarget`,
      `  $srcHost = Join-Path $agentDir 'codex-code-mode-host.exe'`,
      `  if (Test-Path $srcHost) { Copy-Item -Force $srcHost (Join-Path $cliDir 'codex-code-mode-host.exe') }`,
      `}`,
    );
  }
  lines.push(
    `$exe = ${psQuote(opts.relaunchExe)}`,
    `if (Test-Path $exe) { Start-Process -FilePath $exe }`,
    "",
  );
  return lines.join("\r\n");
}

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

// ---- AppUpdater controller --------------------------------------------------

export interface AppUpdaterOptions {
  currentVersion: string;
  userData: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  exePath: string;
  homeDir: string;
  localAppData?: string;
  appImagePath?: string;
  apiUrl?: string;
  syncCliEnabled: () => boolean;
  log?: (msg: string) => void;
  onChange?: (state: UpdateState) => void;
  openExternal?: (url: string) => void | Promise<void>;
  showItemInFolder?: (filePath: string) => void;
  quitForUpdate: () => void;
}

export class AppUpdater {
  private readonly opts: AppUpdaterOptions;
  private state: UpdateState;
  private checkInFlight: Promise<UpdateState> | null = null;
  private downloadInFlight: Promise<UpdateState> | null = null;

  constructor(opts: AppUpdaterOptions) {
    this.opts = opts;
    this.state = {
      phase: "idle",
      currentVersion: opts.currentVersion,
      checkedAt: null,
      available: null,
      progress: null,
      downloadedPath: null,
      error: null,
      canSelfInstall: opts.isPackaged,
      cliSynced: null,
    };
  }

  getState(): UpdateState {
    return {
      ...this.state,
      available: this.state.available ? { ...this.state.available } : null,
      progress: this.state.progress ? { ...this.state.progress } : null,
      cliSynced: this.state.cliSynced ? { ...this.state.cliSynced } : null,
    };
  }

  private setState(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch };
    this.opts.onChange?.(this.getState());
    return this.getState();
  }

  private log(msg: string): void {
    this.opts.log?.(`[updater] ${msg}`);
  }

  /** Sync standalone CLI at launch if enabled and bundled copy is newer. */
  async syncCliAtLaunch(): Promise<CliSyncStatus | null> {
    if (!this.opts.syncCliEnabled()) return null;
    const bundledAgentDir = this.opts.isPackaged
      ? path.join(this.opts.resourcesPath, "agent")
      : path.join(this.opts.appPath, "vendor", "agent");
    const result = await syncStandaloneCli({
      bundledAgentDir,
      platform: this.opts.platform,
      homeDir: this.opts.homeDir,
      localAppData: this.opts.localAppData,
      onlyIfNewer: true,
    });
    if (result.path) {
      this.log(
        result.error
          ? `CLI sync warning (${result.path}): ${result.error}`
          : result.updated
            ? `synced standalone CLI at ${result.path}`
            : `standalone CLI at ${result.path} already current`,
      );
      this.setState({ cliSynced: result });
    }
    return result;
  }

  async check(opts: { autoDownload?: boolean } = {}): Promise<UpdateState> {
    if (this.checkInFlight) return this.checkInFlight;
    if (this.state.phase === "downloading" || this.state.phase === "installing") {
      return this.getState();
    }
    const run = this.doCheck(opts).finally(() => {
      this.checkInFlight = null;
    });
    this.checkInFlight = run;
    return run;
  }

  private async doCheck(opts: { autoDownload?: boolean }): Promise<UpdateState> {
    this.setState({ phase: "checking", error: null });
    const apiUrl = this.opts.apiUrl || DEFAULT_RELEASES_API;
    try {
      const res = await fetch(apiUrl, {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": `Provenance/${this.opts.currentVersion}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`GitHub releases returned HTTP ${res.status}`);
      }
      const rel = (await res.json()) as GitHubRelease;
      const tag = String(rel.tag_name ?? "").trim();
      const parsed = parseSemver(tag);
      if (!parsed) {
        throw new Error(`Latest release tag "${tag}" is not a valid semver version`);
      }
      const latestVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.pre.length ? `-${parsed.pre.join(".")}` : ""}`;
      const cmp = compareSemver(latestVersion, this.opts.currentVersion);
      const checkedAt = Date.now();
      if (cmp <= 0) {
        this.log(`up to date (${this.opts.currentVersion}, latest ${latestVersion})`);
        return this.setState({
          phase: "up-to-date",
          checkedAt,
          available: null,
          progress: null,
          downloadedPath: null,
          error: null,
        });
      }

      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const pick = selectReleaseAsset(assets, {
        platform: this.opts.platform,
        arch: this.opts.arch,
        appImagePath: this.opts.appImagePath,
      });

      let expectedSha256: string | null = null;
      const sumsAsset = assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
      if (sumsAsset && pick.asset) {
        try {
          const sumRes = await fetch(sumsAsset.browser_download_url, {
            headers: { "User-Agent": `Provenance/${this.opts.currentVersion}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (sumRes.ok) {
            const sums = parseSha256Sums(await sumRes.text());
            expectedSha256 = sums.get(pick.asset.name) ?? null;
          }
        } catch (e) {
          this.log(`couldn't read SHA256SUMS: ${String(e)}`);
        }
      }

      const available: UpdateReleaseInfo = {
        version: latestVersion,
        tag,
        name: (rel.name || `Provenance ${tag}`).trim(),
        notes: typeof rel.body === "string" ? rel.body.trim() : "",
        releaseUrl:
          rel.html_url ||
          `https://github.com/prominence-chan/provenance/releases/tag/${encodeURIComponent(tag)}`,
        publishedAt: typeof rel.published_at === "string" ? rel.published_at : null,
        assetName: pick.asset?.name ?? null,
        assetUrl: pick.asset?.browser_download_url ?? null,
        assetSize: typeof pick.asset?.size === "number" ? pick.asset.size : null,
        sha256: expectedSha256,
        installMode: pick.installMode,
      };

      // Check if we already downloaded and verified this exact asset previously.
      if (available.assetName) {
        const existingPath = path.join(
          this.opts.userData,
          "updates",
          available.version,
          available.assetName,
        );
        if (existsSync(existingPath)) {
          const ok = !available.sha256 || (await sha256File(existingPath)) === available.sha256;
          if (ok) {
            this.log(`update ${available.version} already downloaded at ${existingPath}`);
            return this.setState({
              phase: "ready",
              checkedAt,
              available,
              progress: null,
              downloadedPath: existingPath,
              error: null,
            });
          }
          rmSync(existingPath, { force: true });
        }
      }

      this.log(
        `update available: ${this.opts.currentVersion} -> ${available.version} (${available.assetName ?? "manual"})`,
      );
      const next = this.setState({
        phase: "available",
        checkedAt,
        available,
        progress: null,
        downloadedPath: null,
        error: null,
      });

      if (opts.autoDownload && available.assetUrl && available.installMode !== "manual") {
        void this.download();
      }
      return next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`check failed: ${msg}`);
      return this.setState({
        phase: "error",
        checkedAt: Date.now(),
        error: `Couldn't check for updates: ${msg}`,
      });
    }
  }

  async download(): Promise<UpdateState> {
    if (this.downloadInFlight) return this.downloadInFlight;
    const info = this.state.available;
    if (!info) {
      return this.setState({ phase: "error", error: "No update available to download." });
    }
    if (!info.assetUrl || !info.assetName) {
      await this.opts.openExternal?.(info.releaseUrl);
      return this.getState();
    }
    if (
      this.state.phase === "ready" &&
      this.state.downloadedPath &&
      existsSync(this.state.downloadedPath)
    ) {
      return this.getState();
    }
    const run = this.doDownload(info).finally(() => {
      this.downloadInFlight = null;
    });
    this.downloadInFlight = run;
    return run;
  }

  private async doDownload(info: UpdateReleaseInfo): Promise<UpdateState> {
    const dir = path.join(this.opts.userData, "updates", info.version);
    mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, info.assetName!);
    const partPath = `${finalPath}.part`;
    rmSync(partPath, { force: true });

    this.setState({
      phase: "downloading",
      error: null,
      progress: { received: 0, total: info.assetSize ?? 0, percent: 0 },
    });

    try {
      const res = await fetch(info.assetUrl!, {
        headers: { "User-Agent": `Provenance/${this.opts.currentVersion}` },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed with HTTP ${res.status}`);
      }
      const headerLen = Number(res.headers.get("content-length") ?? "0");
      const total = headerLen > 0 ? headerLen : (info.assetSize ?? 0);
      const hash = createHash("sha256");
      const out = createWriteStream(partPath);
      let received = 0;
      let lastEmit = 0;

      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          hash.update(value);
          if (!out.write(value)) {
            await new Promise<void>((resolve) => out.once("drain", resolve));
          }
          const now = Date.now();
          if (now - lastEmit >= 120 || (total > 0 && received >= total)) {
            lastEmit = now;
            const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
            this.setState({
              phase: "downloading",
              progress: { received, total, percent },
            });
          }
        }
      } finally {
        reader.releaseLock();
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      const actualSha256 = hash.digest("hex").toLowerCase();
      if (info.sha256 && actualSha256 !== info.sha256) {
        rmSync(partPath, { force: true });
        throw new Error("SHA-256 verification failed — download may be corrupted.");
      }

      renameSync(partPath, finalPath);
      this.log(`downloaded & verified ${info.assetName} (${received} bytes)`);
      return this.setState({
        phase: "ready",
        downloadedPath: finalPath,
        progress: { received, total: total || received, percent: 100 },
        error: null,
      });
    } catch (e) {
      rmSync(partPath, { force: true });
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`download failed: ${msg}`);
      return this.setState({
        phase: "error",
        progress: null,
        error: msg,
      });
    }
  }

  async installAndRestart(): Promise<UpdateState> {
    const info = this.state.available;
    const file = this.state.downloadedPath;
    if (!info) {
      return this.setState({ phase: "error", error: "No update available." });
    }
    if (!this.opts.isPackaged) {
      await this.opts.openExternal?.(info.releaseUrl);
      return this.setState({
        phase: "error",
        error: "Self-update only applies to the packaged app. Opened the GitHub release page.",
      });
    }
    if (info.installMode === "manual" || !file || !existsSync(file)) {
      await this.opts.openExternal?.(info.releaseUrl);
      return this.getState();
    }

    this.setState({ phase: "installing", error: null });
    const syncCli = this.opts.syncCliEnabled()
      ? standaloneCliPath({
          platform: this.opts.platform,
          homeDir: this.opts.homeDir,
          localAppData: this.opts.localAppData,
        })
      : null;

    try {
      if (info.installMode === "replace-mac-app") {
        await this.installMacApp(info, file, syncCli);
        return this.getState();
      }
      if (info.installMode === "nsis-installer") {
        this.installWindowsNsis(info, file, syncCli);
        return this.getState();
      }
      if (info.installMode === "replace-appimage") {
        this.installLinuxAppImage(info, file);
        return this.getState();
      }
      if (info.installMode === "deb-package") {
        await this.installLinuxDeb(file);
        return this.getState();
      }
      await this.opts.openExternal?.(info.releaseUrl);
      return this.getState();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`install failed: ${msg}`);
      return this.setState({ phase: "error", error: msg });
    }
  }

  private async installMacApp(
    info: UpdateReleaseInfo,
    zipPath: string,
    syncCli: string | null,
  ): Promise<void> {
    const targetApp = findMacAppBundle(this.opts.exePath);
    if (!targetApp) {
      throw new Error("Couldn't locate the running Provenance.app bundle.");
    }
    try {
      accessSync(path.dirname(targetApp), fsConstants.W_OK);
    } catch {
      this.opts.showItemInFolder?.(zipPath);
      throw new Error(
        `Can't write to ${path.dirname(targetApp)}. Move Provenance.app to /Applications or install from the downloaded archive.`,
      );
    }

    const stageRoot = path.join(this.opts.userData, "updates", info.version, "stage");
    rmSync(stageRoot, { recursive: true, force: true });
    mkdirSync(stageRoot, { recursive: true });
    await execFileAsync("ditto", ["-x", "-k", zipPath, stageRoot]);

    const appEntry = readdirSync(stageRoot).find((n) => n.endsWith(".app"));
    if (!appEntry) {
      throw new Error("Update archive did not contain a .app bundle.");
    }
    const stagedApp = path.join(stageRoot, appEntry);
    await execFileAsync("codesign", ["--verify", "--deep", "--strict", stagedApp]);

    const scriptPath = path.join(this.opts.userData, "updates", info.version, "apply-update.sh");
    const script = buildMacUpdateScript({
      pid: process.pid,
      stagedApp,
      targetApp,
      stageRoot,
      syncCliPath: syncCli && existsSync(syncCli) ? syncCli : null,
    });
    writeFileSync(scriptPath, script, { mode: 0o755 });

    const child = spawn("/bin/sh", [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    this.log(`handed off macOS update to ${scriptPath} -> ${targetApp}`);
    this.opts.quitForUpdate();
  }

  private installWindowsNsis(
    info: UpdateReleaseInfo,
    installerPath: string,
    syncCli: string | null,
  ): void {
    const installDir = path.dirname(this.opts.exePath);
    const silent = existsSync(path.join(installDir, "Uninstall Provenance.exe"));
    const scriptPath = path.join(this.opts.userData, "updates", info.version, "apply-update.ps1");
    const script = buildWindowsNsisScript({
      pid: process.pid,
      installerPath,
      relaunchExe: this.opts.exePath,
      silent,
      syncCliPath: syncCli && existsSync(syncCli) ? syncCli : null,
    });
    writeFileSync(scriptPath, script, "utf8");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
    this.log(`handed off Windows update (silent=${silent}) to ${scriptPath}`);
    this.opts.quitForUpdate();
  }

  private installLinuxAppImage(info: UpdateReleaseInfo, downloadedPath: string): void {
    const targetAppImage = this.opts.appImagePath;
    if (!targetAppImage) {
      throw new Error("APPIMAGE path is unavailable.");
    }
    accessSync(path.dirname(targetAppImage), fsConstants.W_OK);
    const scriptPath = path.join(this.opts.userData, "updates", info.version, "apply-update.sh");
    const script = buildLinuxAppImageScript({
      pid: process.pid,
      downloadedPath,
      targetAppImage,
    });
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const child = spawn("/bin/sh", [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    this.log(`handed off AppImage update to ${scriptPath} -> ${targetAppImage}`);
    this.opts.quitForUpdate();
  }

  private async installLinuxDeb(debPath: string): Promise<void> {
    try {
      await execFileAsync("which", ["pkexec"]);
    } catch {
      this.opts.showItemInFolder?.(debPath);
      throw new Error(`Install the downloaded package with: sudo apt install "${debPath}"`);
    }
    const child = spawn("pkexec", ["apt-get", "install", "-y", debPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    this.log(`launched pkexec apt-get install -y ${debPath}`);
    this.opts.quitForUpdate();
  }
}
