import { calculateContextTokens, estimateTokens } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  PendingClientResponse,
  PendingRequest,
  SessionSnapshot,
  SessionSummary,
  SessionWorkerOptions,
} from "./types";
import { contentToPreviewText, shortId } from "./utils";

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

  private readonly options: SessionWorkerOptions<PhoneSessionWorker>;
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

  constructor(options: SessionWorkerOptions<PhoneSessionWorker>, sessionFile: string | null = null) {
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
    this.syncDerivedState();
    this.options.onStateChange();
  }

  private estimateContextTokens(messages: any[]) {
    let lastUsageIndex = -1;
    let usageTokens = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      if (message.stopReason === "aborted" || message.stopReason === "error") continue;
      if (!message.usage) continue;

      usageTokens = calculateContextTokens(message.usage);
      lastUsageIndex = index;
      break;
    }

    if (lastUsageIndex === -1) {
      let estimated = 0;
      for (const message of messages) {
        estimated += estimateTokens(message);
      }
      return estimated;
    }

    let trailingTokens = 0;
    for (let index = lastUsageIndex + 1; index < messages.length; index += 1) {
      trailingTokens += estimateTokens(messages[index]);
    }

    return usageTokens + trailingTokens;
  }

  private buildContextUsage() {
    const contextWindow = Number(this.lastState?.model?.contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      return null;
    }

    let latestCompactionIndex = -1;
    for (let index = this.lastMessages.length - 1; index >= 0; index -= 1) {
      if (this.lastMessages[index]?.role === "compactionSummary") {
        latestCompactionIndex = index;
        break;
      }
    }

    if (latestCompactionIndex !== -1) {
      let hasPostCompactionUsage = false;

      for (let index = this.lastMessages.length - 1; index > latestCompactionIndex; index -= 1) {
        const message = this.lastMessages[index];
        if (message?.role !== "assistant") continue;
        if (message.stopReason === "aborted" || message.stopReason === "error") continue;

        if (message.usage && calculateContextTokens(message.usage) > 0) {
          hasPostCompactionUsage = true;
        }
        break;
      }

      if (!hasPostCompactionUsage) {
        return {
          tokens: null,
          contextWindow,
          percent: null,
        };
      }
    }

    const tokens = this.estimateContextTokens(this.lastMessages);
    return {
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    };
  }

  private syncDerivedState() {
    if (!this.lastState || typeof this.lastState !== "object") return;

    const contextUsage = this.buildContextUsage();
    if (!contextUsage) {
      const { contextUsage: _ignored, ...nextState } = this.lastState;
      this.lastState = nextState;
      return;
    }

    this.lastState = {
      ...this.lastState,
      contextUsage,
    };
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
    this.syncDerivedState();
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

        const normalizedPayload = payload.success && payload.command === "get_state"
          ? { ...payload, data: this.lastState || payload.data }
          : payload;

        const nextPayload = {
          ...normalizedPayload,
          ...(clientMeta.responseCommand ? { command: clientMeta.responseCommand } : {}),
          ...(normalizedPayload.success && clientMeta.responseData
            ? { data: { ...(normalizedPayload.data || {}), ...clientMeta.responseData } }
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
