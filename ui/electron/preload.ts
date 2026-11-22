// Preload (sandboxed): the small API the web UI uses when it runs in the app.
// The UI checks `window.provenanceApp` and falls back to browser behaviour without it.
// Keep in sync with src/app-shell.ts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

function on(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("provenanceApp", {
  platform: process.platform,
  pickDirectory: (defaultPath?: string) => ipcRenderer.invoke("app:pick-directory", defaultPath),
  startRouter: () => ipcRenderer.invoke("app:start-router"),
  openPreferences: () => ipcRenderer.invoke("app:open-preferences"),
  onSetCwd: (cb: (cwd: string) => void) => on("app:set-cwd", (cwd) => cb(String(cwd))),
  onNewThread: (cb: () => void) => on("app:new-thread", () => cb()),
  onOpenAccounts: (cb: () => void) => on("app:open-accounts", () => cb()),
});
