// Unit & mock-HTTP checks for the built-in self-updater (electron/updater.ts).
// Covers semver comparison, SHA256SUMS.txt parsing, cross-platform asset selection,
// streaming download + SHA-256 verification (valid + tampered rejection), cached download
// reuse, platform installer script generation, and standalone CLI sync.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppUpdater,
  buildLinuxAppImageScript,
  buildMacUpdateScript,
  buildWindowsNsisScript,
  compareSemver,
  findMacAppBundle,
  parseSha256Sums,
  selectReleaseAsset,
  syncStandaloneCli,
  type GitHubAsset,
} from "../electron/updater.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

await test("semver comparison", () => {
  assert.equal(compareSemver("0.2.1", "0.2.0"), 1);
  assert.equal(compareSemver("v0.2.1", "0.2.1"), 0);
  assert.equal(compareSemver("0.2.0", "0.2.1"), -1);
  assert.equal(compareSemver("0.10.0", "0.2.9"), 1);
  assert.equal(compareSemver("0.2.1", "0.2.1-beta.1"), 1);
  assert.equal(compareSemver("0.2.1-beta.2", "0.2.1-beta.1"), 1);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
});

await test("SHA256SUMS parsing", () => {
  const h1 = "a".repeat(64);
  const h2 = "b".repeat(64);
  const parsed = parseSha256Sums(
    `# comment\n${h1}  Provenance-0.2.1-arm64-mac.zip\n${h2} *dir/Provenance-0.2.1-x64-setup.exe\n`,
  );
  assert.equal(parsed.get("Provenance-0.2.1-arm64-mac.zip"), h1);
  assert.equal(parsed.get("Provenance-0.2.1-x64-setup.exe"), h2);
  assert.equal(parsed.size, 2);
});

await test("platform asset selection matches release.yml outputs", () => {
  const assets: GitHubAsset[] = [
    { name: "Provenance-0.2.1-arm64.dmg", browser_download_url: "https://example/arm64.dmg" },
    { name: "Provenance-0.2.1-arm64-mac.zip", browser_download_url: "https://example/arm64.zip" },
    { name: "Provenance-0.2.1-x64.dmg", browser_download_url: "https://example/x64.dmg" },
    { name: "Provenance-0.2.1-mac.zip", browser_download_url: "https://example/x64.zip" },
    { name: "Provenance-0.2.1-x64-setup.exe", browser_download_url: "https://example/setup.exe" },
    { name: "Provenance-0.2.1-x64.zip", browser_download_url: "https://example/win.zip" },
    {
      name: "Provenance-0.2.1-x86_64.AppImage",
      browser_download_url: "https://example/app.AppImage",
    },
    { name: "Provenance-0.2.1-amd64.deb", browser_download_url: "https://example/app.deb" },
    { name: "SHA256SUMS.txt", browser_download_url: "https://example/SHA256SUMS.txt" },
  ];

  const macArm = selectReleaseAsset(assets, { platform: "darwin", arch: "arm64" });
  assert.equal(macArm.asset?.name, "Provenance-0.2.1-arm64-mac.zip");
  assert.equal(macArm.installMode, "replace-mac-app");

  const macX64 = selectReleaseAsset(assets, { platform: "darwin", arch: "x64" });
  assert.equal(macX64.asset?.name, "Provenance-0.2.1-mac.zip");
  assert.equal(macX64.installMode, "replace-mac-app");

  const win = selectReleaseAsset(assets, { platform: "win32", arch: "x64" });
  assert.equal(win.asset?.name, "Provenance-0.2.1-x64-setup.exe");
  assert.equal(win.installMode, "nsis-installer");

  const linuxAppImage = selectReleaseAsset(assets, {
    platform: "linux",
    arch: "x64",
    appImagePath: "/opt/Provenance.AppImage",
  });
  assert.equal(linuxAppImage.asset?.name, "Provenance-0.2.1-x86_64.AppImage");
  assert.equal(linuxAppImage.installMode, "replace-appimage");

  const linuxDeb = selectReleaseAsset(assets, { platform: "linux", arch: "x64" });
  assert.equal(linuxDeb.asset?.name, "Provenance-0.2.1-amd64.deb");
  assert.equal(linuxDeb.installMode, "deb-package");
});

await test("macOS bundle path discovery & install script generation", () => {
  assert.equal(
    findMacAppBundle("/Applications/Provenance.app/Contents/MacOS/Provenance"),
    "/Applications/Provenance.app",
  );
  const macScript = buildMacUpdateScript({
    pid: 1234,
    stagedApp: "/tmp/stage/Provenance.app",
    targetApp: "/Applications/Provenance.app",
    stageRoot: "/tmp/stage",
    syncCliPath: "/Users/me/.local/bin/provenance",
  });
  assert.match(macScript, /xattr -cr/);
  assert.match(macScript, /codex-code-mode-host/);
  assert.match(macScript, /open -n "\$TARGET"/);

  const winScript = buildWindowsNsisScript({
    pid: 5678,
    installerPath: "C:\\Temp\\Provenance-0.2.2-x64-setup.exe",
    relaunchExe: "C:\\Program Files\\Provenance\\Provenance.exe",
    silent: true,
    syncCliPath: "C:\\Users\\me\\AppData\\Local\\Provenance\\bin\\provenance.exe",
  });
  assert.match(winScript, /-ArgumentList '\/S' -Wait/);
  assert.match(winScript, /Start-Process -FilePath \$exe/);

  const linuxScript = buildLinuxAppImageScript({
    pid: 9999,
    downloadedPath: "/tmp/new.AppImage",
    targetAppImage: "/home/me/Provenance.AppImage",
  });
  assert.match(linuxScript, /chmod 755 "\$SRC"/);
});

await test("mock HTTP check + download + SHA-256 verification + tampered rejection", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "provenance-updater-check-"));
  const payload = Buffer.from("fake-provenance-zip-payload-v0.2.2-".repeat(256));
  const goodHash = createHash("sha256").update(payload).digest("hex");
  let serveTampered = false;
  let releaseTag = "v0.2.2";

  const server = http.createServer((req, res) => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    if (req.url === "/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: releaseTag,
          name: `Provenance ${releaseTag} — Public Beta`,
          body: "Self-updater and condensed settings.",
          html_url: "https://github.com/prominence-chan/provenance/releases/tag/v0.2.2",
          assets: [
            {
              name: "Provenance-0.2.2-arm64-mac.zip",
              browser_download_url: `${base}/download/mac.zip`,
              size: payload.length,
            },
            {
              name: "SHA256SUMS.txt",
              browser_download_url: `${base}/download/SHA256SUMS.txt`,
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/download/SHA256SUMS.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${goodHash}  Provenance-0.2.2-arm64-mac.zip\n`);
      return;
    }
    if (req.url === "/download/mac.zip") {
      const body = serveTampered ? Buffer.from("tampered-bytes") : payload;
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const apiUrl = `http://127.0.0.1:${port}/releases/latest`;

  try {
    const phases: string[] = [];
    const updater = new AppUpdater({
      currentVersion: "0.2.1",
      userData: work,
      platform: "darwin",
      arch: "arm64",
      isPackaged: true,
      appPath: work,
      resourcesPath: work,
      exePath: "/Applications/Provenance.app/Contents/MacOS/Provenance",
      homeDir: work,
      apiUrl,
      syncCliEnabled: () => true,
      onChange: (s) => phases.push(s.phase),
      quitForUpdate: () => {},
    });

    // 1. Check detects newer version + expected SHA-256
    const st1 = await updater.check();
    assert.equal(st1.phase, "available");
    assert.equal(st1.available?.version, "0.2.2");
    assert.equal(st1.available?.sha256, goodHash);

    // 2. Tampered download is rejected and cleaned up
    serveTampered = true;
    const stBad = await updater.download();
    assert.equal(stBad.phase, "error");
    assert.match(stBad.error ?? "", /SHA-256/);
    assert.equal(
      existsSync(path.join(work, "updates/0.2.2/Provenance-0.2.2-arm64-mac.zip")),
      false,
    );

    // 3. Valid download succeeds and verifies SHA-256
    serveTampered = false;
    const stGood = await updater.download();
    assert.equal(stGood.phase, "ready");
    assert.ok(stGood.downloadedPath && existsSync(stGood.downloadedPath));
    assert.equal(stGood.progress?.percent, 100);
    assert.ok(phases.includes("downloading"));

    // 4. Subsequent check reuses cached verified file straight into "ready"
    const stCached = await updater.check();
    assert.equal(stCached.phase, "ready");

    // 5. Up-to-date check when current version >= latest
    releaseTag = "v0.2.1";
    const stUpToDate = await updater.check();
    assert.equal(stUpToDate.phase, "up-to-date");
    assert.equal(stUpToDate.available, null);
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});

await test("standalone CLI sync updates older binary and skips newer local dev binary", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "provenance-cli-sync-"));
  try {
    const bundledDir = path.join(work, "bundled");
    const homeDir = path.join(work, "home");
    const localBinDir = path.join(homeDir, ".local", "bin");
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(localBinDir, { recursive: true });

    const bundledBin = path.join(bundledDir, "provenance");
    const bundledHost = path.join(bundledDir, "codex-code-mode-host");
    const localBin = path.join(localBinDir, "provenance");

    writeFileSync(bundledBin, "bundled-v0.2.1");
    writeFileSync(bundledHost, "host-v0.2.1");
    writeFileSync(localBin, "old-v0.2.0");

    // Make local binary older than bundled binary
    const older = new Date(Date.now() - 60_000);
    utimesSync(localBin, older, older);

    const r1 = await syncStandaloneCli({
      bundledAgentDir: bundledDir,
      platform: "darwin",
      homeDir,
      onlyIfNewer: true,
    });
    assert.equal(r1.synced, true);
    assert.equal(r1.updated, true);
    assert.equal(readFileSync(localBin, "utf8"), "bundled-v0.2.1");
    assert.equal(
      readFileSync(path.join(localBinDir, "codex-code-mode-host"), "utf8"),
      "host-v0.2.1",
    );

    // Simulate a developer compiling a newer local binary: onlyIfNewer must NOT overwrite it
    writeFileSync(localBin, "dev-custom-build");
    const future = new Date(Date.now() + 60_000);
    utimesSync(localBin, future, future);
    const r2 = await syncStandaloneCli({
      bundledAgentDir: bundledDir,
      platform: "darwin",
      homeDir,
      onlyIfNewer: true,
    });
    assert.equal(r2.synced, true);
    assert.equal(r2.updated, false);
    assert.equal(readFileSync(localBin, "utf8"), "dev-custom-build");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

console.log(`\nall ${passed} updater checks passed`);
