// Reactive store for the Settings dialog, Electron desktop settings snapshot, and self-updater.

import { useSyncExternalStore } from "react";
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  SettingsTab,
  UpdateState,
} from "../../shared/updater-api";
import { appShell } from "../app-shell";

export interface SettingsDialogState {
  open: boolean;
  tab: SettingsTab;
}

let dialogState: SettingsDialogState = { open: false, tab: "general" };
let appSettings: AppSettingsSnapshot | null = null;
let updateState: UpdateState | null = null;
let wired = false;

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function initDesktopBridges(): void {
  if (wired) return;
  wired = true;
  if (!appShell) return;

  appShell.onOpenSettings?.((tab) => openSettings(tab ?? "general"));
  appShell.onAppSettings?.((snap) => {
    appSettings = snap;
    emit();
  });
  appShell.onUpdateState?.((state) => {
    updateState = state;
    emit();
  });

  void appShell.getAppSettings?.().then((snap) => {
    if (!snap) return;
    appSettings = snap;
    emit();
  });
  void appShell.getUpdateState?.().then((state) => {
    if (!state) return;
    updateState = state;
    emit();
  });
}

export function openSettings(tab: SettingsTab = "general"): void {
  dialogState = { open: true, tab };
  emit();
  void appShell?.getAppSettings?.().then((snap) => {
    if (!snap) return;
    appSettings = snap;
    emit();
  });
  void appShell?.getUpdateState?.().then((state) => {
    if (!state) return;
    updateState = state;
    emit();
  });
}

export function setSettingsTab(tab: SettingsTab): void {
  if (dialogState.tab === tab) return;
  dialogState = { ...dialogState, tab };
  emit();
}

export function closeSettings(): void {
  if (!dialogState.open) return;
  dialogState = { ...dialogState, open: false };
  emit();
}

export async function updateDesktopSettings(
  patch: AppSettingsPatch,
): Promise<AppSettingsSnapshot | null> {
  if (!appShell?.updateAppSettings) return null;
  const snap = await appShell.updateAppSettings(patch);
  appSettings = snap;
  emit();
  return snap;
}

export async function checkForUpdates(): Promise<UpdateState | null> {
  if (!appShell?.checkForUpdates) return null;
  const state = await appShell.checkForUpdates();
  updateState = state;
  emit();
  return state;
}

export async function downloadUpdate(): Promise<UpdateState | null> {
  if (!appShell?.downloadUpdate) return null;
  const state = await appShell.downloadUpdate();
  updateState = state;
  emit();
  return state;
}

export async function installUpdate(): Promise<UpdateState | null> {
  if (!appShell?.installUpdate) return null;
  const state = await appShell.installUpdate();
  updateState = state;
  emit();
  return state;
}

/** Test hook used only under `?statecheck` for Playwright visual verification of all states. */
export function setMockUpdateState(next: UpdateState | null): void {
  updateState = next;
  emit();
}

export function setMockAppSettings(next: AppSettingsSnapshot | null): void {
  appSettings = next;
  emit();
}

export function useSettingsOpen(): SettingsDialogState {
  return useSyncExternalStore(subscribe, () => dialogState);
}

export function useAppSettings(): AppSettingsSnapshot | null {
  return useSyncExternalStore(subscribe, () => appSettings);
}

export function useUpdateState(): UpdateState | null {
  return useSyncExternalStore(subscribe, () => updateState);
}
