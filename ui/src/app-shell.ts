// The desktop app's preload API (ui/electron/preload.ts), when running inside it.
// In a plain browser `appShell` is undefined and the UI behaves as before.

export interface AppShell {
  platform: string;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  startRouter(): Promise<{ up: boolean; message?: string }>;
  openPreferences(): Promise<void>;
  onSetCwd(cb: (cwd: string) => void): () => void;
  onNewThread(cb: () => void): () => void;
  /** App menu -> Models & Accounts… (absent in builds from before it). */
  onOpenAccounts?(cb: () => void): () => void;
  /** App menu -> Welcome… (absent in builds from before it). */
  onOpenWelcome?(cb: () => void): () => void;
}

export const appShell: AppShell | undefined = (window as { provenanceApp?: AppShell })
  .provenanceApp;

/** Marks the page so styles.css can make room for the traffic lights and drag regions. */
export function applyShell(): void {
  if (appShell) document.documentElement.dataset.shell = appShell.platform;
}
