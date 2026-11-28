// The desktop app's preload API (ui/electron/preload.ts), when running inside it.
// In a plain browser `appShell` is undefined and the UI behaves as before.

import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  SettingsTab,
  UpdateState,
} from "../shared/updater-api";

export interface AppShell {
  platform: string;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  startRouter(): Promise<{ up: boolean; message?: string }>;
  openPreferences(): Promise<void>;
  openLogs?(): Promise<void>;
  relaunch?(): Promise<void>;
  getAppSettings?(): Promise<AppSettingsSnapshot>;
  updateAppSettings?(patch: AppSettingsPatch): Promise<AppSettingsSnapshot>;
  getUpdateState?(): Promise<UpdateState>;
  checkForUpdates?(): Promise<UpdateState>;
  downloadUpdate?(): Promise<UpdateState>;
  installUpdate?(): Promise<UpdateState>;
  onSetCwd(cb: (cwd: string) => void): () => void;
  onNewThread(cb: () => void): () => void;
  /** App menu -> Models & Accounts… (absent in builds from before it). */
  onOpenAccounts?(cb: () => void): () => void;
  /** App menu -> Welcome… (absent in builds from before it). */
  onOpenWelcome?(cb: () => void): () => void;
  /** App menu -> Settings… / CmdOrCtrl+, */
  onOpenSettings?(cb: (tab?: SettingsTab) => void): () => void;
  /** Push updates from built-in self-updater. */
  onUpdateState?(cb: (state: UpdateState) => void): () => void;
  /** Push updates when main-process settings change (e.g. menu checkbox or file edit). */
  onAppSettings?(cb: (snap: AppSettingsSnapshot) => void): () => void;
  /** Coarse state for Discord Rich Presence (src/presence.ts; absent in builds from before it). */
  setPresence?(s: PresenceReport): void;
}

/** What the page tells the app for Discord: never a title, prompt, path or account. */
export interface PresenceReport {
  /** The selected tier (spark, ember, solstice, nova) or fallback (claude, codex); else null. */
  kind: string | null;
  /** The orchestrator of the running (else the selected) thread on a tier; else null. */
  orchestrator: string | null;
  working: boolean;
  /** When the running turn started, ms since epoch. */
  since: number | null;
}

export const appShell: AppShell | undefined = (window as { provenanceApp?: AppShell })
  .provenanceApp;

/** Marks the page so styles.css can make room for the traffic lights and drag regions. */
export function applyShell(): void {
  if (appShell) document.documentElement.dataset.shell = appShell.platform;
}
