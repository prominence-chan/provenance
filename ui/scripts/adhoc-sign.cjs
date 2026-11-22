// electron-builder afterPack hook: ad-hoc sign the .app (no Developer ID, no
// notarization). Runs before the .dmg is made, so the DMG holds the signed app.
// Apple Silicon refuses to run unsigned arm64 code, and editing Info.plist breaks
// Electron's own ad-hoc signature, so this is required, not cosmetic.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app], {
    stdio: "inherit",
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${app}`);
};
