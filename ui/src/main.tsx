import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyShell, appShell } from "./app-shell";
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

void boot();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
