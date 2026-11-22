import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyShell, appShell } from "./app-shell";
import { maybeOpenWelcome, openSetup, openWelcome } from "./setup/open";
import { boot, newThread, updateSettings } from "./store/actions";
import { getState } from "./store/store";
import "./styles.css";
import { applyTheme } from "./theme/theme";

applyTheme();
applyShell();

// App menu / `provenance-ui` from a directory: start a new thread there.
appShell?.onSetCwd((cwd) => {
  newThread();
  updateSettings({ cwd });
});
appShell?.onNewThread(() => newThread());
appShell?.onOpenAccounts?.(() => openSetup());
appShell?.onOpenWelcome?.(() => openWelcome());

void boot();
// First run: nothing set up (no site, no API key, no fallback) -> the welcome, once.
void maybeOpenWelcome(() => {
  const f = getState().settings.fallbacks;
  return f.claude || f.codex !== "off";
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
