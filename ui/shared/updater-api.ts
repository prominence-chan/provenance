// Shared types for the built-in self-updater and Electron app settings IPC.
// Imported by electron/main.ts, electron/updater.ts, electron/preload.ts, and src/.

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export type UpdateInstallMode =
  "replace-mac-app" | "nsis-installer" | "replace-appimage" | "deb-package" | "manual";

export interface UpdateReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  releaseUrl: string;
  publishedAt: string | null;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number | null;
  sha256: string | null;
  installMode: UpdateInstallMode;
}

export interface UpdateProgress {
  received: number;
  total: number;
  /** 0..100 */
  percent: number;
}

export interface CliSyncStatus {
  synced: boolean;
  path: string | null;
  updated?: boolean;
  error?: string;
}

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  checkedAt: number | null;
  available: UpdateReleaseInfo | null;
  progress: UpdateProgress | null;
  downloadedPath: string | null;
  error: string | null;
  canSelfInstall: boolean;
  cliSynced: CliSyncStatus | null;
}

export type RouterPolicySetting = "auto" | "external" | "bundled";

export interface DesktopSettings {
  provenanceBin: string;
  routerUrl: string;
  router: RouterPolicySetting;
  routerLaunchdLabel: string;
  defaultCwd: string;
  port: number;
  discordPresence: boolean;
  discordClientId: string;
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  syncCliOnUpdate: boolean;
}

export type DesktopSettingsPatch = Partial<DesktopSettings>;
export type AppSettingsPatch = DesktopSettingsPatch;

export interface AppSettingsSnapshot {
  version: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  settingsPath: string;
  logDir: string;
  agentPath: string;
  agentSource: string;
  discordConfigured: boolean;
  restartRequired: boolean;
  settings: DesktopSettings;
}

export type SettingsTab = "general" | "accounts" | "integrations" | "updates" | "advanced";
