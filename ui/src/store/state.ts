// Shape of the whole UI state. Protocol objects (Thread, ThreadItem, ...) are
// stored as-is from app-server; the "View" types only add what the UI needs on top.

import type { FallbacksInfo } from "../../shared/fallback-api";
import type { SourceNeeds, WireSource } from "../../shared/router-api";
import type { BackendId } from "../fallback/model";
import type {
  AskForApproval,
  BridgeStatus,
  SandboxMode,
  ServerRequest,
  Thread,
  ThreadItem,
  ThreadStatus,
  ThreadTokenUsage,
  TurnError,
  TurnStatus,
  v2,
} from "../protocol";

export interface TurnView {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  durationMs: number | null;
  /** In arrival order (matches app-server's item order). */
  items: ThreadItem[];
  /** Transient `error` notifications (e.g. upstream 503 + retry). */
  errors: { message: string; willRetry: boolean }[];
  /** Latest unified diff for the turn (turn/diff/updated). */
  diff: string | null;
  plan: v2.TurnPlanStep[] | null;
  /** Model this UI started the turn with (unknown for history: use ThreadView.model). */
  model?: string | null;
  /** Unix seconds, from app-server (null while unknown). */
  startedAt?: number | null;
  completedAt?: number | null;
}

/** One concrete model that served requests in a turn (provenance-core's usage ledger). */
export interface ModelUsage {
  model: string;
  tier: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

/** What served a turn: models sorted by requests. Empty when the ledger has nothing for it. */
export interface TurnUsage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  models: ModelUsage[];
  /**
   * What fitting the turn's history into its models took, per flag (provenance-core's
   * context_signal.py: compacted, trimmed, summarised, shortened, restarted, over). Absent from
   * an older router.
   */
  context?: Record<string, number>;
}

export interface ThreadView {
  id: string;
  thread: Thread;
  /** "loading" while resume + history fetch are in flight. */
  load: "loading" | "ready" | "error";
  loadError?: string;
  turns: TurnView[];
  tokenUsage: ThreadTokenUsage | null;
  /** Model/cwd reported by thread/start or thread/resume. */
  model: string | null;
  cwd: string | null;
}

/**
 * One way provenance-core can serve a tier (GET /v1/sources, shared/router-api.ts): the token
 * pool or a web model. Lists come best-first, the order the router uses when nothing is pinned.
 */
export type Source = Pick<
  WireSource,
  "id" | "label" | "kind" | "model" | "busy" | "available" | "pinnable"
> & {
  /** Share (0-1) of today's usage left; null when the router doesn't say. */
  remaining: number | null;
  /** Why it can't serve now: no API keys, or no account signed in. */
  needs: SourceNeeds | null;
};

/** Which fallbacks the user turned on (Models & accounts -> Fallbacks, or the welcome). */
export interface FallbackPrefs {
  claude: boolean;
  /** off; background: the codex CLI runs turns; provenance: Provenance runs them on your Codex login. */
  codex: "off" | "background" | "provenance";
}

export interface Settings {
  model: string;
  cwd: string;
  approvalPolicy: Extract<AskForApproval, string>;
  sandbox: SandboxMode;
  fallbacks: FallbackPrefs;
}

export interface Notice {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface AppState {
  socketOpen: boolean;
  bridge: BridgeStatus | null;
  /** Sidebar list, most recent first. */
  threads: Thread[];
  threadsLoading: boolean;
  views: Record<string, ThreadView>;
  /** null = the "new thread" screen. */
  selectedThreadId: string | null;
  /** Unanswered server->client requests (approvals etc.), all threads. */
  serverRequests: ServerRequest[];
  /** True between pressing send and the turn actually starting. */
  sending: boolean;
  settings: Settings;
  tiers: string[];
  /** Per tier: its sources, best first. Empty when the router doesn't list them. */
  sources: Record<string, Source[]>;
  notices: Notice[];
  /** Per turn id: which models served it (absent = not fetched yet). */
  usage: Record<string, TurnUsage>;
  /** Claude Code / Codex health and models (GET /api/fallbacks); null until checked. */
  fallbackInfo: FallbacksInfo | null;
  /** Which backend each known thread lives on (fallback/model.ts). */
  threadBackend: Record<string, BackendId>;
  /** Per backend: connected and ready. The main one is `bridge` / `socketOpen`. */
  backendReady: Record<BackendId, boolean>;
}

const SETTINGS_KEY = "provenance-ui.settings";

export function loadSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function initialState(): AppState {
  return {
    socketOpen: false,
    bridge: null,
    threads: [],
    threadsLoading: false,
    views: {},
    selectedThreadId: null,
    serverRequests: [],
    sending: false,
    settings: {
      model: "solstice",
      cwd: "",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...loadSettings(),
      fallbacks: { claude: false, codex: "off", ...loadSettings().fallbacks },
    },
    tiers: ["nova", "solstice", "ember", "spark"],
    sources: {},
    notices: [],
    usage: {},
    fallbackInfo: null,
    threadBackend: {},
    backendReady: { main: false, codex: false, fallback: false },
  };
}

export function isThreadActive(status: ThreadStatus | undefined): boolean {
  return status?.type === "active";
}
