// Shape of the whole UI state. Protocol objects (Thread, ThreadItem, ...) are
// stored as-is from app-server; the "View" types only add what the UI needs on top.

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

export interface Settings {
  model: string;
  cwd: string;
  approvalPolicy: Extract<AskForApproval, string>;
  sandbox: SandboxMode;
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
  notices: Notice[];
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
    },
    tiers: ["nova", "solstice", "spark", "ember"],
    notices: [],
  };
}

export function isThreadActive(status: ThreadStatus | undefined): boolean {
  return status?.type === "active";
}
