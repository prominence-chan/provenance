// The one picture on each sign-in step: Provenance's window with the sign-in window beside
// it, drawn the way the step stands (the browser downloading, the window open on the site,
// the window gone while the site is checked, a failure, ready). Theme colours only.

export type ArtKind = "download" | "open" | "verifying" | "failed" | "ready";

export function SetupArt({ kind, host }: { kind: ArtKind; host: string }) {
  const showBrowser = kind !== "ready";
  const browserDim = kind === "verifying" || kind === "download";
  return (
    <svg
      className={`setup-art setup-art-${kind}`}
      viewBox="0 0 260 128"
      width="260"
      height="128"
      aria-hidden
    >
      {/* Provenance's window: sidebar, two lines of transcript, the composer */}
      <g className="art-app">
        <rect x="8" y="14" width="150" height="104" rx="9" className="art-frame" />
        <rect x="8" y="14" width="40" height="104" rx="9" className="art-side" />
        <rect x="38" y="14" width="10" height="104" className="art-side" />
        <circle cx="19" cy="24" r="2.2" className="art-dot" />
        <circle cx="26" cy="24" r="2.2" className="art-dot" />
        <circle cx="33" cy="24" r="2.2" className="art-dot" />
        <rect x="15" y="38" width="26" height="4" rx="2" className="art-line" />
        <rect x="15" y="48" width="20" height="4" rx="2" className="art-line" />
        <rect x="15" y="58" width="23" height="4" rx="2" className="art-line" />
        {kind !== "ready" && <circle cx="103" cy="52" r="11" className="art-sun" />}
        <rect x="62" y="96" width="82" height="12" rx="6" className="art-composer" />
        {kind === "ready" && (
          <g className="art-ok">
            <circle cx="103" cy="52" r="15" />
            <path d="M96 52.5l5 5 9-10" />
          </g>
        )}
        {kind === "verifying" && <circle cx="103" cy="52" r="15" className="art-checking" />}
      </g>
      {showBrowser && (
        <g className={`art-browser ${browserDim ? "dim" : ""}`}>
          <rect x="132" y="26" width="120" height="96" rx="9" className="art-frame art-raised" />
          <path d="M132 35a9 9 0 0 1 9-9h102a9 9 0 0 1 9 9v7h-120z" className="art-chrome" />
          <rect x="140" y="31" width="84" height="9" rx="4" className="art-tab" />
          <text x="145" y="38.2" className="art-host">
            {host.length > 21 ? `${host.slice(0, 20)}…` : host}
          </text>
          {kind === "download" ? (
            <g className="art-download">
              <path d="M192 60v26M181 76l11 11 11-11" />
              <rect x="160" y="100" width="64" height="5" rx="2.5" className="art-line" />
            </g>
          ) : (
            <g className="art-form">
              <rect x="164" y="56" width="56" height="9" rx="4" className="art-field" />
              <rect x="164" y="71" width="56" height="9" rx="4" className="art-field" />
              <rect x="174" y="88" width="36" height="11" rx="5.5" className="art-button" />
            </g>
          )}
          {kind === "failed" && (
            <g className="art-bad">
              <circle cx="240" cy="30" r="10" />
              <path d="M240 24.5v6.5M240 35v.5" />
            </g>
          )}
        </g>
      )}
    </svg>
  );
}
