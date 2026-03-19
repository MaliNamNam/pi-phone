import { buildPromptPayload, clearAttachments, syncAttachmentsWithPrompt } from "./attachments.js";
import { insertCdCommand, replacePromptRange } from "./autocomplete.js";
import { renderCommandSuggestions } from "./autocomplete-controller.js";
import { LOCAL_COMMAND_NAMES, THINKING_LEVELS } from "./constants.js";
import { findLocalCommandDefinition } from "./command-catalog.js";
import { el, state } from "./state.js";
import { openSheet } from "./sheet-navigation.js";
import { refreshAll, requestReload, sendLocalCommand, sendRpc } from "./transport.js";
import { autoResizeTextarea, renderHeader, showToast } from "./ui.js";
import { clearSnapshotView, renderMessages } from "./messages.js";

function parseLocalCommandInput(text) {
  const match = String(text || "").match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1] || "",
    args: match[2] || "",
  };
}

function parseSlashCommandText(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("/")) return null;

  const body = value.slice(1).trim();
  if (!body) return null;

  const spaceIndex = body.indexOf(" ");
  const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);

  return {
    text: `/${body}`,
    name,
  };
}

function findRemoteSlashCommand(text) {
  const parsed = parseSlashCommandText(text);
  if (!parsed) return null;

  const match = state.commands.find((command) => command.name === parsed.name);
  if (!match) return null;

  return {
    ...parsed,
    source: match.source || "extension",
  };
}

function sendRemoteSlashCommand(command, { images = [], steer = false } = {}) {
  if (command.source === "extension" && images.length > 0) {
    showToast("Extension slash commands do not support image attachments.", "error");
    return "blocked";
  }

  const streaming = Boolean(state.status?.isStreaming || state.snapshotState?.isStreaming);
  const sent = sendLocalCommand({
    type: "slash-command",
    text: command.text,
    ...(images.length ? { images } : {}),
    ...(command.source !== "extension"
      ? steer
        ? { streamingBehavior: "steer" }
        : streaming
          ? { streamingBehavior: "followUp" }
          : {}
      : {}),
  });

  return sent ? "handled" : false;
}

const INLINE_IMAGE_TOKEN_PATTERN = /⟦img\d+⟧|\{img\d*\}/g;

function buildInlineDisplayContent(text, images = []) {
  const value = String(text || "");
  if (!images.length) return value;

  INLINE_IMAGE_TOKEN_PATTERN.lastIndex = 0;
  const matches = [...value.matchAll(INLINE_IMAGE_TOKEN_PATTERN)];
  if (!matches.length) return value;

  const content = [];
  let lastIndex = 0;
  let imageIndex = 0;

  for (const match of matches) {
    const token = match[0] || "";
    const index = match.index ?? -1;
    if (index < 0) continue;

    const before = value.slice(lastIndex, index);
    if (before) {
      content.push({ type: "text", text: before });
    }

    const image = images[imageIndex];
    if (image?.type === "image" && image.data && image.mimeType) {
      content.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      });
      imageIndex += 1;
    } else {
      content.push({ type: "text", text: token });
    }

    lastIndex = index + token.length;
  }

  const after = value.slice(lastIndex);
  if (after) {
    content.push({ type: "text", text: after });
  }

  while (imageIndex < images.length) {
    const image = images[imageIndex];
    if (image?.type === "image" && image.data && image.mimeType) {
      content.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      });
    }
    imageIndex += 1;
  }

  return content;
}

export function insertSlashCommand(commandName) {
  el.promptInput.value = `/${commandName} `;
  autoResizeTextarea();
  renderCommandSuggestions();
  el.promptInput.focus();
}

export function tryHandleLocalCommand(text, { hasAttachments = false } = {}) {
  if (!text.startsWith("/")) return false;
  const parsed = parseLocalCommandInput(text);
  if (!parsed?.name) return false;
  const { name, args } = parsed;

  if (hasAttachments && LOCAL_COMMAND_NAMES.has(name)) {
    showToast("Local phone commands do not support image attachments.", "error");
    return "blocked";
  }

  if (name === "new") {
    sendRpc({ type: "new_session" });
    return "handled";
  }
  if (name === "compact") {
    sendRpc({ type: "compact" });
    return "handled";
  }
  if (name === "reload") {
    return requestReload() ? "handled" : "blocked";
  }
  if (name === "refresh") {
    refreshAll();
    return "handled";
  }
  if (name === "stats" || name === "cost") {
    openSheet("actions");
    sendRpc({ type: "get_session_stats" });
    return "handled";
  }
  if (name === "commands") {
    openSheet("commands");
    return "handled";
  }
  if (name === "sessions") {
    openSheet("sessions");
    return "handled";
  }
  if (name === "tree") {
    openSheet("tree");
    return "handled";
  }
  if (name === "cd") {
    return sendLocalCommand({ type: "cd", args }) ? "handled" : "blocked";
  }
  if (name === "thinking") {
    if (args && THINKING_LEVELS.includes(args)) {
      sendRpc({ type: "set_thinking_level", level: args });
    } else {
      openSheet("thinking");
    }
    return "handled";
  }
  if (name === "model") {
    if (args) {
      const [provider, modelId] = args.includes("/") ? args.split("/", 2) : [null, args];
      const match = state.models.find((model) => (provider ? model.provider === provider && model.id === modelId : model.id === modelId || model.name === modelId));
      if (match) {
        sendRpc({ type: "set_model", provider: match.provider, modelId: match.id });
      } else {
        openSheet("models");
        sendRpc({ type: "get_available_models" });
        showToast("Model not found locally. Pick one from the sheet.", "error");
      }
    } else {
      openSheet("models");
      sendRpc({ type: "get_available_models" });
    }
    return "handled";
  }
  return false;
}

export function applyAutocompleteItem(item) {
  const context = state.autocompleteContext;
  if (!item) return;

  if (item.kind === "local-command-run") {
    const result = tryHandleLocalCommand(`/${item.name}`, { hasAttachments: state.attachments.length > 0 });
    if (result === "handled") {
      el.promptInput.value = "";
      autoResizeTextarea();
      renderCommandSuggestions();
    }
    return;
  }

  if (item.kind === "local-command-insert" || item.kind === "remote-command-insert") {
    insertSlashCommand(item.name);
    return;
  }

  if (!context || context.type !== "path") return;

  if (context.mode === "mention") {
    const suffix = item.isDirectory ? "" : " ";
    replacePromptRange(context.replaceStart, context.replaceEnd, `@${item.value}${suffix}`);
    renderCommandSuggestions();
    return;
  }

  const suffix = item.isDirectory ? "" : " ";
  replacePromptRange(context.replaceStart, context.replaceEnd, `${item.value}${suffix}`);
  renderCommandSuggestions();
}

export async function submitPrompt({ steer = false } = {}) {
  syncAttachmentsWithPrompt();

  const rawPrompt = el.promptInput.value;
  const commandText = rawPrompt.trim();
  if (!commandText && state.attachments.length === 0) return;

  const localCommandResult = !steer && commandText
    ? tryHandleLocalCommand(commandText, { hasAttachments: state.attachments.length > 0 })
    : false;

  if (localCommandResult) {
    if (localCommandResult === "handled") {
      el.promptInput.value = "";
      autoResizeTextarea();
      renderCommandSuggestions();
    }
    return;
  }

  let promptPayload = { message: rawPrompt, images: [] };
  try {
    promptPayload = await buildPromptPayload(rawPrompt);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Failed to read images", "error");
    return;
  }

  const message = promptPayload.message.trim();
  const images = promptPayload.images;
  const remoteSlashCommand = message ? findRemoteSlashCommand(message) : null;
  if (remoteSlashCommand) {
    const remoteCommandResult = sendRemoteSlashCommand(remoteSlashCommand, { images, steer });
    if (remoteCommandResult) {
      if (remoteCommandResult === "handled") {
        el.promptInput.value = "";
        autoResizeTextarea();
        renderCommandSuggestions();
        clearAttachments();
      }
      return;
    }
  }

  const streaming = Boolean(state.status?.isStreaming || state.snapshotState?.isStreaming);
  sendRpc({
    type: "prompt",
    message,
    ...(steer ? { streamingBehavior: "steer" } : streaming ? { streamingBehavior: "followUp" } : {}),
    ...(images.length ? { images } : {}),
  });

  state.messages.push({
    id: `local-user-${Date.now()}`,
    kind: "user",
    meta: "just now",
    text: message || "(image prompt)",
    rawContent: buildInlineDisplayContent(rawPrompt, images),
    imageCount: images.length,
  });
  renderMessages();
  el.promptInput.value = "";
  autoResizeTextarea();
  renderCommandSuggestions();
  clearAttachments();
}

export function handleInsertOnlyLocalCommand(commandName) {
  const definition = findLocalCommandDefinition(commandName);
  if (!definition?.insertOnly) return false;

  if (commandName === "cd") {
    insertCdCommand();
    renderCommandSuggestions();
  } else {
    insertSlashCommand(commandName);
  }

  return true;
}

export function prepareSessionSelection(sessionId) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast("Not connected to Pi.", "error");
    return false;
  }

  clearSnapshotView();
  renderHeader();
  renderMessages();
  state.socket.send(JSON.stringify({ kind: "session-select", sessionId }));
  return true;
}

export function prepareSessionSpawn() {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast("Not connected to Pi.", "error");
    return false;
  }

  clearSnapshotView();
  renderHeader();
  renderMessages();
  showToast("Opening new active session…");
  state.socket.send(JSON.stringify({ kind: "session-spawn" }));
  return true;
}
