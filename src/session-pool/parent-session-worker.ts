import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  buildSessionContext,
  parseFrontmatter,
  stripFrontmatter,
} from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  PendingClientResponse,
  SessionController,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  SessionWorkerOptions,
} from "./types";
import { contentToPreviewText, shortId } from "./utils";

const INLINE_IMAGE_TOKEN_PATTERN = /⟦img\d+⟧|\{img\d*\}/g;

function parseSlashCommandText(text: string) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return null;

  const body = value.slice(1).trim();
  if (!body) return null;

  const spaceIndex = body.indexOf(" ");
  const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? "" : body.slice(spaceIndex + 1);

  return {
    text: `/${body}`,
    name,
    args,
  };
}

function parseCommandArgs(argsString: string) {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i += 1) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }

    if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function substituteArgs(content: string, args: string[]) {
  let result = content.replace(/\$(\d+)/g, (_match, num) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? "";
  });

  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, startValue, lengthValue) => {
    let start = Number.parseInt(startValue, 10) - 1;
    if (start < 0) start = 0;
    if (lengthValue) {
      const length = Number.parseInt(lengthValue, 10);
      return args.slice(start, start + length).join(" ");
    }
    return args.slice(start).join(" ");
  });

  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

function normalizeModel(model: any) {
  if (!model || typeof model !== "object") return null;
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: model.contextWindow,
  };
}

function buildInlineContent(text: string, images: any[]) {
  INLINE_IMAGE_TOKEN_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(INLINE_IMAGE_TOKEN_PATTERN)];
  if (matches.length === 0 || images.length === 0) {
    const content = [] as any[];
    if (text) content.push({ type: "text", text });
    for (const image of images) {
      if (image?.type === "image" && image.data && image.mimeType) {
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
    }
    return content;
  }

  const content = [] as any[];
  let lastIndex = 0;
  let imageIndex = 0;

  for (const match of matches) {
    const token = match[0] || "";
    const index = match.index ?? -1;
    if (index < 0) continue;

    const before = text.slice(lastIndex, index);
    if (before) {
      content.push({ type: "text", text: before });
    }

    const image = images[imageIndex];
    if (image?.type === "image" && image.data && image.mimeType) {
      content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      imageIndex += 1;
    } else {
      content.push({ type: "text", text: token });
    }

    lastIndex = index + token.length;
  }

  const after = text.slice(lastIndex);
  if (after) {
    content.push({ type: "text", text: after });
  }

  while (imageIndex < images.length) {
    const image = images[imageIndex];
    if (image?.type === "image" && image.data && image.mimeType) {
      content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    imageIndex += 1;
  }

  return content;
}

function computeStats(messages: any[], sessionFile: string | null, sessionId: string | null) {
  const userMessages = messages.filter((message) => message?.role === "user").length;
  const assistantMessages = messages.filter((message) => message?.role === "assistant").length;
  const toolResults = messages.filter((message) => message?.role === "toolResult").length;

  let toolCalls = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content) || !message.usage) continue;
    toolCalls += message.content.filter((part: any) => part?.type === "toolCall").length;
    totalInput += Number(message.usage.input) || 0;
    totalOutput += Number(message.usage.output) || 0;
    totalCacheRead += Number(message.usage.cacheRead) || 0;
    totalCacheWrite += Number(message.usage.cacheWrite) || 0;
    totalCost += Number(message.usage?.cost?.total) || 0;
  }

  return {
    sessionFile,
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: messages.length,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    },
    cost: totalCost,
  };
}

type PendingUserMessage = {
  baselineMessageCount: number;
  message: any;
};

type ParentSessionWorkerOptions = SessionWorkerOptions<PhoneParentSessionWorker> & {
  getCtx: () => ExtensionContext | null;
  getCommandCtx: () => ExtensionCommandContext | null;
};

export class PhoneParentSessionWorker implements SessionController {
  readonly id = "parent-session";
  readonly kind = "parent" as const;
  cwd: string;
  previousCwd: string | null = null;
  currentSessionFile: string | null = null;
  lastError = "";
  lastState: any = null;
  lastMessages: any[] = [];
  lastCommands: any[] = [];
  isStreaming = false;
  isCompacting = false;
  lastActivityAt = Date.now();
  pendingUiRequest: any = null;
  liveAssistantMessage: any = null;
  liveTools = new Map<string, any>();

  private firstUserPreview = "";
  private lastUserPreview = "";
  private requestCounter = 0;
  private pendingUserMessages: PendingUserMessage[] = [];

  constructor(
    private readonly options: ParentSessionWorkerOptions,
    private readonly pi: ExtensionAPI,
  ) {
    this.cwd = options.cwd;
  }

  private touch() {
    this.lastActivityAt = Date.now();
    this.options.onActivity();
    this.options.onStateChange();
  }

  private currentCtx() {
    return this.options.getCtx();
  }

  private currentCommandCtx() {
    return this.options.getCommandCtx();
  }

  private async withAutoConfirmedUi<T>(
    ctx: ExtensionContext | ExtensionCommandContext | null,
    action: () => Promise<T>,
  ) {
    const ui = ctx?.ui;
    if (!ui || typeof ui.confirm !== "function") {
      return action();
    }

    const originalConfirm = ui.confirm;
    // Phone-triggered parent session resets should not block on a terminal confirmation dialog.
    ui.confirm = async (_title: string, _message: string, _options?: unknown) => true;

    try {
      return await action();
    } finally {
      ui.confirm = originalConfirm;
    }
  }

  private comparableContent(content: any) {
    const preview = contentToPreviewText(content);
    if (preview) {
      return preview;
    }

    try {
      return JSON.stringify(content ?? null);
    } catch {
      return String(content ?? "");
    }
  }

  private displayedMessages() {
    if (!this.pendingUserMessages.length) {
      return this.lastMessages;
    }
    return [...this.lastMessages, ...this.pendingUserMessages.map((entry) => entry.message)];
  }

  private reconcilePendingUserMessages() {
    if (!this.pendingUserMessages.length) return;

    this.pendingUserMessages = this.pendingUserMessages.filter((pending) => {
      const persistedCandidates = this.lastMessages.slice(Math.max(0, pending.baselineMessageCount));
      return !persistedCandidates.some((message) => message?.role === "user" && this.comparableContent(message.content) === this.comparableContent(pending.message.content));
    });
  }

  private updateMessagePreviews() {
    const messages = this.displayedMessages();
    const firstUser = messages.find((message) => message?.role === "user");
    const lastUser = [...messages].reverse().find((message) => message?.role === "user");
    this.firstUserPreview = firstUser ? contentToPreviewText(firstUser.content) : "";
    this.lastUserPreview = lastUser ? contentToPreviewText(lastUser.content) : "";
  }

  private buildStateFromContext(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    const sessionContext = buildSessionContext(entries, ctx.sessionManager.getLeafId());
    const model = normalizeModel(ctx.model);
    const contextUsage = ctx.getContextUsage?.();
    const state = {
      model,
      thinkingLevel: this.pi.getThinkingLevel(),
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      sessionFile: ctx.sessionManager.getSessionFile() || null,
      sessionId: ctx.sessionManager.getSessionId() || null,
      sessionName: ctx.sessionManager.getSessionName() || null,
      messageCount: sessionContext.messages.length + this.pendingUserMessages.length,
      pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
      contextUsage: contextUsage || undefined,
    };

    return {
      state,
      messages: sessionContext.messages,
    };
  }

  private rememberSnapshot(snapshot: { state: any; messages: any[]; commands: any[] }) {
    const previousSessionFile = this.currentSessionFile;
    const previousSessionId = this.lastState?.sessionId || null;

    this.lastState = snapshot.state;
    this.lastMessages = snapshot.messages;
    this.lastCommands = snapshot.commands;
    this.isStreaming = Boolean(snapshot.state?.isStreaming);
    this.isCompacting = Boolean(snapshot.state?.isCompacting);
    this.currentSessionFile = snapshot.state?.sessionFile || null;

    const nextSessionId = snapshot.state?.sessionId || null;
    if ((previousSessionFile && this.currentSessionFile && previousSessionFile !== this.currentSessionFile) || (previousSessionId && nextSessionId && previousSessionId !== nextSessionId)) {
      this.pendingUserMessages = [];
    } else {
      this.reconcilePendingUserMessages();
    }

    this.updateMessagePreviews();
  }

  private buildResponse(id: string | undefined, command: string, success: boolean, data?: any, error?: string) {
    return {
      ...(id ? { id } : {}),
      type: "response",
      command,
      success,
      ...(success && data !== undefined ? { data } : {}),
      ...(!success && error ? { error } : {}),
    };
  }

  private activeCommands() {
    return Array.isArray(this.lastCommands) && this.lastCommands.length > 0 ? this.lastCommands : this.pi.getCommands();
  }

  private expandPromptTemplate(text: string, filePath: string) {
    const parsed = parseSlashCommandText(text);
    if (!parsed) return text;
    const content = readFileSync(filePath, "utf8");
    const body = parseFrontmatter(content).body;
    const args = parseCommandArgs(parsed.args);
    return substituteArgs(body, args);
  }

  private expandSkillCommand(text: string, filePath: string, skillName: string) {
    const parsed = parseSlashCommandText(text);
    if (!parsed) return text;
    const body = stripFrontmatter(readFileSync(filePath, "utf8")).trim();
    const baseDir = dirname(filePath);
    const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    return parsed.args ? `${skillBlock}\n\n${parsed.args}` : skillBlock;
  }

  private async preparePromptText(text: string) {
    const parsed = parseSlashCommandText(text);
    if (!parsed) return text;

    const command = this.activeCommands().find((entry: any) => entry?.name === parsed.name);
    if (!command) return text;

    if (command.source === "extension") {
      throw new Error("Extension slash commands are not supported while mirroring the live CLI session. Open a parallel session to use them.");
    }

    if (command.source === "prompt" && typeof command.path === "string" && command.path) {
      return this.expandPromptTemplate(text, command.path);
    }

    if (command.source === "skill" && typeof command.path === "string" && command.path) {
      const skillName = parsed.name.replace(/^skill:/, "") || parsed.name;
      return this.expandSkillCommand(text, command.path, skillName);
    }

    return text;
  }

  private async submitPrompt(message: string, images: unknown[] = [], streamingBehavior?: "steer" | "followUp") {
    const ctx = this.currentCtx();
    if (!ctx) {
      throw new Error("Live CLI session context is not available yet.");
    }
    if (!ctx.isIdle() && !streamingBehavior) {
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }

    const text = await this.preparePromptText(String(message || ""));
    const normalizedImages = Array.isArray(images)
      ? images.filter((image: any) => image?.type === "image" && image.data && image.mimeType)
      : [];

    const content = normalizedImages.length > 0 ? buildInlineContent(text, normalizedImages) : text;
    const pendingMessage: PendingUserMessage = {
      baselineMessageCount: this.lastMessages.length,
      message: {
        role: "user",
        content,
        timestamp: Date.now(),
      },
    };

    this.pendingUserMessages.push(pendingMessage);
    if (this.lastState) {
      this.lastState = {
        ...this.lastState,
        messageCount: Number(this.lastState.messageCount || this.lastMessages.length) + 1,
      };
    }
    this.updateMessagePreviews();
    this.touch();
    this.emitSnapshot();

    try {
      this.pi.sendUserMessage(content as any, streamingBehavior ? { deliverAs: streamingBehavior } : undefined);
    } catch (error) {
      this.pendingUserMessages = this.pendingUserMessages.filter((entry) => entry !== pendingMessage);
      if (this.lastState) {
        this.lastState = {
          ...this.lastState,
          messageCount: Math.max(this.lastMessages.length, Number(this.lastState.messageCount || this.lastMessages.length) - 1),
        };
      }
      this.updateMessagePreviews();
      this.emitSnapshot();
      throw error;
    }
  }

  private async switchParentSession(sessionPath: string) {
    const commandCtx = this.currentCommandCtx();
    if (!commandCtx) {
      throw new Error("No active command context is available to switch the live CLI session.");
    }

    const result = await commandCtx.switchSession(sessionPath);
    await this.refreshCachedSnapshot();
    this.emitSnapshot();
    return result;
  }

  private emitSnapshot() {
    this.options.onEnvelope(this, {
      channel: "snapshot",
      sessionWorkerId: this.id,
      state: this.lastState,
      messages: this.displayedMessages(),
      commands: this.lastCommands,
      liveAssistantMessage: this.liveAssistantMessage,
      liveTools: [...this.liveTools.values()],
    });
  }

  async ensureStarted() {
    await this.refreshCachedSnapshot();
  }

  async refreshCachedSnapshot(): Promise<SessionSnapshot> {
    const ctx = this.currentCtx();
    if (!ctx) {
      throw new Error("Live CLI session context is not available yet.");
    }

    this.cwd = ctx.sessionManager.getCwd();
    const { state, messages } = this.buildStateFromContext(ctx);
    const commands = this.pi.getCommands();
    this.rememberSnapshot({ state, messages, commands });
    return this.getCachedSnapshot();
  }

  async getSnapshot(): Promise<SessionSnapshot> {
    return this.refreshCachedSnapshot();
  }

  getCachedSnapshot(): SessionSnapshot {
    return {
      state: this.lastState,
      messages: this.displayedMessages(),
      commands: this.lastCommands,
      liveAssistantMessage: this.liveAssistantMessage,
      liveTools: [...this.liveTools.values()],
    };
  }

  getStatus(): SessionStatus {
    return {
      childRunning: true,
      cwd: this.cwd,
      previousCwd: this.previousCwd,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      lastError: this.lastError,
      childPid: process.pid,
      sessionWorkerId: this.id,
      sessionKind: "parent",
    };
  }

  getSummary(): SessionSummary {
    const sessionId = this.lastState?.sessionId || null;
    const sessionName = this.lastState?.sessionName || null;
    const label = sessionName || this.firstUserPreview || (sessionId ? `Session ${shortId(sessionId)}` : "Current CLI session");
    const secondaryLabel = sessionName ? this.firstUserPreview || shortId(sessionId) || "" : "mirroring cli";

    return {
      id: this.id,
      kind: "parent",
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
      isRunning: true,
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      messageCount: this.lastState?.messageCount ?? this.lastMessages.length,
      pendingMessageCount: this.lastState?.pendingMessageCount ?? 0,
      hasPendingUiRequest: false,
      lastError: this.lastError,
      lastActivityAt: this.lastActivityAt,
      childPid: process.pid,
      cwd: this.cwd,
      mirrorsCli: true,
    };
  }

  async request(command: Record<string, unknown>): Promise<any> {
    const id = typeof command.id === "string" ? command.id : undefined;
    const type = String(command.type || "unknown");

    try {
      if (type === "get_state") {
        await this.refreshCachedSnapshot();
        return this.buildResponse(id, type, true, this.lastState);
      }

      if (type === "get_messages") {
        await this.refreshCachedSnapshot();
        return this.buildResponse(id, type, true, { messages: this.lastMessages });
      }

      if (type === "get_commands") {
        await this.refreshCachedSnapshot();
        return this.buildResponse(id, type, true, { commands: this.lastCommands });
      }

      if (type === "get_available_models") {
        const ctx = this.currentCtx();
        if (!ctx) throw new Error("Live CLI session context is not available yet.");
        return this.buildResponse(id, type, true, { models: ctx.modelRegistry.getAvailable() });
      }

      if (type === "get_session_stats") {
        await this.refreshCachedSnapshot();
        return this.buildResponse(id, type, true, computeStats(this.lastMessages, this.currentSessionFile, this.lastState?.sessionId || null));
      }

      if (type === "prompt") {
        await this.submitPrompt(String(command.message || ""), Array.isArray(command.images) ? command.images : [], command.streamingBehavior === "steer"
          ? "steer"
          : command.streamingBehavior === "followUp"
            ? "followUp"
            : undefined);
        return this.buildResponse(id, type, true);
      }

      if (type === "abort") {
        const ctx = this.currentCtx();
        if (!ctx) throw new Error("Live CLI session context is not available yet.");
        ctx.abort();
        return this.buildResponse(id, type, true);
      }

      if (type === "compact") {
        const ctx = this.currentCtx();
        if (!ctx) throw new Error("Live CLI session context is not available yet.");
        ctx.compact(typeof command.customInstructions === "string" && command.customInstructions
          ? { customInstructions: command.customInstructions }
          : undefined);
        return this.buildResponse(id, type, true, { started: true });
      }

      if (type === "new_session") {
        const commandCtx = this.currentCommandCtx();
        if (!commandCtx) throw new Error("No active command context is available to create a new live CLI session.");
        const result = await this.withAutoConfirmedUi(commandCtx, () => commandCtx.newSession(typeof command.parentSession === "string" && command.parentSession
          ? { parentSession: command.parentSession }
          : undefined));
        await this.refreshCachedSnapshot();
        this.emitSnapshot();
        return this.buildResponse(id, type, true, result);
      }

      if (type === "switch_session") {
        const result = await this.switchParentSession(String(command.sessionPath || ""));
        return this.buildResponse(id, type, true, result);
      }

      if (type === "fork") {
        const commandCtx = this.currentCommandCtx();
        if (!commandCtx) throw new Error("No active command context is available to fork the live CLI session.");
        const result = await commandCtx.fork(String(command.entryId || ""));
        await this.refreshCachedSnapshot();
        this.emitSnapshot();
        return this.buildResponse(id, type, true, { cancelled: result.cancelled });
      }

      if (type === "set_model") {
        const ctx = this.currentCtx();
        if (!ctx) throw new Error("Live CLI session context is not available yet.");
        const models = ctx.modelRegistry.getAvailable();
        const model = models.find((entry: any) => entry.provider === command.provider && entry.id === command.modelId);
        if (!model) {
          return this.buildResponse(id, type, false, undefined, `Model not found: ${String(command.provider || "")}/${String(command.modelId || "")}`);
        }
        const changed = await this.pi.setModel(model as any);
        if (!changed) {
          return this.buildResponse(id, type, false, undefined, `No API key found for ${String(command.provider || "")}.`);
        }
        await this.refreshCachedSnapshot();
        this.emitSnapshot();
        return this.buildResponse(id, type, true, model);
      }

      if (type === "set_thinking_level") {
        this.pi.setThinkingLevel(command.level as any);
        await this.refreshCachedSnapshot();
        this.emitSnapshot();
        return this.buildResponse(id, type, true);
      }

      if (type === "reload") {
        const commandCtx = this.currentCommandCtx();
        if (!commandCtx) throw new Error("No active command context is available to reload the live CLI session.");
        await commandCtx.reload();
        await this.refreshCachedSnapshot();
        this.emitSnapshot();
        return this.buildResponse(id, type, true);
      }

      if (type === "set_session_name") {
        const name = String(command.name || "").trim();
        if (!name) {
          return this.buildResponse(id, type, false, undefined, "Session name cannot be empty");
        }
        this.pi.setSessionName(name);
        await this.refreshCachedSnapshot();
        this.emitSnapshot();
        return this.buildResponse(id, type, true);
      }

      return this.buildResponse(id, type, false, undefined, `Unsupported live CLI command: ${type}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.options.onStateChange();
      return this.buildResponse(id, type, false, undefined, message);
    }
  }

  async sendClientCommand(command: Record<string, unknown>, meta?: PendingClientResponse) {
    const nextCommand = { ...command } as Record<string, any>;
    if (!nextCommand.id) {
      nextCommand.id = `parent-${++this.requestCounter}`;
    }

    const response = await this.request(nextCommand);

    if (meta?.ws) {
      try {
        if (response.success) meta.onSuccess?.(response);
        else meta.onError?.(response);
      } catch {
        // ignore local response side effects
      }

      const nextPayload = {
        ...response,
        ...(meta.responseCommand ? { command: meta.responseCommand } : {}),
        ...(response.success && meta.responseData ? { data: { ...(response.data || {}), ...meta.responseData } } : {}),
      };
      this.options.send(meta.ws, { channel: "rpc", payload: nextPayload });
    }

    return String(nextCommand.id);
  }

  async reload() {
    const response = await this.request({ type: "reload" });
    if (!response?.success) {
      throw new Error(response?.error || "Failed to reload the live CLI session.");
    }
  }

  captureContext(ctx: ExtensionContext | ExtensionCommandContext, options: { emitSnapshot?: boolean } = {}) {
    this.cwd = ctx.sessionManager.getCwd();
    this.touch();
    void this.refreshCachedSnapshot()
      .then(() => {
        if (options.emitSnapshot) {
          this.emitSnapshot();
        }
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.onStateChange();
      });
  }

  handleAgentStart(ctx: ExtensionContext | ExtensionCommandContext) {
    this.cwd = ctx.sessionManager.getCwd();
    this.isStreaming = true;
    if (this.lastState) {
      this.lastState = { ...this.lastState, isStreaming: true };
    }
    this.touch();
    this.options.onEnvelope(this, { channel: "rpc", payload: { type: "agent_start" } });
  }

  handleAgentEnd(ctx: ExtensionContext | ExtensionCommandContext) {
    this.cwd = ctx.sessionManager.getCwd();
    this.isStreaming = false;
    this.liveAssistantMessage = null;
    this.liveTools.clear();
    if (this.lastState) {
      this.lastState = { ...this.lastState, isStreaming: false };
    }
    this.touch();
    this.options.onEnvelope(this, { channel: "rpc", payload: { type: "agent_end" } });
    this.captureContext(ctx, { emitSnapshot: true });
  }

  handleMessageStart(event: { message: any }, ctx: ExtensionContext | ExtensionCommandContext) {
    if (event.message?.role === "assistant") {
      this.liveAssistantMessage = event.message;
    }
    this.touch();
    if (event.message?.role === "user") {
      this.captureContext(ctx, { emitSnapshot: true });
    }
  }

  handleMessageUpdate(event: { message: any; assistantMessageEvent: any }, ctx: ExtensionContext | ExtensionCommandContext) {
    this.cwd = ctx.sessionManager.getCwd();
    if (event.message?.role === "assistant") {
      this.liveAssistantMessage = event.message;
    }
    this.touch();
    this.options.onEnvelope(this, {
      channel: "rpc",
      payload: {
        type: "message_update",
        message: event.message,
        assistantMessageEvent: event.assistantMessageEvent,
      },
    });
  }

  handleMessageEnd(event: { message: any }, ctx: ExtensionContext | ExtensionCommandContext) {
    if (event.message?.role === "assistant") {
      this.liveAssistantMessage = null;
      this.options.onEnvelope(this, { channel: "rpc", payload: { type: "message_end", message: event.message } });
      this.captureContext(ctx, { emitSnapshot: true });
      return;
    }

    this.captureContext(ctx, { emitSnapshot: true });
  }

  handleToolExecutionStart(event: { toolCallId: string; toolName: string; args: any }) {
    this.liveTools.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName || "tool",
      args: event.args || {},
      partialResult: null,
      result: null,
      isError: false,
    });
    this.touch();
    this.options.onEnvelope(this, { channel: "rpc", payload: { type: "tool_execution_start", ...event } });
  }

  handleToolExecutionUpdate(event: { toolCallId: string; toolName: string; args: any; partialResult: any }) {
    const current = this.liveTools.get(event.toolCallId) || {};
    this.liveTools.set(event.toolCallId, {
      ...current,
      toolCallId: event.toolCallId,
      toolName: event.toolName || current.toolName || "tool",
      args: event.args || current.args || {},
      partialResult: event.partialResult || current.partialResult || null,
      result: current.result || null,
      isError: current.isError || false,
    });
    this.touch();
    this.options.onEnvelope(this, { channel: "rpc", payload: { type: "tool_execution_update", ...event } });
  }

  handleToolExecutionEnd(event: { toolCallId: string; toolName: string; args: any; result: any; isError: boolean }) {
    const current = this.liveTools.get(event.toolCallId) || {};
    this.liveTools.set(event.toolCallId, {
      ...current,
      toolCallId: event.toolCallId,
      toolName: event.toolName || current.toolName || "tool",
      args: event.args || current.args || {},
      partialResult: current.partialResult || null,
      result: event.result || null,
      isError: Boolean(event.isError),
    });
    this.touch();
    this.options.onEnvelope(this, { channel: "rpc", payload: { type: "tool_execution_end", ...event } });
  }

  setCompacting(isCompacting: boolean, ctx: ExtensionContext | ExtensionCommandContext) {
    this.isCompacting = isCompacting;
    if (this.lastState) {
      this.lastState = { ...this.lastState, isCompacting };
    }
    this.captureContext(ctx, { emitSnapshot: Boolean(!isCompacting) });
  }

  async dispose() {
    this.isStreaming = false;
    this.isCompacting = false;
    this.pendingUiRequest = null;
    this.liveAssistantMessage = null;
    this.liveTools.clear();
    this.options.onStateChange();
  }
}
