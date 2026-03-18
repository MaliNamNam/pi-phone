import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { WebSocket } from "ws";

export type SessionSummary = {
  id: string;
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  label: string;
  secondaryLabel: string;
  firstUserPreview: string | null;
  lastUserPreview: string | null;
  model: { id: string; name: string; provider: string } | null;
  isRunning: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingMessageCount: number;
  hasPendingUiRequest: boolean;
  lastError: string;
  lastActivityAt: number;
  childPid: number | null;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingClientResponse = {
  ws: WebSocket;
  responseCommand?: string;
  responseData?: Record<string, unknown>;
  onSuccess?: (payload: any) => void;
  onError?: (payload: any) => void;
};

type SessionSnapshot = {
  state: any;
  messages: any[];
  commands: any[];
  liveAssistantMessage: any;
  liveTools: any[];
};

type ClientState = {
  activeSessionId: string | null;
};

type SessionWorkerOptions = {
  cwd: string;
  send: (ws: WebSocket, payload: unknown) => void;
  onActivity: () => void;
  onStateChange: () => void;
  onEnvelope: (worker: PhoneSessionWorker, envelope: any) => void;
  shouldAutoRestart: (worker: PhoneSessionWorker) => boolean;
};

type PhoneSessionPoolOptions = {
  cwd: string;
  send: (ws: WebSocket, payload: unknown) => void;
  onActivity: () => void;
  buildStatusMeta: () => Record<string, unknown>;
};

function contentToPreviewText(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: any) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image") return "[image]";
      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortId(value: unknown): string {
  return String(value || "").trim().slice(0, 8);
}

let workerCounter = 0;

export class PhoneSessionWorker {
  id = `active-session-${++workerCounter}`;
  cwd: string;
  previousCwd: string | null = null;
  currentSessionFile: string | null;
  child: ChildProcessWithoutNullStreams | null = null;
  lastError = "";
  lastState: any = null;
  lastMessages: any[] = [];
  lastCommands: any[] = [];
  isStreaming = false;
  lastActivityAt = Date.now();
  pendingUiRequest: any = null;
  liveAssistantMessage: any = null;
  liveTools = new Map<string, any>();

  private readonly options: SessionWorkerOptions;
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private startPromise: Promise<void> | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingClientResponses = new Map<string, PendingClientResponse>();
  private snapshotRefreshTimer: NodeJS.Timeout | null = null;
  private reloadPromise: Promise<void> | null = null;
  private isRestarting = false;
  private disposed = false;
  private firstUserPreview = "";
  private lastUserPreview = "";

  constructor(options: SessionWorkerOptions, sessionFile: string | null = null) {
    this.options = options;
    this.cwd = options.cwd;
    this.currentSessionFile = sessionFile;
  }

  private touch() {
    this.lastActivityAt = Date.now();
    this.options.onActivity();
    this.options.onStateChange();
  }

  private updateMessagePreviews() {
    const firstUser = this.lastMessages.find((message) => message?.role === "user");
    const lastUser = [...this.lastMessages].reverse().find((message) => message?.role === "user");
    this.firstUserPreview = firstUser ? contentToPreviewText(firstUser.content) : "";
    this.lastUserPreview = lastUser ? contentToPreviewText(lastUser.content) : "";
  }

  private setMessages(messages: any[]) {
    this.lastMessages = Array.isArray(messages) ? messages : [];
    this.updateMessagePreviews();
    this.options.onStateChange();
  }

  private rememberState(state: any) {
    if (!state || typeof state !== "object") return;
    this.lastState = state;
    if (typeof state.isStreaming === "boolean") {
      this.isStreaming = state.isStreaming;
    }
    if (typeof state.sessionFile === "string" && state.sessionFile.trim()) {
      this.currentSessionFile = state.sessionFile;
    }
    this.options.onStateChange();
  }

  private buildSpawnArgs(sessionFile = this.currentSessionFile) {
    const args = ["--mode", "rpc"];
    if (sessionFile) {
      args.push("--session", sessionFile);
    }
    return args;
  }

  getStatus() {
    return {
      childRunning: Boolean(this.child),
      cwd: this.cwd,
      previousCwd: this.previousCwd,
      isStreaming: this.isStreaming,
      lastError: this.lastError,
      childPid: this.child?.pid ?? null,
      sessionWorkerId: this.id,
    };
  }

  setTrackedCwd(cwd: string, previousCwd: string | null = this.cwd) {
    this.previousCwd = previousCwd;
    this.cwd = cwd;
    this.options.onStateChange();
  }

  getSummary(): SessionSummary {
    const sessionId = this.lastState?.sessionId || null;
    const sessionName = this.lastState?.sessionName || null;
    const label = sessionName || this.firstUserPreview || (sessionId ? `Session ${shortId(sessionId)}` : `Session ${shortId(this.id)}`);
    const secondaryLabel = sessionName ? this.firstUserPreview || shortId(sessionId) || "" : shortId(sessionId) || "";

    return {
      id: this.id,
      sessionId,
      sessionFile: this.currentSessionFile || this.lastState?.sessionFile || null,
      sessionName,
      label,
      secondaryLabel,
      firstUserPreview: this.firstUserPreview || null,
      lastUserPreview: this.lastUserPreview || null,
      model: this.lastState?.model
        ? {
            id: this.lastState.model.id,
            name: this.lastState.model.name,
            provider: this.lastState.model.provider,
          }
        : null,
      isRunning: Boolean(this.child),
      isStreaming: this.isStreaming,
      isCompacting: Boolean(this.lastState?.isCompacting),
      messageCount: this.lastState?.messageCount ?? this.lastMessages.length,
      pendingMessageCount: this.lastState?.pendingMessageCount ?? 0,
      hasPendingUiRequest: Boolean(this.pendingUiRequest),
      lastError: this.lastError,
      lastActivityAt: this.lastActivityAt,
      childPid: this.child?.pid ?? null,
    };
  }

  private cachedSnapshot(): SessionSnapshot {
    return {
      state: this.lastState,
      messages: this.lastMessages,
      commands: this.lastCommands,
      liveAssistantMessage: this.liveAssistantMessage,
      liveTools: [...this.liveTools.values()],
    };
  }

  getCachedSnapshot(): SessionSnapshot {
    return this.cachedSnapshot();
  }

  async ensureStarted(startOptions: { sessionFile?: string | null } = {}) {
    if (this.disposed) {
      throw new Error("Session worker disposed.");
    }

    if (this.child) return;
    if (this.startPromise) return this.startPromise;

    const sessionFile = startOptions.sessionFile ?? this.currentSessionFile;
    this.stdoutBuffer = "";

    this.startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const spawned = spawn("pi", this.buildSpawnArgs(sessionFile), {
        cwd: this.cwd,
        env: {
          ...process.env,
          PI_PHONE_CHILD: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;

      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        this.lastError = error.message;
        this.child = null;
        this.options.onStateChange();
        rejectPromise(error);
      };

      spawned.once("error", (error) => {
        failStart(error instanceof Error ? error : new Error(String(error)));
      });

      spawned.stdout.on("data", (chunk) => {
        this.handleStdoutChunk(chunk);
      });

      spawned.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        this.lastError = text.trim() || this.lastError;
        this.options.onEnvelope(this, { channel: "server", event: "stderr", data: { text } });
        this.touch();
      });

      spawned.once("exit", (code, signal) => {
        const message = `pi rpc exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`;
        const restarting = this.isRestarting;

        if (!settled) {
          failStart(new Error(message));
          return;
        }

        this.child = null;
        this.isStreaming = false;
        this.lastState = this.lastState ? { ...this.lastState, isStreaming: false } : this.lastState;
        this.pendingUiRequest = null;
        this.liveAssistantMessage = null;
        this.liveTools.clear();
        this.rejectAllPending(new Error(restarting ? "Pi rpc is reloading." : message));

        if (restarting || this.disposed) {
          this.lastError = "";
          this.options.onStateChange();
          return;
        }

        this.lastError = message;
        this.options.onEnvelope(this, { channel: "server", event: "agent-exit", data: { code, signal, message } });
        this.touch();

        if (this.options.shouldAutoRestart(this)) {
          setTimeout(() => {
            if (this.disposed) return;
            this.ensureStarted({ sessionFile: this.currentSessionFile })
              .then(() => this.refreshCachedSnapshot().catch(() => {}))
              .catch((error) => {
                this.lastError = error instanceof Error ? error.message : String(error);
                this.options.onStateChange();
              });
          }, 1500);
        }
      });

      this.child = spawned;
      this.lastError = "";
      this.touch();

      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolvePromise();
      }, 300);
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const [id, meta] of this.pendingClientResponses.entries()) {
      this.options.send(meta.ws, {
        channel: "rpc",
        payload: {
          type: "response",
          id,
          command: meta.responseCommand || "unknown",
          success: false,
          error: error.message,
        },
      });
    }
    this.pendingClientResponses.clear();
  }

  private handleStdoutChunk(chunk: Buffer | string) {
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.length) continue;
      this.handleRpcLine(line);
    }
  }

  private scheduleSnapshotRefresh(delayMs = 80) {
    if (this.snapshotRefreshTimer || this.disposed) return;

    this.snapshotRefreshTimer = setTimeout(() => {
      this.snapshotRefreshTimer = null;
      this.refreshCachedSnapshot().catch(() => {});
    }, delayMs);
  }

  private handleRpcLine(line: string) {
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      this.lastError = `Failed to parse child rpc output: ${line.slice(0, 200)}`;
      this.options.onEnvelope(this, { channel: "server", event: "parse-error", data: { line, error: String(error) } });
      this.touch();
      return;
    }

    this.touch();

    if (payload.type === "response" && typeof payload.id === "string") {
      if (payload.success && payload.command === "get_state") {
        this.rememberState(payload.data);
      }

      if (payload.success && payload.command === "get_messages") {
        this.setMessages(payload.data?.messages || []);
      }

      if (payload.success && payload.command === "get_commands") {
        this.lastCommands = payload.data?.commands || [];
        this.options.onStateChange();
      }

      const pending = this.pendingRequests.get(payload.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(payload.id);
        pending.resolve(payload);
      }

      const clientMeta = this.pendingClientResponses.get(payload.id);
      if (clientMeta) {
        this.pendingClientResponses.delete(payload.id);

        try {
          if (payload.success) clientMeta.onSuccess?.(payload);
          else clientMeta.onError?.(payload);
        } catch {
          // Ignore local response side effects and still forward the payload.
        }

        const nextPayload = {
          ...payload,
          ...(clientMeta.responseCommand ? { command: clientMeta.responseCommand } : {}),
          ...(payload.success && clientMeta.responseData
            ? { data: { ...(payload.data || {}), ...clientMeta.responseData } }
            : {}),
        };
        this.options.send(clientMeta.ws, { channel: "rpc", payload: nextPayload });
      }

      if (payload.success && !payload.data?.cancelled && ["new_session", "switch_session", "set_session_name", "reload"].includes(payload.command)) {
        this.pendingUiRequest = null;
        this.liveAssistantMessage = null;
        this.liveTools.clear();
        this.scheduleSnapshotRefresh(40);
      }

      return;
    }

    if (payload.type === "agent_start") {
      this.isStreaming = true;
      this.lastState = this.lastState ? { ...this.lastState, isStreaming: true } : this.lastState;
      this.options.onStateChange();
    }

    if (payload.type === "agent_end") {
      this.isStreaming = false;
      this.lastState = this.lastState ? { ...this.lastState, isStreaming: false } : this.lastState;
      this.liveAssistantMessage = null;
      this.liveTools.clear();
      this.options.onStateChange();
      this.scheduleSnapshotRefresh(30);
    }

    if (payload.type === "message_start" && payload.message?.role === "assistant") {
      this.liveAssistantMessage = payload.message;
      this.options.onStateChange();
    }

    if (payload.type === "message_update" && payload.message?.role === "assistant") {
      this.liveAssistantMessage = payload.message;
      this.options.onStateChange();
    }

    if (payload.type === "message_end" && payload.message?.role === "assistant") {
      this.liveAssistantMessage = null;
      this.options.onStateChange();
    }

    if (payload.type === "tool_execution_start") {
      this.liveTools.set(payload.toolCallId, {
        toolCallId: payload.toolCallId,
        toolName: payload.toolName || "tool",
        args: payload.args || {},
        partialResult: null,
        result: null,
        isError: false,
      });
      this.options.onStateChange();
    }

    if (payload.type === "tool_execution_update") {
      const current = this.liveTools.get(payload.toolCallId) || {};
      this.liveTools.set(payload.toolCallId, {
        ...current,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName || current.toolName || "tool",
        args: payload.args || current.args || {},
        partialResult: payload.partialResult || current.partialResult || null,
        result: current.result || null,
        isError: current.isError || false,
      });
      this.options.onStateChange();
    }

    if (payload.type === "tool_execution_end") {
      const current = this.liveTools.get(payload.toolCallId) || {};
      this.liveTools.set(payload.toolCallId, {
        ...current,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName || current.toolName || "tool",
        args: payload.args || current.args || {},
        partialResult: current.partialResult || null,
        result: payload.result || null,
        isError: Boolean(payload.isError),
      });
      this.options.onStateChange();
    }

    if (payload.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(payload.method)) {
      this.pendingUiRequest = payload;
      this.options.onStateChange();
    }

    this.options.onEnvelope(this, { channel: "rpc", payload });
  }

  async request(command: Record<string, unknown>, timeoutMs = 30000) {
    await this.ensureStarted();
    if (!this.child) throw new Error("pi rpc child is not running");

    const id = `srv-${++this.requestCounter}`;
    const payload = { ...command, id };

    return new Promise<any>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectPromise(new Error(`Timed out waiting for child response to ${String(command.type)}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });

      this.child!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async refreshCachedSnapshot(timeoutMs = 4500): Promise<SessionSnapshot> {
    await this.ensureStarted();

    const [stateResponse, messagesResponse, commandsResponse] = await Promise.all([
      this.request({ type: "get_state" }, timeoutMs),
      this.request({ type: "get_messages" }, timeoutMs),
      this.request({ type: "get_commands" }, timeoutMs),
    ]);

    if (stateResponse?.success) {
      this.rememberState(stateResponse.data || null);
    }

    if (messagesResponse?.success) {
      this.setMessages(messagesResponse.data?.messages || []);
    }

    if (commandsResponse?.success) {
      this.lastCommands = commandsResponse.data?.commands || [];
      this.options.onStateChange();
    }

    return this.cachedSnapshot();
  }

  async getSnapshot(): Promise<SessionSnapshot> {
    const hasCache = Boolean(this.lastState) || this.lastMessages.length > 0 || this.lastCommands.length > 0;

    if (this.isStreaming || this.pendingUiRequest) {
      if (hasCache) {
        return this.cachedSnapshot();
      }

      try {
        return await this.refreshCachedSnapshot(2500);
      } catch {
        return this.cachedSnapshot();
      }
    }

    try {
      return await this.refreshCachedSnapshot(4500);
    } catch (error) {
      if (hasCache || this.pendingUiRequest) {
        return this.cachedSnapshot();
      }
      throw error;
    }
  }

  async sendClientCommand(command: Record<string, unknown>, meta?: PendingClientResponse) {
    await this.ensureStarted();
    if (!this.child) throw new Error("pi rpc child is not running");

    const nextCommand = { ...command } as Record<string, any>;

    if (nextCommand.type === "extension_ui_response") {
      this.pendingUiRequest = null;
      this.options.onStateChange();
    } else if (!nextCommand.id) {
      nextCommand.id = `cli-${++this.requestCounter}`;
    }

    if (nextCommand.type !== "extension_ui_response" && nextCommand.id && meta?.ws) {
      this.pendingClientResponses.set(String(nextCommand.id), meta);
    }

    this.touch();
    this.child.stdin.write(`${JSON.stringify(nextCommand)}\n`);
    return nextCommand.id as string | undefined;
  }

  private async stopChildForRestart() {
    const runningChild = this.child;
    if (!runningChild) return;

    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        resolvePromise();
      };

      const forceKillTimer = setTimeout(() => {
        try {
          runningChild.kill("SIGKILL");
        } catch {
          finish();
        }
      }, 2000);

      runningChild.once("exit", finish);

      try {
        runningChild.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  async reload() {
    if (this.reloadPromise) return this.reloadPromise;

    this.reloadPromise = (async () => {
      await this.ensureStarted();

      const stateResponse = await this.request({ type: "get_state" });
      if (!stateResponse?.success) {
        throw new Error(stateResponse?.error || "Failed to read Pi state before reload.");
      }

      const nextState = stateResponse.data || {};
      this.rememberState(nextState);

      if (nextState.isStreaming) {
        throw new Error("Wait for the current response to finish before reloading.");
      }

      if (nextState.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }

      this.isRestarting = true;
      this.options.onEnvelope(this, {
        channel: "server",
        event: "reloading",
        data: { message: "Reloading extensions, skills, prompts, and themes…" },
      });

      await this.stopChildForRestart();
      await this.ensureStarted({ sessionFile: this.currentSessionFile });
      await this.refreshCachedSnapshot(5000);
    })().finally(() => {
      this.isRestarting = false;
      this.options.onEnvelope(this, { channel: "server", event: "reloading", data: { message: "" } });
      this.reloadPromise = null;
    });

    return this.reloadPromise;
  }

  async dispose() {
    this.disposed = true;
    if (this.snapshotRefreshTimer) {
      clearTimeout(this.snapshotRefreshTimer);
      this.snapshotRefreshTimer = null;
    }
    this.rejectAllPending(new Error("pi phone session stopped"));
    await this.stopChildForRestart();
    this.child = null;
    this.isStreaming = false;
    this.pendingUiRequest = null;
    this.liveAssistantMessage = null;
    this.liveTools.clear();
    this.options.onStateChange();
  }
}

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
