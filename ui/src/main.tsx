import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyShell, appShell } from "./app-shell";
import { PresenceReporter } from "./presence";
import { maybeOpenWelcome, openSetup, openWelcome } from "./setup/open";
import {
  initDesktopBridges,
  openSettings,
  setMockAppSettings,
  setMockUpdateState,
} from "./setup/settings-store";
import { boot, newThread, renameThread, updateSettings } from "./store/actions";
import { getState } from "./store/store";
import "./styles.css";
import { applyTheme } from "./theme/theme";

applyTheme();
applyShell();
initDesktopBridges();

// App menu / `provenance-ui` from a directory: start a new thread there.
appShell?.onSetCwd((cwd) => {
  newThread();
  updateSettings({ cwd });
});
appShell?.onNewThread(() => newThread());
appShell?.onOpenAccounts?.(() => openSetup());
appShell?.onOpenWelcome?.(() => openWelcome());

// Headless checks read the whole store, and rename a thread (no control for it yet), with
// `?statecheck` (scripts/carry-e2e.ts).
if (new URLSearchParams(location.search).has("statecheck"))
  Object.assign(window, {
    __provenanceState: getState,
    __provenanceRename: renameThread,
    __provenanceOpenSettings: openSettings,
    __provenanceMockUpdate: setMockUpdateState,
    __provenanceMockAppSettings: setMockAppSettings,
  });

void boot();
// Something not set up yet (a site, an API key, a fallback) -> the welcome, once.
void maybeOpenWelcome();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {appShell?.setPresence && <PresenceReporter />}
  </StrictMode>,
);
