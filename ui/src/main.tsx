import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyShell, appShell } from "./app-shell";
import { maybeOpenFirstRun, openSetup } from "./setup/open";
import { boot, newThread, updateSettings } from "./store/actions";
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

void boot();
// First run: no site signed in yet -> open "Models & accounts" once.
void maybeOpenFirstRun();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
