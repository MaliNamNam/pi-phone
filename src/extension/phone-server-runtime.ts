import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageEndEvent,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parsePhoneStartArgs } from "./phone-args";
import { listPhonePathSuggestions, resolvePhoneCdTargetPath } from "./phone-paths";
import { getQuotaForModel } from "./phone-quota";
import {
  isLoopbackAddress,
  phoneControlStopPath,
  readPersistedRuntimeState,
  removePersistedRuntimeState,
  stopPersistedRuntime,
  writePersistedRuntimeState,
} from "./phone-runtime";

import { mimeTypes, publicFilePath, sanitizePublicPath } from "./phone-static";
import { disableCloudflareTunnel, enableCloudflareTunnel, getCloudflareTunnelInfo } from "./phone-cloudflare";
import { sendPushoverNotification } from "./phone-pushover";
import { buildThemePayload } from "./phone-theme";
import type { PhoneConfig } from "./types";

type AnyCtx = ExtensionContext | ExtensionCommandContext;

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60_000;

function isAddressInUseError(error: unknown) {
  const err = error as NodeJS.ErrnoException | null;
  return Boolean(err && (err.code === "EADDRINUSE" || err.message?.includes("EADDRINUSE")));
}

function parseSlashCommandText(text: unknown) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value.startsWith("/")) return null;

  const body = value.slice(1).trim();
  if (!body) return null;

  const spaceIndex = body.indexOf(" ");
  const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);

  return { text: `/${body}`, name };
}

function entryTimestamp(entry: SessionEntry): number {
  return typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : 0;
}

/** Convert session entries to the message format the phone UI expects. */
function entriesToMessages(entries: SessionEntry[]): any[] {
  const messages: any[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "compaction") {
      messages.push({
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: entryTimestamp(entry),
      });
    } else if (entry.type === "branch_summary") {
      messages.push({
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: entryTimestamp(entry),
      });
    } else if (entry.type === "custom_message") {
      messages.push({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: entryTimestamp(entry),
      });
    }
  }
  return messages;
}

export class PhoneServerRuntime {
  private latestCtx: AnyCtx | null = null;
  private latestError = "";
  private config: PhoneConfig = {
    host: "127.0.0.1",
    port: 8787,
    token: process.env.PI_PHONE_TOKEN || "",
    cwd: process.cwd(),
    idleTimeoutMs: Number.isFinite(Number(process.env.PI_PHONE_IDLE_MINUTES))
      ? Math.max(0, Math.round(Number(process.env.PI_PHONE_IDLE_MINUTES) * 60_000))
      : DEFAULT_IDLE_TIMEOUT_MS,
    cfToken: process.env.PI_PHONE_CF_TOKEN || "",
    cfHostname: process.env.PI_PHONE_CF_HOSTNAME || "",
    pushoverToken: process.env.PI_PHONE_PUSHOVER_TOKEN || "",
    pushoverUser: process.env.PI_PHONE_PUSHOVER_USER || "",
    pushoverOnTunnel: Boolean(process.env.PI_PHONE_PUSHOVER_ON_TUNNEL),
    passwordManagerIgnore: false,
  };
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private latestCommandCtx: ExtensionCommandContext | null = null;
  private inputSource: "cli" | "phone" = "phone";
  private idleStopTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = Date.now();
  private runtimeControlToken = "";
  private activeRuntimeStatePath: string | null = null;
  private serverWasRunning = false;
  private tokenWasGenerated = false;

  // Client tracking and live state (replaces session pool)
  private clients = new Set<WebSocket>();
  private streaming = false;
  private liveAssistantMessage: any = null;
  private liveTools = new Map<string, any>();
  private previousCwd = "";

  constructor(private readonly pi: ExtensionAPI) {}

  captureCtx(ctx: AnyCtx) {
    this.latestCtx = ctx;
    if (typeof (ctx as ExtensionCommandContext).waitForIdle === "function") {
      this.latestCommandCtx = ctx as ExtensionCommandContext;
    }
  }

  private activeCwd() {
    return this.latestCtx?.cwd || this.config.cwd || process.cwd();
  }

  // ---------------------------------------------------------------------------
  // State building
  // ---------------------------------------------------------------------------

  private buildState() {
    const ctx = this.latestCtx;
    const theme = buildThemePayload(ctx?.ui.theme);
    const model = ctx?.model;
    const contextUsage = ctx?.getContextUsage?.();

    return {
      cwd: this.config.cwd,
      hasToken: Boolean(this.config.token),
      isRunning: Boolean(this.server),
      isStreaming: this.streaming,
      lastError: this.latestError,
      pid: process.pid,
      connectedClients: this.clients.size,
      host: this.config.host,
      port: this.config.port,
      idleTimeoutMs: this.config.idleTimeoutMs,
      lastActivityAt: this.lastActivityAt,
      singleClientMode: true,
      inputSource: this.inputSource,
      cfHostname: this.config.cfHostname || undefined,
      passwordManagerIgnore: this.config.passwordManagerIgnore || undefined,
      ...(theme ? { theme } : {}),
      // Snapshot-level state the phone UI reads from get_state / snapshot.state
      model: model ? {
        id: (model as any).id || (model as any).modelId || "",
        name: (model as any).name || (model as any).id || "",
        provider: (model as any).provider || "",
        contextWindow: (model as any).contextWindow,
      } : undefined,
      sessionFile: ctx?.sessionManager?.getSessionFile?.() || null,
      sessionId: ctx?.sessionManager?.getSessionId?.() || null,
      sessionName: ctx?.sessionManager?.getSessionName?.() || null,
      thinkingLevel: this.pi.getThinkingLevel?.() || null,
      contextUsage: contextUsage || null,
    };
  }

  /** Minimal state for unauthenticated requests (health check). */
  private buildPublicState() {
    return {
      hasToken: Boolean(this.config.token),
      isRunning: Boolean(this.server),
      passwordManagerIgnore: this.config.passwordManagerIgnore || undefined,
    };
  }

  /** Get the effective URL for phone access, preferring tunnel URLs. */
  private effectiveUrl(): string | null {
    if (!this.server) return null;
    const tunnel = getCloudflareTunnelInfo();
    const cfUrl = this.config.cfHostname ? `https://${this.config.cfHostname}` : "";
    if (tunnel.active && cfUrl) return cfUrl;
    if (tunnel.active && tunnel.url) return tunnel.url;
    return `http://${this.config.host}:${this.config.port}`;
  }

  private buildSnapshot() {
    const state = this.buildState();
    const entries = this.latestCtx?.sessionManager?.getBranch?.() || [];
    const messages = entriesToMessages(entries);
    const commands = this.pi.getCommands?.() || [];

    const models = (this.latestCtx?.modelRegistry?.getAvailable() || []).map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider,
    }));

    return {
      channel: "snapshot" as const,
      state,
      sessionWorkerId: state.sessionId,
      messages,
      commands,
      models,
      liveAssistantMessage: this.liveAssistantMessage,
      liveTools: [...this.liveTools.values()],
    };
  }

  // ---------------------------------------------------------------------------
  // Event bridge: forward CLI session events to phone UI
  // ---------------------------------------------------------------------------

  bridgeAgentStart(ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    this.streaming = true;
    this.broadcast({ channel: "rpc", payload: { type: "agent_start" } });
    this.broadcastStatus();
  }

  bridgeAgentEnd(ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    this.streaming = false;
    this.liveAssistantMessage = null;
    this.liveTools.clear();
    this.broadcast({ channel: "rpc", payload: { type: "agent_end" } });
    this.broadcastStatus();
  }

  bridgeMessageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    this.liveAssistantMessage = event.message;
    this.broadcast({
      channel: "rpc",
      payload: { type: "message_update", assistantMessageEvent: event.assistantMessageEvent },
    });
  }

  bridgeMessageEnd(event: MessageEndEvent, ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    this.liveAssistantMessage = null;
    this.broadcast({
      channel: "rpc",
      payload: { type: "message_end", message: event.message },
    });
  }

  bridgeToolExecutionStart(event: ToolExecutionStartEvent, ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    this.liveTools.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
    this.broadcast({
      channel: "rpc",
      payload: {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      },
    });
  }

  bridgeToolExecutionUpdate(event: ToolExecutionUpdateEvent, ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    const existing = this.liveTools.get(event.toolCallId);
    this.liveTools.set(event.toolCallId, {
      ...existing,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: event.partialResult,
    });
    this.broadcast({
      channel: "rpc",
      payload: {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      },
    });
  }

  bridgeToolExecutionEnd(event: ToolExecutionEndEvent, ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) return;
    const existing = this.liveTools.get(event.toolCallId);
    this.liveTools.set(event.toolCallId, {
      ...existing,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
    this.broadcast({
      channel: "rpc",
      payload: {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: existing?.args,
        result: event.result,
        isError: event.isError,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Broadcasting
  // ---------------------------------------------------------------------------

  private send(ws: WebSocket, payload: unknown) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private broadcast(payload: unknown) {
    for (const client of this.clients) {
      this.send(client, payload);
    }
  }

  broadcastStatus() {
    if (!this.server || this.clients.size === 0) return;
    this.broadcast({ channel: "server", event: "status", data: this.buildState() });
  }

  broadcastSnapshot() {
    if (!this.server || this.clients.size === 0) return;
    this.broadcast(this.buildSnapshot());
  }

  // ---------------------------------------------------------------------------
  // Token & helpers
  // ---------------------------------------------------------------------------

  private generateToken() {
    const raw = randomBytes(12).toString("base64url");
    return `${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 16)}`;
  }

  // ---------------------------------------------------------------------------
  // Idle timeout
  // ---------------------------------------------------------------------------

  private clearIdleStopTimer() {
    if (this.idleStopTimer) {
      clearTimeout(this.idleStopTimer);
      this.idleStopTimer = null;
    }
  }

  markActivity() {
    this.lastActivityAt = Date.now();
    this.scheduleIdleStop();
    this.broadcastStatus();
  }

  private scheduleIdleStop() {
    this.clearIdleStopTimer();
    if (!this.server || this.config.idleTimeoutMs <= 0) return;

    this.idleStopTimer = setTimeout(async () => {
      if (!this.server) return;
      const elapsed = Date.now() - this.lastActivityAt;
      if (elapsed < this.config.idleTimeoutMs) {
        this.scheduleIdleStop();
        return;
      }

      const idlePayload = {
        channel: "server",
        event: "idle-timeout",
        data: { message: `Pi Phone stopped after ${Math.round(this.config.idleTimeoutMs / 60000) || 1} minute(s) of inactivity.` },
      };
      this.broadcast(idlePayload);
      for (const client of this.clients) {
        client.close(4010, "idle-timeout");
      }

      await this.stopServer();
      await disableCloudflareTunnel();
    }, this.config.idleTimeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Input source tracking
  // ---------------------------------------------------------------------------

  private setInputSource(source: "cli" | "phone") {
    if (this.inputSource === source) return;
    this.inputSource = source;
    this.broadcastStatus();
  }

  handleInput(event: InputEvent, ctx: ExtensionContext): InputEventResult {
    this.captureCtx(ctx);
    if (!this.server || event.source !== "interactive") {
      return { action: "continue" };
    }

    // CLI user typed — track input source, let CLI session handle it normally.
    // The event bridge will forward the resulting AI events to the phone.
    this.setInputSource("cli");
    this.markActivity();
    return { action: "continue" };
  }

  // ---------------------------------------------------------------------------
  // Slash command dispatch (simplified — no worker, uses pi.sendUserMessage)
  // ---------------------------------------------------------------------------

  private async dispatchSlashCommand(
    ws: WebSocket,
    text: string,
    options: {
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
      responseCommand?: string;
      responseData?: Record<string, unknown>;
      onSuccess?: () => void;
    } = {},
  ) {
    const parsed = parseSlashCommandText(text);
    if (!parsed) {
      this.send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: options.responseCommand || "slash_command",
          success: false,
          error: `Unknown slash command: ${text || ""}`.trim() || "Unknown slash command.",
        },
      });
      return false;
    }

    // Validate command exists
    const commands = this.pi.getCommands?.() || [];
    const match = commands.find((cmd: any) => cmd?.name === parsed.name);
    if (!match) {
      this.send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: options.responseCommand || "slash_command",
          success: false,
          error: `Unknown slash command: ${text}`,
        },
      });
      return false;
    }

    const source = typeof match.source === "string" ? match.source : "extension";
    const images = Array.isArray(options.images) ? options.images : [];
    if (source === "extension" && images.length > 0) {
      this.send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: options.responseCommand || "slash_command",
          success: false,
          error: "Extension slash commands do not support image attachments.",
        },
      });
      return false;
    }

    // Build content and send as user message
    const content: any[] = [{ type: "text", text: parsed.text }];
    for (const img of images) {
      content.push(img);
    }

    const deliverAs = options.streamingBehavior === "steer" ? "steer" as const
      : options.streamingBehavior === "followUp" ? "followUp" as const
      : undefined;

    if (images.length > 0) {
      this.pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
    } else {
      this.pi.sendUserMessage(parsed.text, deliverAs ? { deliverAs } : undefined);
    }

    options.onSuccess?.();

    // Send immediate success response
    this.send(ws, {
      channel: "rpc",
      payload: {
        type: "response",
        command: options.responseCommand || "slash_command",
        success: true,
        data: { source, name: parsed.name, ...(options.responseData || {}) },
      },
    });

    return true;
  }

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    this.markActivity();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === phoneControlStopPath) {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      if (!this.runtimeControlToken || url.searchParams.get("token") !== this.runtimeControlToken || !isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        this.stopServer().catch((error) => {
          this.latestError = error instanceof Error ? error.message : String(error);
          this.broadcastStatus();
        });
      }, 0);
      return;
    }

    if (url.pathname === "/api/health") {
      // Health check is always unauthenticated — returns minimal state so the UI
      // knows whether a token is required (for prompting the user).
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(this.buildPublicState()));
      return;
    }

    if (url.pathname === "/api/quota") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      if (this.config.token && url.searchParams.get("token") !== this.config.token) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      const quota = await getQuotaForModel(url.searchParams.get("provider"), url.searchParams.get("modelId"));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(JSON.stringify(quota));
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = sanitizePublicPath(pathname);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    try {
      const body = await readFile(filePath);
      const extension = extname(filePath);
      const cacheControl = [".html", ".js", ".css", ".webmanifest", ".json"].includes(extension) || pathname === "/sw.js"
        ? "no-store"
        : "public, max-age=60";
      res.writeHead(200, {
        "Content-Type": mimeTypes[extension] || "application/octet-stream",
        "Cache-Control": cacheControl,
      });
      if (req.method === "GET") res.end(body);
      else res.end();
    } catch {
      try {
        const body = await readFile(publicFilePath("index.html"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to serve file" }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Server lifecycle
  // ---------------------------------------------------------------------------

  async startServer() {
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleHttp(req, res).catch((error) => {
        this.latestError = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: this.latestError }));
        this.broadcastStatus();
      });
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (ws: WebSocket) => {
      // Single-client mode: close existing clients
      if (this.clients.size > 0) {
        const replacePayload = {
          channel: "server",
          event: "single-client-replaced",
          data: { message: "This Pi Phone instance was opened from another device or tab." },
        };
        for (const existing of this.clients) {
          this.send(existing, replacePayload);
          existing.close(4009, "replaced-by-new-client");
        }
        this.clients.clear();
      }

      this.clients.add(ws);
      this.markActivity();

      // Send initial snapshot
      try {
        this.send(ws, this.buildSnapshot());
      } catch (error) {
        this.send(ws, {
          channel: "server",
          event: "snapshot-error",
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      }
      this.broadcastStatus();

      ws.on("close", () => {
        this.clients.delete(ws);
        this.markActivity();
        this.broadcastStatus();
      });

      ws.on("message", (raw: RawData) => {
        this.markActivity();
        this.handleClientMessage(ws, raw.toString()).catch((error) => {
          this.send(ws, {
            channel: "server",
            event: "client-error",
            data: { message: error instanceof Error ? error.message : String(error) },
          });
        });
      });
    });

    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      const tokenMismatch = Boolean(this.config.token && url.searchParams.get("token") !== this.config.token);

      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        if (tokenMismatch) {
          ws.close(1008, "invalid-token");
          return;
        }

        this.wss?.emit("connection", ws, req);
      });
    });

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        this.server?.once("error", rejectPromise);
        this.server?.listen(this.config.port, this.config.host, () => resolvePromise());
      });

      this.latestError = "";
      this.runtimeControlToken = this.generateToken();
      this.markActivity();
      this.activeRuntimeStatePath = await writePersistedRuntimeState(this.config.host, this.config.port, this.runtimeControlToken);
      this.broadcastStatus();
      this.syncStatusUi();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stopServer();
      this.latestError = message;
      this.broadcastStatus();
      this.syncStatusUi();
      throw error;
    }
  }

  async stopServer() {
    this.clearIdleStopTimer();

    const runtimeStatePath = this.activeRuntimeStatePath;
    this.runtimeControlToken = "";

    // Close all clients
    for (const client of this.clients) {
      client.close(1000, "server-stopped");
    }
    this.clients.clear();
    this.streaming = false;
    this.liveAssistantMessage = null;
    this.liveTools.clear();
    this.inputSource = "phone";

    if (this.wss) {
      const runningWss = this.wss;
      await new Promise<void>((resolvePromise) => {
        runningWss.close(() => resolvePromise());
      });
      this.wss = null;
    }

    if (this.server) {
      const runningServer = this.server;
      await new Promise<void>((resolvePromise) => {
        try {
          runningServer.close(() => resolvePromise());
        } catch {
          resolvePromise();
        }
      });
      this.server = null;
    }

    await removePersistedRuntimeState(runtimeStatePath);
    this.activeRuntimeStatePath = null;
    this.latestError = "";
    this.broadcastStatus();
    this.syncStatusUi();
  }

  // ---------------------------------------------------------------------------
  // Client message handling
  // ---------------------------------------------------------------------------

  private async handleClientMessage(ws: WebSocket, raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      this.send(ws, { channel: "server", event: "client-error", data: { message: "Invalid JSON from client." } });
      return;
    }

    if (message.kind === "refresh") {
      this.send(ws, this.buildSnapshot());
      return;
    }

    // Phone is interacting — take focus
    this.setInputSource("phone");

    // Session operations (simplified — single session)
    if (message.kind === "session-select") {
      // Single session, just refresh
      this.send(ws, this.buildSnapshot());
      return;
    }

    if (message.kind === "local-command") {
      if (message.command === "reload") {
        try {
          if (this.latestCommandCtx) {
            await this.latestCommandCtx.reload();
          }
          this.send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "reload",
              success: true,
              data: { sessionFile: this.latestCtx?.sessionManager?.getSessionFile?.() || null },
            },
          });
          this.send(ws, this.buildSnapshot());
        } catch (error) {
          this.send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "reload",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message.command && typeof message.command === "object" && message.command.type === "path-suggestions") {
        try {
          const mode = message.command.mode === "cd" ? "cd" : "mention";
          const query = typeof message.command.query === "string" ? message.command.query : "";
          const cwd = this.activeCwd();
          const suggestions = listPhonePathSuggestions(mode, query, cwd, this.previousCwd);

          this.send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "path_suggestions",
              success: true,
              data: {
                mode,
                query,
                cwd,
                requestId: Number(message.command.requestId) || 0,
                suggestions,
              },
            },
          });
        } catch (error) {
          this.send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "path_suggestions",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message.command && typeof message.command === "object" && message.command.type === "cd") {
        try {
          const args = typeof message.command.args === "string" ? message.command.args : "";
          const cwd = this.activeCwd();
          const nextCwd = resolvePhoneCdTargetPath(args, cwd, this.previousCwd);

          if (!existsSync(nextCwd)) {
            throw new Error(`Directory does not exist: ${nextCwd}`);
          }
          if (!statSync(nextCwd).isDirectory()) {
            throw new Error(`Not a directory: ${nextCwd}`);
          }

          const slashText = args.trim() ? `/cd ${args}` : "/cd";
          await this.dispatchSlashCommand(ws, slashText, {
            responseCommand: "cd",
            responseData: { cwd: nextCwd, previousCwd: cwd },
            onSuccess: () => {
              this.previousCwd = cwd;
              this.config.cwd = nextCwd;
            },
          });
        } catch (error) {
          this.send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "cd",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message.command && typeof message.command === "object" && message.command.type === "slash-command") {
        try {
          await this.dispatchSlashCommand(ws, String(message.command.text || ""), {
            images: Array.isArray(message.command.images) ? message.command.images : [],
            streamingBehavior: message.command.streamingBehavior === "steer"
              ? "steer"
              : message.command.streamingBehavior === "followUp"
                ? "followUp"
                : undefined,
          });
        } catch (error) {
          this.send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "slash_command",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      this.send(ws, { channel: "server", event: "client-error", data: { message: "Unsupported local command." } });
      return;
    }

    if (message.kind !== "rpc" || !message.command || typeof message.command !== "object") {
      this.send(ws, { channel: "server", event: "client-error", data: { message: "Unsupported client command." } });
      return;
    }

    const command = { ...message.command };

    // --- RPC commands mapped to ctx.pi.* API ---

    if (command.type === "get_state") {
      this.send(ws, {
        channel: "rpc",
        payload: { type: "response", command: "get_state", success: true, data: this.buildState() },
      });
      return;
    }

    if (command.type === "get_messages") {
      const entries = this.latestCtx?.sessionManager?.getBranch?.() || [];
      this.send(ws, {
        channel: "rpc",
        payload: { type: "response", command: "get_messages", success: true, data: { messages: entriesToMessages(entries) } },
      });
      return;
    }

    if (command.type === "get_commands") {
      const commands = this.pi.getCommands?.() || [];
      this.send(ws, {
        channel: "rpc",
        payload: { type: "response", command: "get_commands", success: true, data: { commands } },
      });
      return;
    }

    if (command.type === "get_available_models") {
      const ctx = this.latestCtx;
      const models = (ctx?.modelRegistry?.getAvailable() || []).map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        provider: m.provider,
      }));
      this.send(ws, {
        channel: "rpc",
        payload: { type: "response", command: "get_available_models", success: true, data: { models } },
      });
      return;
    }

    if (command.type === "get_session_stats") {
      // Build basic stats from available data
      this.send(ws, {
        channel: "rpc",
        payload: { type: "response", command: "get_session_stats", success: true, data: {} },
      });
      return;
    }

    if (command.type === "prompt") {
      const text = typeof command.message === "string" ? command.message : "";
      const images = Array.isArray(command.images) ? command.images : [];

      if (images.length > 0) {
        const content: any[] = [{ type: "text", text }];
        for (const img of images) {
          content.push(img);
        }
        this.pi.sendUserMessage(content);
      } else {
        this.pi.sendUserMessage(text);
      }
      return;
    }

    if (command.type === "abort") {
      this.latestCtx?.abort?.();
      return;
    }

    if (command.type === "set_model") {
      try {
        const model = { provider: command.provider, id: command.modelId, ...(command.model || {}) };
        const success = await this.pi.setModel(model as any);
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "set_model", success, data: {} },
        });
        if (success) this.broadcastStatus();
      } catch (error) {
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "set_model", success: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }

    if (command.type === "set_thinking_level") {
      try {
        this.pi.setThinkingLevel(command.level);
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "set_thinking_level", success: true, data: {} },
        });
        this.broadcastStatus();
      } catch (error) {
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "set_thinking_level", success: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }

    if (command.type === "compact") {
      try {
        this.latestCtx?.compact?.();
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "compact", success: true, data: {} },
        });
      } catch (error) {
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "compact", success: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }

    if (command.type === "new_session") {
      try {
        if (!this.latestCommandCtx) throw new Error("No command context — run /phone start first.");
        await this.latestCommandCtx.newSession();
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "new_session", success: true, data: {} },
        });
        this.broadcastSnapshot();
      } catch (error) {
        this.send(ws, {
          channel: "rpc",
          payload: { type: "response", command: "new_session", success: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }

    if (command.type === "extension_ui_response") {
      // UI responses are handled by the CLI session directly — no action needed here
      return;
    }

    this.send(ws, {
      channel: "rpc",
      payload: {
        type: "response",
        command: String(command.type || "unknown"),
        success: false,
        error: `Unsupported command: ${command.type}`,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Status UI
  // ---------------------------------------------------------------------------

  updateStatusUi(ctx: AnyCtx) {
    const theme = ctx.ui.theme;
    if (this.server) {
      const dot = theme.fg("success", "●");
      const label = theme.fg("text", " phone on");
      ctx.ui.setStatus("pi-phone", `📱 ${dot}${label}`);
    } else {
      ctx.ui.setStatus("pi-phone", "");
    }
  }

  syncStatusUi() {
    if (!this.latestCtx) return;
    this.updateStatusUi(this.latestCtx);
  }

  statusText() {
    const url = this.effectiveUrl() || `http://${this.config.host}:${this.config.port}`;
    const idleMinutes = this.config.idleTimeoutMs > 0 ? `${Math.max(1, Math.round(this.config.idleTimeoutMs / 60_000))}m idle auto-stop` : "idle auto-stop disabled";
    return this.server
      ? `Pi Phone running at ${url} for ${this.config.cwd}${this.config.token ? " (token enabled)" : " (no token)"} · ${idleMinutes}`
      : "Pi Phone is stopped";
  }

  // ---------------------------------------------------------------------------
  // Slash command handlers
  // ---------------------------------------------------------------------------

  async handlePhoneStart(args: string | undefined, ctx: ExtensionCommandContext) {
    this.captureCtx(ctx);
    this.config.cwd = this.activeCwd();
    const parsed = parsePhoneStartArgs(args, this.config);
    const nextConfig = parsed.config;

    if (!nextConfig.token && !parsed.tokenSpecified) {
      nextConfig.token = this.generateToken();
    }

    const changed = ["host", "port", "token", "cwd", "idleTimeoutMs"].some(
      (key) => nextConfig[key as keyof PhoneConfig] !== this.config[key as keyof PhoneConfig],
    );
    const cfChanged = nextConfig.cfToken !== this.config.cfToken || nextConfig.cfHostname !== this.config.cfHostname;
    if (cfChanged && getCloudflareTunnelInfo().active) {
      await disableCloudflareTunnel();
    }
    if (parsed.tokenSpecified) {
      this.tokenWasGenerated = false;
    } else if (nextConfig.token !== this.config.token) {
      this.tokenWasGenerated = true;
    }
    this.config = nextConfig;

    // Strip protocol if user included it (e.g., "https://example.com" -> "example.com")
    if (this.config.cfHostname) {
      this.config.cfHostname = this.config.cfHostname.replace(/^https?:\/\//, "");
    }

    this.serverWasRunning = Boolean(this.server);
    if (this.server && changed) {
      await this.stopServer();
    }

    if (!this.server) {
      const startPort = this.config.port;
      const maxAttempts = 100;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await this.startServer();
          break;
        } catch (error) {
          if (!isAddressInUseError(error)) throw error;
          lastError = error;
          this.config.port++;
        }
      }

      if (this.server && this.config.port !== startPort) {
        ctx.ui.notify(`Port ${startPort} in use, using port ${this.config.port} instead.`, "info");
      } else if (!this.server) {
        throw lastError;
      }
    }

    if (!parsed.local) {
      ctx.ui.notify("Starting Cloudflare Tunnel...", "info");
      const tunnel = await enableCloudflareTunnel(this.config.port, this.config.cfToken);
      if (tunnel.connected) {
        if (this.config.cfHostname) {
          ctx.ui.notify(`Cloudflare Tunnel: https://${this.config.cfHostname}`, "info");
        } else if (tunnel.url) {
          ctx.ui.notify(`Cloudflare Tunnel: ${tunnel.url}`, "info");
        } else {
          ctx.ui.notify("Cloudflare Tunnel connected (hostname configured in dashboard)", "info");
        }
        await this.sendPushoverIfConfigured();
      } else if (tunnel.error) {
        ctx.ui.notify(`Could not start cloudflared: ${tunnel.error}`, "warning");
      }
    }

    this.updateStatusUi(ctx);
    const openUrl = this.effectiveUrl() || "";
    ctx.ui.notify(this.statusText(), "info");
    if (this.config.token) {
      // Show token directly if: newly generated, or server was just restarted (user saw it before)
      const showTokenDirectly = this.tokenWasGenerated || this.serverWasRunning;
      if (showTokenDirectly) {
        ctx.ui.notify(`Open ${openUrl} — token: ${this.config.token}`, "info");
      } else {
        ctx.ui.notify(`Open ${openUrl} (use the token from /phone token)`, "info");
      }
    } else {
      ctx.ui.notify(`Open ${openUrl}`, "info");
    }
  }

  async handlePhoneStop(ctx: ExtensionCommandContext) {
    this.captureCtx(ctx);
    const hadLocalServer = Boolean(this.server);
    await this.stopServer();
    const externalStop = hadLocalServer ? null : await stopPersistedRuntime(this.config.host, this.config.port);
    await disableCloudflareTunnel();
    this.updateStatusUi(ctx);

    if (hadLocalServer || externalStop?.stopped) {
      ctx.ui.notify("Pi Phone stopped.", "info");
      return;
    }

    if (externalStop?.found && externalStop.message) {
      const kind = externalStop.message.startsWith("Removed stale") ? "info" : "warning";
      ctx.ui.notify(externalStop.message, kind);
    } else {
      ctx.ui.notify("Pi Phone is already stopped.", "info");
    }
  }

  async handlePhoneStatus(ctx: ExtensionCommandContext) {
    this.captureCtx(ctx);
    this.updateStatusUi(ctx);
    ctx.ui.notify(this.statusText(), this.server ? "info" : "warning");
    this.notifyAccessInfo(ctx);
  }

  handlePhoneToken(ctx: ExtensionCommandContext) {
    this.captureCtx(ctx);
    this.notifyAccessInfo(ctx);
  }

  async handlePhonePushover(ctx: ExtensionCommandContext) {
    this.captureCtx(ctx);

    const { pushoverToken, pushoverUser, token } = this.config;
    if (!pushoverToken || !pushoverUser) {
      ctx.ui.notify("Set PI_PHONE_PUSHOVER_TOKEN and PI_PHONE_PUSHOVER_USER env vars to use Pushover.", "warning");
      return;
    }

    const url = this.effectiveUrl();
    if (!url) {
      ctx.ui.notify("Phone server is not running — start it with /phone start first.", "warning");
      return;
    }

    const message = this.buildPushoverMessage(url, Boolean(token));
    const result = await sendPushoverNotification(pushoverToken, pushoverUser, "Pi Phone", message, url);

    if (result.success) {
      ctx.ui.notify("Pushover notification sent.", "info");
    } else {
      ctx.ui.notify(`Pushover error: ${result.error}`, "error");
    }
  }

  private buildPushoverMessage(base: string, includeToken = false) {
    const extras: string[] = [];
    const sessionName = this.latestCtx?.sessionManager?.getSessionName?.();
    const cwd = this.config.cwd;
    if (sessionName) extras.push(`Session: ${sessionName}`);
    if (cwd) extras.push(`Dir: ${cwd}`);
    const extrasStr = extras.length ? ` — ${extras.join(" · ")}` : "";
    return includeToken ? `${base} — Token: ${this.config.token}${extrasStr}` : `${base}${extrasStr}`;
  }

  private async sendPushoverIfConfigured() {
    const { pushoverToken, pushoverUser, pushoverOnTunnel, token } = this.config;
    if (!pushoverToken || !pushoverUser || !pushoverOnTunnel) return;

    const url = this.effectiveUrl();
    if (!url) return;

    const message = this.buildPushoverMessage(url, Boolean(token));
    await sendPushoverNotification(pushoverToken, pushoverUser, "Pi Phone", message, url);
  }

  private notifyAccessInfo(ctx: AnyCtx) {
    const tunnel = getCloudflareTunnelInfo();
    const url = this.effectiveUrl();
    if (!url) return;

    const token = this.tokenWasGenerated ? this.config.token : this.config.token ? "(set)" : null;
    const cfToken = tunnel.active && this.config.cfToken ? "CF tunnel: (set)" : null;
    const parts = [url, token ? `token: ${token}` : null, cfToken].filter(Boolean);
    if (parts.length) {
      ctx.ui.notify(parts.join(" — "), "info");
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle handlers
  // ---------------------------------------------------------------------------

  async handleSessionStart(ctx: ExtensionContext) {
    this.captureCtx(ctx);
    if (!this.server) {
      this.config.cwd = this.activeCwd();
    }
    this.updateStatusUi(ctx);
    this.broadcastSnapshot();
  }

  handleSessionSwitch = this.handleSessionStart;

  async handleSessionShutdown(ctx: ExtensionContext) {
    this.captureCtx(ctx);
    await this.stopServer();
    await disableCloudflareTunnel();
    this.updateStatusUi(ctx);
  }
}
