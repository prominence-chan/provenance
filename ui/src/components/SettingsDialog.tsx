// Condensed desktop Settings dialog: appearance, defaults, logins & fallbacks, Discord
// integration, built-in self-updater, and router/binary advanced options in one compact modal.

import { useEffect, useRef, useState } from "react";
import {
  isHyperexperimentalAllowed,
  ORCHESTRATORS,
  type Orchestrator,
} from "../../shared/orchestrator-api";
import type { RouterPolicySetting, SettingsTab } from "../../shared/updater-api";
import { appShell } from "../app-shell";
import type { SandboxMode } from "../protocol";
import { openSetup, openWelcome, useSetupGaps } from "../setup/open";
import { IconClose, Status } from "../setup/parts";
import {
  checkForUpdates,
  closeSettings,
  downloadUpdate,
  installUpdate,
  setSettingsTab,
  updateDesktopSettings,
  useAppSettings,
  useSettingsOpen,
  useUpdateState,
} from "../setup/settings-store";
import { refreshFallbacks, setFallbackPrefs, updateSettings } from "../store/actions";
import type { Settings } from "../store/state";
import { useAppState } from "../store/store";
import { setTheme, useTheme } from "../theme/theme";
import { IconChevron, IconExternal, IconFolder, IconRefresh } from "./icons";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "integrations", label: "Integrations" },
  { id: "updates", label: "Updates" },
  { id: "advanced", label: "Advanced" },
];

const PERMISSION_PRESETS: {
  id: string;
  label: string;
  approvalPolicy: Settings["approvalPolicy"];
  sandbox: SandboxMode;
}[] = [
  { id: "ask", label: "Ask every time", approvalPolicy: "untrusted", sandbox: "workspace-write" },
  { id: "auto", label: "Auto", approvalPolicy: "on-request", sandbox: "workspace-write" },
  { id: "readonly", label: "Read only", approvalPolicy: "on-request", sandbox: "read-only" },
  { id: "full", label: "Full access", approvalPolicy: "never", sandbox: "danger-full-access" },
];

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SettingsDialog() {
  const { open, tab } = useSettingsOpen();
  const snap = useAppSettings();
  const update = useUpdateState();
  const ref = useRef<HTMLDialogElement>(null);
  const updateBadge =
    update?.phase === "ready" ? "ready" : update?.phase === "available" ? "available" : null;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      void refreshFallbacks();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="setup-dialog settings-dialog"
      aria-label="Settings"
      onCancel={(e) => {
        e.preventDefault();
        closeSettings();
      }}
      onClick={(e) => {
        if (e.target === ref.current) closeSettings();
      }}
    >
      <div className="setup-panel settings-panel" tabIndex={-1}>
        <header className="settings-head">
          <div className="settings-head-title">
            <h2>Settings</h2>
            {snap?.version && <span className="settings-version">v{snap.version}</span>}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close settings"
            title="Close"
            onClick={closeSettings}
          >
            <IconClose />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`settings-tab${tab === t.id ? " active" : ""}`}
                onClick={() => setSettingsTab(t.id)}
              >
                <span>{t.label}</span>
                {t.id === "updates" && updateBadge && (
                  <span className={`settings-tab-dot ${updateBadge}`} aria-hidden />
                )}
              </button>
            ))}
          </nav>

          <div className="settings-body" role="tabpanel">
            {tab === "general" && <GeneralSection />}
            {tab === "accounts" && <AccountsSection />}
            {tab === "integrations" && <IntegrationsSection />}
            {tab === "updates" && <UpdatesSection />}
            {tab === "advanced" && <AdvancedSection />}
          </div>
        </div>
      </div>
    </dialog>
  );
}

// ---- General ----------------------------------------------------------------

function GeneralSection() {
  const theme = useTheme();
  const settings = useAppState((s) => s.settings);
  const tiers = useAppState((s) => s.tiers);
  const sources = useAppState((s) => s.sources);
  const snap = useAppSettings();
  const [cwdDraft, setCwdDraft] = useState(snap?.settings.defaultCwd || settings.cwd);

  useEffect(() => {
    setCwdDraft(snap?.settings.defaultCwd || settings.cwd);
  }, [snap?.settings.defaultCwd, settings.cwd]);

  const currentPerm = PERMISSION_PRESETS.find(
    (p) => p.approvalPolicy === settings.approvalPolicy && p.sandbox === settings.sandbox,
  );
  const hyperAllowed =
    Object.keys(sources).length === 0 || isHyperexperimentalAllowed(settings.model, sources);
  const activeOrch = ORCHESTRATORS.find((o) => o.id === settings.orchestrator);

  const commitCwd = (next: string) => {
    const trimmed = next.trim();
    updateSettings({ cwd: trimmed });
    void updateDesktopSettings({ defaultCwd: trimmed });
  };

  const browseCwd = async () => {
    const dir = await appShell?.pickDirectory(cwdDraft || undefined);
    if (!dir) return;
    setCwdDraft(dir);
    commitCwd(dir);
  };

  return (
    <div className="settings-section">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Appearance</span>
          <span className="meta">Interface color theme</span>
        </div>
        <div className="settings-seg" role="group" aria-label="Appearance">
          {(["dark", "light"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={theme === m ? "active" : ""}
              aria-pressed={theme === m}
              onClick={() => setTheme(m)}
            >
              {m === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Default tier</span>
          <span className="meta">Model tier for new threads</span>
        </div>
        <select
          className="setup-input settings-select"
          aria-label="Default tier"
          value={tiers.includes(settings.model) ? settings.model : (tiers[0] ?? "solstice")}
          onChange={(e) => updateSettings({ model: e.target.value })}
        >
          {tiers.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row settings-row-col">
        <div className="settings-row-top">
          <div className="settings-row-text">
            <span className="settings-row-label">Default orchestrator</span>
            <span className="meta">{activeOrch?.blurb ?? "How tier threads run"}</span>
          </div>
          <div className="settings-seg" role="group" aria-label="Default orchestrator">
            {ORCHESTRATORS.map((o) => {
              const disabled = o.id === "hyperexperimental" && !hyperAllowed;
              return (
                <button
                  key={o.id}
                  type="button"
                  className={settings.orchestrator === o.id ? "active" : ""}
                  aria-pressed={settings.orchestrator === o.id}
                  disabled={disabled}
                  title={disabled ? "Hyperexperimental requires a web-chat tier model" : o.blurb}
                  onClick={() => updateSettings({ orchestrator: o.id as Orchestrator })}
                >
                  {o.id === "hyperexperimental" ? "Hyper" : o.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Permissions</span>
          <span className="meta">Approval policy and sandbox</span>
        </div>
        <select
          className="setup-input settings-select"
          aria-label="Permissions"
          value={currentPerm?.id ?? "auto"}
          onChange={(e) => {
            const p = PERMISSION_PRESETS.find((x) => x.id === e.target.value);
            if (p) updateSettings({ approvalPolicy: p.approvalPolicy, sandbox: p.sandbox });
          }}
        >
          {PERMISSION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row settings-row-col">
        <div className="settings-row-text">
          <span className="settings-row-label">Default working folder</span>
          <span className="meta">Used when starting a new thread</span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="setup-input settings-input-grow"
            value={cwdDraft}
            placeholder="Last used folder"
            spellCheck={false}
            onChange={(e) => setCwdDraft(e.target.value)}
            onBlur={() => commitCwd(cwdDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCwd(cwdDraft);
            }}
          />
          {appShell && (
            <button
              type="button"
              className="btn settings-browse-btn"
              onClick={() => void browseCwd()}
            >
              <IconFolder size={12} />
              Browse
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Accounts & Fallbacks ---------------------------------------------------

function AccountsSection() {
  const gaps = useSetupGaps();
  const info = useAppState((s) => s.fallbackInfo);
  const prefs = useAppState((s) => s.settings.fallbacks);
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    await refreshFallbacks(true);
    setChecking(false);
  };

  const healthy = (
    h: { installed: boolean; signedIn: boolean | null; problem: string | null } | undefined,
  ) => !!h && h.installed && h.signedIn !== false && !h.problem;

  const codexUsable = !!info && (healthy(info.codex) || info.codex.provenance.ready);

  const openAccountsView = (view?: "keys" | "fallbacks") => {
    closeSettings();
    openSetup(null, view);
  };

  const cliMeta = (
    h:
      | {
          installed: boolean;
          signedIn: boolean | null;
          problem: string | null;
          account: string | null;
        }
      | undefined,
    extraReady?: boolean,
  ) => {
    if (!h) return <Status cls="dot-busy" text="Checking" />;
    if (extraReady || healthy(h)) return <Status cls="dot-ok" text={h.account || "Ready"} />;
    if (!h.installed) return <Status cls="dot-off" text="Not installed" />;
    return <Status cls="dot-err" text={h.problem || "Unavailable"} />;
  };

  return (
    <div className="settings-section">
      <div className="settings-group-head">
        <span className="meta">Logins &amp; API pool</span>
      </div>

      <button type="button" className="settings-link-row" onClick={() => openAccountsView()}>
        <span className="settings-row-text">
          <span className="settings-row-label">Chat site logins</span>
          <span className="meta">ChatGPT, Qwen, Gemini web accounts</span>
        </span>
        {gaps ? (
          <Status
            cls={gaps.sites ? "dot-warn" : "dot-ok"}
            text={gaps.sites ? "Needs login" : "Signed in"}
          />
        ) : null}
        <span className="setup-next" aria-hidden>
          <IconChevron size={13} />
        </span>
      </button>

      <button type="button" className="settings-link-row" onClick={() => openAccountsView("keys")}>
        <span className="settings-row-text">
          <span className="settings-row-label">API keys &amp; token pool</span>
          <span className="meta">Provider API keys for free tiers</span>
        </span>
        {gaps ? (
          <Status
            cls={gaps.keys ? "dot-off" : "dot-ok"}
            text={gaps.keys ? "None added" : "Configured"}
          />
        ) : null}
        <span className="setup-next" aria-hidden>
          <IconChevron size={13} />
        </span>
      </button>

      <div className="settings-group-head settings-group-spaced">
        <span className="meta">Local CLI fallbacks</span>
        <button
          type="button"
          className="icon-btn"
          title="Re-check local CLIs"
          aria-label="Re-check local CLIs"
          disabled={checking}
          onClick={() => void recheck()}
        >
          <IconRefresh size={12} />
        </button>
      </div>

      <label className="settings-row settings-switch-row">
        <span className="settings-row-text">
          <span className="settings-row-label">Claude Code</span>
          {cliMeta(info?.claude)}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={prefs.claude}
          disabled={!prefs.claude && !healthy(info?.claude)}
          onChange={(e) => setFallbackPrefs({ claude: e.target.checked })}
        />
      </label>

      <div className="settings-row settings-row-col">
        <label className="settings-row-top settings-switch-row-inline">
          <span className="settings-row-text">
            <span className="settings-row-label">Codex</span>
            {cliMeta(info?.codex, info?.codex.provenance.ready)}
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={prefs.codex !== "off"}
            disabled={prefs.codex === "off" && !codexUsable}
            onChange={(e) =>
              setFallbackPrefs({
                codex: e.target.checked
                  ? info?.codex.provenance.ready
                    ? "provenance"
                    : "background"
                  : "off",
              })
            }
          />
        </label>
        {prefs.codex !== "off" && info && (
          <div className="settings-sub-row">
            <span className="meta">Run mode</span>
            <div className="settings-seg" role="group" aria-label="Codex run mode">
              <button
                type="button"
                className={prefs.codex === "provenance" ? "active" : ""}
                disabled={!info.codex.provenance.ready}
                onClick={() => setFallbackPrefs({ codex: "provenance" })}
              >
                Through Provenance
              </button>
              <button
                type="button"
                className={prefs.codex === "background" ? "active" : ""}
                disabled={!healthy(info.codex)}
                onClick={() => setFallbackPrefs({ codex: "background" })}
              >
                Background CLI
              </button>
            </div>
          </div>
        )}
      </div>

      <label className="settings-row settings-switch-row">
        <span className="settings-row-text">
          <span className="settings-row-label">Antigravity</span>
          {cliMeta(info?.antigravity)}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={prefs.antigravity}
          disabled={!prefs.antigravity && !healthy(info?.antigravity)}
          onChange={(e) => setFallbackPrefs({ antigravity: e.target.checked })}
        />
      </label>

      <button
        type="button"
        className="settings-link-row settings-more-row"
        onClick={() => openAccountsView("fallbacks")}
      >
        <span className="settings-row-text">
          <span className="meta">Fallback diagnostics &amp; setup instructions</span>
        </span>
        <span className="setup-next" aria-hidden>
          <IconChevron size={13} />
        </span>
      </button>
    </div>
  );
}

// ---- Integrations -----------------------------------------------------------

function IntegrationsSection() {
  const snap = useAppSettings();
  const [clientId, setClientId] = useState(snap?.settings.discordClientId ?? "");

  useEffect(() => {
    setClientId(snap?.settings.discordClientId ?? "");
  }, [snap?.settings.discordClientId]);

  if (!snap) {
    return (
      <div className="settings-section">
        <p className="meta settings-note">
          Discord Rich Presence and desktop integrations are available in the Provenance desktop
          app.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <label className="settings-row settings-switch-row">
        <span className="settings-row-text">
          <span className="settings-row-label">Discord Rich Presence</span>
          <span className="meta">
            Show current tier and working status in Discord. Never shares prompts, files, or paths.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={snap.settings.discordPresence}
          onChange={(e) => void updateDesktopSettings({ discordPresence: e.target.checked })}
        />
      </label>

      <div className="settings-row settings-row-col">
        <div className="settings-row-text">
          <span className="settings-row-label">Custom Discord Application ID</span>
          <span className="meta">Leave blank to use Provenance&apos;s default Discord app</span>
        </div>
        <input
          type="text"
          className="setup-input settings-mono"
          value={clientId}
          placeholder="Default Provenance app"
          spellCheck={false}
          onChange={(e) => setClientId(e.target.value)}
          onBlur={() => {
            if (clientId.trim() !== snap.settings.discordClientId) {
              void updateDesktopSettings({ discordClientId: clientId.trim() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void updateDesktopSettings({ discordClientId: clientId.trim() });
            }
          }}
        />
      </div>
    </div>
  );
}

// ---- Updates ----------------------------------------------------------------

function UpdatesSection() {
  const snap = useAppSettings();
  const state = useUpdateState();

  if (!snap) {
    return (
      <div className="settings-section">
        <p className="meta settings-note">
          Automatic updates are available in the Provenance desktop app.
        </p>
      </div>
    );
  }

  const phase = state?.phase ?? "idle";
  const avail = state?.available;
  const prog = state?.progress;
  const cliTarget =
    snap.platform === "win32"
      ? "%LOCALAPPDATA%\\Provenance\\bin\\provenance.exe"
      : "~/.local/bin/provenance";

  let statusDot = "dot-off";
  let statusText = "Not checked yet";
  if (phase === "checking") {
    statusDot = "dot-busy";
    statusText = "Checking GitHub Releases…";
  } else if (phase === "up-to-date") {
    statusDot = "dot-ok";
    statusText = `Provenance v${snap.version} is up to date`;
  } else if (phase === "available" && avail) {
    statusDot = "dot-update";
    const size = formatBytes(avail.assetSize);
    statusText = `v${avail.version} available${size ? ` · ${size}` : ""}`;
  } else if (phase === "downloading" && avail) {
    statusDot = "dot-busy";
    statusText = `Downloading v${avail.version}… ${prog?.percent ?? 0}%`;
  } else if (phase === "ready" && avail) {
    statusDot = "dot-ok";
    statusText = `v${avail.version} verified and ready to install`;
  } else if (phase === "installing" && avail) {
    statusDot = "dot-busy";
    statusText = `Installing v${avail.version}…`;
  } else if (phase === "error") {
    statusDot = "dot-err";
    statusText = state?.error || "Update check failed";
  }

  return (
    <div className="settings-section">
      <div className="settings-update-head">
        <div className="settings-row-text">
          <span className="settings-row-label">Provenance v{snap.version}</span>
          <Status cls={statusDot} text={statusText} />
          {phase === "downloading" && prog && (
            <div className="settings-progress-wrap">
              <span className="setup-meter settings-meter" aria-hidden>
                <span style={{ width: `${Math.max(4, prog.percent)}%` }} />
              </span>
              <span className="meta">
                {formatBytes(prog.received)}
                {prog.total > 0 ? ` / ${formatBytes(prog.total)}` : ""}
              </span>
            </div>
          )}
        </div>

        <div className="settings-update-actions">
          {phase === "available" ? (
            <button type="button" className="btn btn-primary" onClick={() => void downloadUpdate()}>
              {avail?.installMode === "manual" ? "View release" : "Download"}
            </button>
          ) : phase === "ready" ? (
            <button type="button" className="btn btn-primary" onClick={() => void installUpdate()}>
              Restart to update
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={phase === "checking" || phase === "downloading" || phase === "installing"}
              onClick={() => void checkForUpdates()}
            >
              {phase === "checking" ? "Checking…" : "Check now"}
            </button>
          )}
        </div>
      </div>

      {avail && (
        <div className="settings-release-meta">
          <span className="meta">
            {avail.name}
            {avail.sha256 ? " · SHA-256 verified" : ""}
          </span>
          <a href={avail.releaseUrl} target="_blank" rel="noreferrer" className="settings-ext-link">
            Release notes
            <IconExternal size={11} />
          </a>
        </div>
      )}

      <label className="settings-row settings-switch-row">
        <span className="settings-row-text">
          <span className="settings-row-label">Check for updates automatically</span>
          <span className="meta">Check GitHub Releases on launch and every 6 hours</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={snap.settings.autoCheckUpdates}
          onChange={(e) => void updateDesktopSettings({ autoCheckUpdates: e.target.checked })}
        />
      </label>

      <label className="settings-row settings-switch-row">
        <span className="settings-row-text">
          <span className="settings-row-label">Download updates in background</span>
          <span className="meta">Verify and stage updates automatically before restarting</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={snap.settings.autoDownloadUpdates}
          onChange={(e) => void updateDesktopSettings({ autoDownloadUpdates: e.target.checked })}
        />
      </label>

      <label className="settings-row settings-switch-row">
        <span className="settings-row-text">
          <span className="settings-row-label">Keep standalone CLI synced</span>
          <span className="meta">
            Updates <code>{cliTarget}</code> when installed
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={snap.settings.syncCliOnUpdate}
          onChange={(e) => void updateDesktopSettings({ syncCliOnUpdate: e.target.checked })}
        />
      </label>
    </div>
  );
}

// ---- Advanced ---------------------------------------------------------------

function AdvancedSection() {
  const snap = useAppSettings();
  const [routerUrl, setRouterUrl] = useState(snap?.settings.routerUrl ?? "http://127.0.0.1:4141");
  const [binPath, setBinPath] = useState(snap?.settings.provenanceBin ?? "");
  const [portDraft, setPortDraft] = useState(String(snap?.settings.port ?? 41730));

  useEffect(() => {
    if (!snap) return;
    setRouterUrl(snap.settings.routerUrl);
    setBinPath(snap.settings.provenanceBin);
    setPortDraft(String(snap.settings.port));
  }, [snap]);

  if (!snap) {
    return (
      <div className="settings-section">
        <p className="meta settings-note">
          Router, binary, and local server settings are managed in the Provenance desktop app.
        </p>
      </div>
    );
  }

  const commitPort = () => {
    const n = Number(portDraft.trim());
    if (Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== snap.settings.port) {
      void updateDesktopSettings({ port: n });
    } else {
      setPortDraft(String(snap.settings.port));
    }
  };

  return (
    <div className="settings-section">
      {snap.restartRequired && (
        <div className="settings-restart-strip" role="status">
          <span className="dot dot-warn" />
          <span className="settings-restart-text">Relaunch Provenance to apply these changes.</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void appShell?.relaunch?.()}
          >
            Relaunch
          </button>
        </div>
      )}

      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Model router</span>
          <span className="meta">Bundled provenance-core or external instance</span>
        </div>
        <div className="settings-seg" role="group" aria-label="Model router policy">
          {(["auto", "bundled", "external"] as RouterPolicySetting[]).map((r) => (
            <button
              key={r}
              type="button"
              className={snap.settings.router === r ? "active" : ""}
              aria-pressed={snap.settings.router === r}
              onClick={() => void updateDesktopSettings({ router: r })}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row settings-row-col">
        <div className="settings-row-text">
          <span className="settings-row-label">External router URL</span>
          <span className="meta">Used in Auto (if answering) and External modes</span>
        </div>
        <input
          type="text"
          className="setup-input settings-mono"
          value={routerUrl}
          spellCheck={false}
          onChange={(e) => setRouterUrl(e.target.value)}
          onBlur={() => {
            if (routerUrl.trim() && routerUrl.trim() !== snap.settings.routerUrl) {
              void updateDesktopSettings({ routerUrl: routerUrl.trim() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && routerUrl.trim()) {
              void updateDesktopSettings({ routerUrl: routerUrl.trim() });
            }
          }}
        />
      </div>

      <div className="settings-row settings-row-col">
        <div className="settings-row-text">
          <span className="settings-row-label">Custom provenance binary</span>
          <span className="meta">
            Active: <code>{snap.agentSource}</code>
          </span>
        </div>
        <input
          type="text"
          className="setup-input settings-mono"
          value={binPath}
          placeholder="Auto (bundled or ~/.local/bin/provenance)"
          spellCheck={false}
          onChange={(e) => setBinPath(e.target.value)}
          onBlur={() => {
            if (binPath.trim() !== snap.settings.provenanceBin) {
              void updateDesktopSettings({ provenanceBin: binPath.trim() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void updateDesktopSettings({ provenanceBin: binPath.trim() });
            }
          }}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Local UI port</span>
          <span className="meta">127.0.0.1 loopback server</span>
        </div>
        <input
          type="number"
          className="setup-input setup-input-num"
          min={1024}
          max={65535}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPort();
          }}
        />
      </div>

      <div className="settings-util-bar">
        <button
          type="button"
          className="settings-util-link"
          onClick={() => void appShell?.openPreferences()}
        >
          Open settings.json
        </button>
        <span className="settings-util-sep" aria-hidden>
          ·
        </span>
        <button
          type="button"
          className="settings-util-link"
          onClick={() => void appShell?.openLogs?.()}
        >
          Show logs
        </button>
        <span className="settings-util-sep" aria-hidden>
          ·
        </span>
        <button
          type="button"
          className="settings-util-link"
          onClick={() => {
            closeSettings();
            openWelcome("intro");
          }}
        >
          Welcome guide
        </button>
      </div>
    </div>
  );
}
