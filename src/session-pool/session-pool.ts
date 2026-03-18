import type { WebSocket } from "ws";
import { PhoneSessionWorker } from "./session-worker";
import type { ClientState, PhoneSessionPoolOptions, SessionSnapshot, SessionSummary } from "./types";

export class PhoneSessionPool {
  private readonly options: PhoneSessionPoolOptions;
  private readonly workers = new Map<string, PhoneSessionWorker>();
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly statusSignatures = new Map<WebSocket, string>();
  private readonly catalogSignatures = new Map<WebSocket, string>();
  private defaultWorkerId: string | null = null;
  private defaultWorkerPromise: Promise<PhoneSessionWorker> | null = null;

  constructor(options: PhoneSessionPoolOptions) {
    this.options = options;
  }

  setCwd(cwd: string) {
    this.options.cwd = cwd;
    this.broadcastStatus();
  }

  get clientCount() {
    return this.clients.size;
  }

  getClients() {
    return [...this.clients.keys()];
  }

  private createWorker(sessionFile: string | null = null) {
    let worker: PhoneSessionWorker;

    worker = new PhoneSessionWorker(
      {
        cwd: this.options.cwd,
        send: this.options.send,
        onActivity: this.options.onActivity,
        onStateChange: () => {
          this.handleWorkerStateChange(worker);
        },
        onEnvelope: (currentWorker, envelope) => {
          this.forwardEnvelope(currentWorker, envelope);
        },
        shouldAutoRestart: (currentWorker) => this.clients.size > 0 && this.workers.has(currentWorker.id),
      },
      sessionFile,
    );

    return worker;
  }

  private sortedWorkers() {
    return [...this.workers.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  private serializeSessions() {
    return this.sortedWorkers().map((worker) => worker.getSummary());
  }

  async ensureDefaultWorker() {
    const existing = this.defaultWorkerId ? this.workers.get(this.defaultWorkerId) : this.sortedWorkers()[0];
    if (existing) {
      this.defaultWorkerId = existing.id;
      return existing;
    }

    if (this.defaultWorkerPromise) {
      return this.defaultWorkerPromise;
    }

    this.defaultWorkerPromise = (async () => {
      const worker = this.createWorker();
      this.workers.set(worker.id, worker);
      this.defaultWorkerId = worker.id;

      try {
        await worker.ensureStarted();
        await worker.refreshCachedSnapshot(5000).catch(() => {});
        this.broadcastCatalog();
        this.broadcastStatus();
        return worker;
      } catch (error) {
        this.workers.delete(worker.id);
        if (this.defaultWorkerId === worker.id) {
          this.defaultWorkerId = null;
        }
        throw error;
      }
    })().finally(() => {
      this.defaultWorkerPromise = null;
    });

    return this.defaultWorkerPromise;
  }

  private async getWorkerForClient(ws: WebSocket) {
    const client = this.clients.get(ws);
    if (!client) {
      const worker = await this.ensureDefaultWorker();
      this.clients.set(ws, { activeSessionId: worker.id });
      return worker;
    }

    const activeWorker = client.activeSessionId ? this.workers.get(client.activeSessionId) : null;
    if (activeWorker) {
      return activeWorker;
    }

    const fallback = await this.ensureDefaultWorker();
    client.activeSessionId = fallback.id;
    return fallback;
  }

  async getActiveWorker(ws: WebSocket) {
    return this.getWorkerForClient(ws);
  }

  private buildBaseStatus() {
    const meta = this.options.buildStatusMeta();
    return {
      ...meta,
      connectedClients: this.clients.size,
      sessionCount: this.workers.size,
      isRunning: Boolean((meta as any).serverRunning),
    };
  }

  private normalizeStatusSignature(status: Record<string, unknown>) {
    const { lastActivityAt: _ignored, ...rest } = status;
    return JSON.stringify(rest);
  }

  private normalizeCatalogSignature(data: { activeSessionId: string | null; sessions: SessionSummary[] }) {
    return JSON.stringify({
      activeSessionId: data.activeSessionId,
      sessions: data.sessions.map(({ lastActivityAt: _ignored, ...session }) => session),
    });
  }

  private handleWorkerStateChange(_worker: PhoneSessionWorker) {
    this.broadcastCatalog();
    this.broadcastStatus();
  }

  buildOverallStatus() {
    const worker = this.defaultWorkerId ? this.workers.get(this.defaultWorkerId) : this.sortedWorkers()[0] || null;
    return {
      ...this.buildBaseStatus(),
      ...(worker ? worker.getStatus() : { childRunning: false, isStreaming: false, lastError: "", childPid: null, sessionWorkerId: null }),
    };
  }

  private buildClientStatus(ws: WebSocket) {
    const client = this.clients.get(ws);
    const worker = client?.activeSessionId ? this.workers.get(client.activeSessionId) : null;
    return {
      ...this.buildBaseStatus(),
      ...(worker ? worker.getStatus() : { childRunning: false, isStreaming: false, lastError: "", childPid: null, sessionWorkerId: null }),
      activeSessionId: client?.activeSessionId || null,
    };
  }

  private sendStatus(ws: WebSocket, options: { force?: boolean } = {}) {
    const data = this.buildClientStatus(ws);
    const signature = this.normalizeStatusSignature(data);
    if (!options.force && this.statusSignatures.get(ws) === signature) {
      return;
    }

    this.statusSignatures.set(ws, signature);
    this.options.send(ws, { channel: "server", event: "status", data });
  }

  private sendSnapshot(ws: WebSocket, worker: PhoneSessionWorker, snapshot: SessionSnapshot) {
    this.options.send(ws, {
      channel: "snapshot",
      sessionWorkerId: worker.id,
      state: snapshot.state,
      messages: snapshot.messages || [],
      commands: snapshot.commands || [],
      liveAssistantMessage: snapshot.liveAssistantMessage || null,
      liveTools: snapshot.liveTools || [],
    });
  }

  broadcastStatus() {
    for (const ws of this.clients.keys()) {
      this.sendStatus(ws);
    }
  }

  sendCatalog(ws: WebSocket, options: { force?: boolean } = {}) {
    const client = this.clients.get(ws);
    const data = {
      activeSessionId: client?.activeSessionId || null,
      sessions: this.serializeSessions(),
    };
    const signature = this.normalizeCatalogSignature(data);
    if (!options.force && this.catalogSignatures.get(ws) === signature) {
      return;
    }

    this.catalogSignatures.set(ws, signature);
    this.options.send(ws, {
      channel: "sessions",
      event: "catalog",
      data,
    });
  }

  broadcastCatalog() {
    for (const ws of this.clients.keys()) {
      this.sendCatalog(ws);
    }
  }

  private forwardEnvelope(worker: PhoneSessionWorker, envelope: any) {
    for (const [ws, client] of this.clients.entries()) {
      if (client.activeSessionId === worker.id) {
        this.options.send(ws, envelope);
      }
    }
  }

  async addClient(ws: WebSocket) {
    const worker = await this.ensureDefaultWorker();
    this.clients.set(ws, { activeSessionId: worker.id });
    this.sendStatus(ws, { force: true });
    this.sendCatalog(ws, { force: true });
    await this.refreshActiveSnapshot(ws);
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
    this.statusSignatures.delete(ws);
    this.catalogSignatures.delete(ws);
    this.broadcastStatus();
  }

  async refreshActiveSnapshot(ws: WebSocket) {
    const worker = await this.getWorkerForClient(ws);
    const requestedWorkerId = worker.id;

    try {
      const snapshot = await worker.getSnapshot();
      const client = this.clients.get(ws);
      if (client?.activeSessionId !== requestedWorkerId) {
        return;
      }

      this.sendSnapshot(ws, worker, snapshot);
      this.sendStatus(ws);
      if (worker.pendingUiRequest) {
        this.options.send(ws, { channel: "rpc", payload: worker.pendingUiRequest });
      }
    } catch (error) {
      const client = this.clients.get(ws);
      if (client?.activeSessionId !== requestedWorkerId) {
        return;
      }

      this.options.send(ws, {
        channel: "server",
        event: "snapshot-error",
        data: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async broadcastSnapshots() {
    await Promise.all(this.getClients().map(async (ws) => this.refreshActiveSnapshot(ws)));
  }

  async selectSession(ws: WebSocket, sessionId: string) {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      this.options.send(ws, { channel: "server", event: "client-error", data: { message: "That active session no longer exists." } });
      return;
    }

    const client = this.clients.get(ws);
    if (!client) {
      this.clients.set(ws, { activeSessionId: sessionId });
    } else {
      client.activeSessionId = sessionId;
    }

    this.defaultWorkerId = worker.id;

    this.sendCatalog(ws, { force: true });
    this.sendStatus(ws, { force: true });
    this.sendSnapshot(ws, worker, worker.getCachedSnapshot());
    await this.refreshActiveSnapshot(ws);
  }

  async spawnSession(ws: WebSocket) {
    const worker = this.createWorker();
    let added = false;
    const existingClient = this.clients.get(ws);
    const previousActiveSessionId = existingClient?.activeSessionId || null;

    try {
      this.workers.set(worker.id, worker);
      added = true;
      this.defaultWorkerId = worker.id;

      if (existingClient) {
        existingClient.activeSessionId = worker.id;
      } else {
        this.clients.set(ws, { activeSessionId: worker.id });
      }

      this.sendCatalog(ws, { force: true });
      this.sendStatus(ws, { force: true });
      this.sendSnapshot(ws, worker, worker.getCachedSnapshot());

      await worker.ensureStarted();
      await worker.refreshCachedSnapshot(5000).catch(() => {});
      this.broadcastCatalog();
      this.broadcastStatus();
      await this.refreshActiveSnapshot(ws);
    } catch (error) {
      if (added) {
        this.workers.delete(worker.id);
      }
      const fallbackWorker = previousActiveSessionId ? this.workers.get(previousActiveSessionId) : this.sortedWorkers()[0] || null;
      if (this.defaultWorkerId === worker.id) {
        this.defaultWorkerId = fallbackWorker?.id || null;
      }

      const client = this.clients.get(ws);
      if (client) {
        client.activeSessionId = fallbackWorker?.id || null;
      }

      await worker.dispose().catch(() => {});
      this.sendCatalog(ws, { force: true });
      this.sendStatus(ws, { force: true });
      if (fallbackWorker) {
        this.sendSnapshot(ws, fallbackWorker, fallbackWorker.getCachedSnapshot());
        await this.refreshActiveSnapshot(ws).catch(() => {});
      }
      this.broadcastCatalog();
      this.broadcastStatus();
      throw error;
    }
  }

  async closeAllClients(options: { payload?: unknown; code?: number; reason?: string } = {}) {
    const { payload, code = 1000, reason = "closing" } = options;
    const sockets = this.getClients();
    this.clients.clear();
    this.statusSignatures.clear();
    this.catalogSignatures.clear();

    for (const ws of sockets) {
      if (payload) {
        this.options.send(ws, payload);
      }
      try {
        ws.close(code, reason);
      } catch {
        // ignore
      }
    }
  }

  async dispose() {
    await this.closeAllClients();
    await Promise.all([...this.workers.values()].map(async (worker) => worker.dispose().catch(() => {})));
    this.workers.clear();
    this.defaultWorkerId = null;
    this.defaultWorkerPromise = null;
  }
}
