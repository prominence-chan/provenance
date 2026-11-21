// Typed JSON-RPC client over the bridge WebSocket (/rpc).
//
// The wire format is exactly app-server's: {id, method, params} requests,
// {id, result | error} responses, {method, params} notifications, and
// {id, method, params} server->client requests (approvals). The bridge keeps
// ids per-connection, so this client can number its requests from 1.

import type {
  BridgeStatus,
  ClientMethod,
  ParamsOf,
  RequestId,
  ResultOf,
  ServerNotification,
  ServerRequest,
} from "../protocol";

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string };

export interface RpcHandlers {
  onNotification: (n: ServerNotification) => void;
  onServerRequest: (r: ServerRequest) => void;
  onBridgeStatus: (s: BridgeStatus) => void;
  onSocketState: (open: boolean) => void;
}

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, Pending>();
  private handlers: RpcHandlers;
  private url: string;
  private closed = false;

  constructor(handlers: RpcHandlers, url = defaultUrl()) {
    this.handlers = handlers;
    this.url = url;
  }

  connect(): void {
    this.closed = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.handlers.onSocketState(true);
    ws.onclose = () => {
      this.handlers.onSocketState(false);
      for (const p of this.pending.values()) p.reject(new RpcError(-1, "connection closed"));
      this.pending.clear();
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new RpcError(-1, "not connected"));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Answer a server->client request (e.g. an approval). */
  respond(id: RequestId, result: unknown): void {
    this.ws?.send(JSON.stringify({ id, result }));
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.ws?.send(JSON.stringify({ id, error: { code, message } }));
  }

  private onMessage(msg: {
    id?: RequestId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && !msg.method) {
      const p = this.pending.get(msg.id!);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error)
        p.reject(new RpcError(msg.error.code, `${p.method}: ${msg.error.message}`, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "bridge/status") {
      this.handlers.onBridgeStatus(msg.params as BridgeStatus);
      return;
    }
    if (hasId) this.handlers.onServerRequest(msg as ServerRequest);
    else this.handlers.onNotification(msg as ServerNotification);
  }
}

function defaultUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/rpc`;
}
