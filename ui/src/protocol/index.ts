// Single import point for app-server protocol types.
//
// Everything under ./generated is produced by `npm run gen:protocol`
// (`provenance app-server generate-ts`), straight from the Rust definitions in
// codex-rs/app-server-protocol. Don't edit it by hand; regenerate instead.
//
// This file adds the few things ts-rs can't express: a method -> params map
// derived from the generated request/notification unions, and a hand-kept
// method -> response map for the requests the UI actually sends.

import type { ClientRequest, ServerNotification, ServerRequest } from "./generated";
import type * as v2 from "./generated/v2";

export type { ClientRequest, ServerNotification, ServerRequest, v2 };
export type { RequestId } from "./generated";
export type {
  AskForApproval,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  FileUpdateChange,
  Model,
  SandboxMode,
  SandboxPolicy,
  Thread,
  ThreadItem,
  ThreadStatus,
  ThreadTokenUsage,
  Turn,
  TurnError,
  TurnStatus,
  UserInput,
} from "./generated/v2";

export type ClientMethod = ClientRequest["method"];
export type ParamsOf<M extends ClientMethod> = Extract<ClientRequest, { method: M }>["params"];

/** Response types for the requests the UI sends. Add entries as you use more methods. */
export interface ResponseMap {
  "thread/list": v2.ThreadListResponse;
  "thread/start": v2.ThreadStartResponse;
  "thread/resume": v2.ThreadResumeResponse;
  "thread/read": v2.ThreadReadResponse;
  "thread/turns/list": v2.ThreadTurnsListResponse;
  "thread/archive": v2.ThreadArchiveResponse;
  "thread/name/set": v2.ThreadSetNameResponse;
  "project/list": v2.ProjectListResponse;
  "project/move": v2.ProjectMoveResponse;
  "project/delete": v2.ProjectDeleteResponse;
  "turn/start": v2.TurnStartResponse;
  "turn/interrupt": v2.TurnInterruptResponse;
  "model/list": v2.ModelListResponse;
}
export type ResultOf<M extends ClientMethod> = M extends keyof ResponseMap
  ? ResponseMap[M]
  : unknown;

export type NotificationMethod = ServerNotification["method"];
export type NotificationOf<M extends NotificationMethod> = Extract<
  ServerNotification,
  { method: M }
>["params"];

export type ServerRequestMethod = ServerRequest["method"];

/** Pseudo-notification emitted by our Node bridge (server/bridge.ts), not by app-server. */
export type BridgeStatus =
  | { state: "starting"; attempt: number }
  | { state: "ready"; initializeResult: unknown; generation: number }
  | { state: "down"; error: string; retryInMs: number };
