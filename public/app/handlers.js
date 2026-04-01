import { contentToText } from "./formatters.js";
import {
  clearSnapshotView,
  clearTransientState,
  handleAssistantEvent,
  renderMessages,
  renderWidgets,
  transformMessage,
  upsertLiveTool,
} from "./messages.js";
import { closeSheet } from "./sheet-navigation.js";
import { renderSheet } from "./sheets-view.js";
import { state } from "./state.js";
import { refreshAll, refreshQuota, sendRpc } from "./transport.js";
import {
  autoResizeTextarea,
  clearUiModal,
  openTokenModal,
  openUiModalForRequest,
  renderHeader,
  resetToken,
  showBanner,
  showToast,
} from "./ui.js";
import { renderCommandSuggestions } from "./autocomplete-controller.js";
import { renderAutocompleteItems } from "./autocomplete.js";

export function handleAuthFailure() {
  resetToken({ clearInput: true });
  state.socket = null;
  renderHeader();
  openTokenModal();
  showBanner("Access token required. Enter the current /phone-start token.", "error");
}

function sendUiResponse(payload) {
  sendRpc({ type: "extension_ui_response", ...payload });
  clearUiModal();
}

function handleExtensionUiRequest(request) {
  if (request.method === "notify") {
    showToast(request.message || "Notification");
    return;
  }

  if (request.method === "setStatus") {
    state.footerStatus = request.statusText || "";
    renderWidgets();
    return;
  }

  if (request.method === "setWidget") {
    if (request.widgetLines?.length) state.widgets.set(request.widgetKey || "widget", request.widgetLines);
    else state.widgets.delete(request.widgetKey || "widget");
    renderWidgets();
    return;
  }

  if (request.method === "setTitle") {
    document.title = request.title || "Pi Phone";
    return;
  }

  if (request.method === "set_editor_text") {
    const promptInput = document.querySelector("#prompt-input");
    if (promptInput) promptInput.value = request.text || "";
    autoResizeTextarea();
    renderCommandSuggestions();
    return;
  }

  if (!["select", "confirm", "input", "editor"].includes(request.method)) {
    showToast(`Unsupported UI request: ${request.method || "unknown"}`);
    return;
  }

  openUiModalForRequest(request, sendUiResponse);
}

function handleRpcPayload(payload) {
  if (!payload) return;

  if (payload.type === "response") {
    if (!payload.success) {
      if (payload.command === "path_suggestions") {
        renderAutocompleteItems([]);
        return;
      }
      showToast(payload.error || `Command failed: ${payload.command}`, "error");
      return;
    }

    if (payload.command === "get_state") {
      state.snapshotState = payload.data || state.snapshotState;
      renderHeader();
      void refreshQuota();
      return;
    }

    if (payload.command === "get_messages") {
      state.messages = (payload.data?.messages || []).flatMap(transformMessage);
      clearTransientState();
      renderMessages();
      return;
    }

    if (payload.command === "get_commands") {
      state.commands = payload.data?.commands || [];
      renderCommandSuggestions();
      renderSheet();
      return;
    }

    if (payload.command === "path_suggestions") {
      const context = state.autocompleteContext;
      if (!context || context.type !== "path") return;
      if (Number(payload.data?.requestId) !== state.autocompleteRemoteRequestId) return;
      if (payload.data?.mode !== context.mode) return;
      if ((payload.data?.query || "") !== context.query) return;

      const suggestions = Array.isArray(payload.data?.suggestions) ? payload.data.suggestions : [];
      renderAutocompleteItems(suggestions.map((suggestion) => ({
        kind: "path",
        label: context.mode === "mention" ? `@${suggestion.value}` : suggestion.value,
        badge: suggestion.kind === "previous" ? "recent" : suggestion.isDirectory ? "dir" : "file",
        description: suggestion.description || suggestion.value,
        value: suggestion.value,
        isDirectory: Boolean(suggestion.isDirectory),
        title: suggestion.description || suggestion.value,
      })));
      return;
    }

    if (payload.command === "cd") {
      showToast(`Changed directory to ${payload.data?.cwd || "the selected path"}.`);
      refreshAll();
      return;
    }

    if (payload.command === "get_available_models") {
      state.models = payload.data?.models || [];
      renderSheet();
      return;
    }

    if (payload.command === "get_session_stats") {
      state.stats = payload.data || null;
      renderSheet();
      return;
    }

    if (payload.command === "phone_list_sessions") {
      state.sessions = payload.data?.sessions || [];
      renderSheet();
      return;
    }

    if (payload.command === "phone_get_tree") {
      state.tree = payload.data || null;
      renderSheet();
      return;
    }

    if (payload.command === "new_session") {
      clearTransientState();
      refreshAll();
      showToast("Started a new Pi session.");
      return;
    }

    if (payload.command === "compact") {
      showToast("Compaction triggered.");
      refreshAll();
      return;
    }

    if (payload.command === "slash_command") {
      if (payload.data?.source === "extension") {
        refreshAll({ forceQuota: true });
      }
      return;
    }

    if (payload.command === "reload") {
      clearTransientState();
      showToast("Reloaded extensions, skills, prompts, and themes.");
      refreshAll({ forceQuota: true });
      return;
    }

    if (payload.command === "set_model") {
      showToast("Model updated.");
      refreshAll();
      return;
    }

    if (payload.command === "set_thinking_level") {
      showToast("Thinking level updated.");
      refreshAll();
      return;
    }

    if (payload.command === "switch_session") {
      showToast("Session switched.");
      refreshAll();
      closeSheet();
      return;
    }

    if (payload.command === "fork") {
      showToast("Fork created.");
      refreshAll();
      closeSheet();
      return;
    }

    if (payload.command === "phone_open_branch_path") {
      showToast("Opened selected branch path as a new session.");
      refreshAll();
      closeSheet();
      return;
    }

    return;
  }

  if (payload.type === "agent_start") {
    state.status = { ...(state.status || {}), isStreaming: true };
    renderHeader();
    return;
  }

  if (payload.type === "agent_end") {
    state.status = { ...(state.status || {}), isStreaming: false };
    renderHeader();
    refreshAll({ forceQuota: true });
    return;
  }

  if (payload.type === "message_update") {
    handleAssistantEvent(payload.assistantMessageEvent);
    return;
  }

  if (payload.type === "message_end" && payload.message?.role === "assistant") {
    const transformed = transformMessage(payload.message, Date.now())[0];
    if (transformed) {
      state.liveAssistant = { ...transformed, live: false };
      renderMessages();
    }
    return;
  }

  if (payload.type === "tool_execution_start") {
    upsertLiveTool(payload.toolCallId, {
      id: `tool-live-${payload.toolCallId}`,
      kind: "tool",
      toolCallId: payload.toolCallId,
      toolName: payload.toolName || "tool",
      args: payload.args || {},
      command: payload.args?.command || "",
      live: true,
      title: payload.toolName || "tool",
      text: JSON.stringify(payload.args || {}, null, 2),
      meta: "Running…",
      status: "running",
      rawContent: null,
    });
    return;
  }

  if (payload.type === "tool_execution_update") {
    upsertLiveTool(payload.toolCallId, {
      ...(state.liveTools.get(payload.toolCallId) || {}),
      id: `tool-live-${payload.toolCallId}`,
      kind: "tool",
      toolCallId: payload.toolCallId,
      toolName: payload.toolName || "tool",
      args: payload.args || state.liveTools.get(payload.toolCallId)?.args || {},
      command: payload.args?.command || state.liveTools.get(payload.toolCallId)?.command || "",
      live: true,
      title: payload.toolName || "tool",
      text: contentToText(payload.partialResult?.content) || JSON.stringify(payload.args || {}, null, 2),
      meta: "Running…",
      status: "running",
      details: payload.partialResult?.details,
      rawContent: payload.partialResult?.content || state.liveTools.get(payload.toolCallId)?.rawContent || null,
    });
    return;
  }

  if (payload.type === "tool_execution_end") {
    upsertLiveTool(payload.toolCallId, {
      ...(state.liveTools.get(payload.toolCallId) || {}),
      id: `tool-live-${payload.toolCallId}`,
      kind: "tool",
      toolCallId: payload.toolCallId,
      toolName: payload.toolName || "tool",
      args: payload.args || state.liveTools.get(payload.toolCallId)?.args || {},
      command: payload.args?.command || state.liveTools.get(payload.toolCallId)?.command || "",
      live: false,
      title: payload.toolName || "tool",
      text: contentToText(payload.result?.content),
      meta: payload.isError ? "Failed" : "Done",
      status: payload.isError ? "error" : "done",
      details: payload.result?.details,
      rawContent: payload.result?.content || state.liveTools.get(payload.toolCallId)?.rawContent || null,
    });
    return;
  }

  if (payload.type === "extension_ui_request") {
    handleExtensionUiRequest(payload);
    return;
  }

  if (payload.type === "auto_retry_start") {
    showBanner(`Retrying after error: ${payload.errorMessage || "temporary failure"}`);
    return;
  }

  if (payload.type === "auto_retry_end") {
    showBanner(payload.success ? "" : `Retry failed: ${payload.finalError || "Unknown error"}`, payload.success ? "info" : "error");
  }
}

export async function handleEnvelope(event) {
  if (event.channel === "sessions" && event.event === "catalog") {
    const nextActiveSessionId = event.data?.activeSessionId || state.activeSessionId;
    const activeSessionChanged = nextActiveSessionId !== state.activeSessionId;

    state.activeSessions = event.data?.sessions || [];
    state.activeSessionId = nextActiveSessionId;

    if (activeSessionChanged && state.snapshotWorkerId && state.snapshotWorkerId !== state.activeSessionId) {
      clearSnapshotView();
      renderMessages();
    }

    renderHeader();
    renderSheet();
    return;
  }

  if (event.channel === "snapshot") {
    if (event.sessionWorkerId && state.activeSessionId && event.sessionWorkerId !== state.activeSessionId) {
      return;
    }

    state.snapshotState = event.state || null;
    state.snapshotWorkerId = event.sessionWorkerId || state.activeSessionId || null;
    state.status = { ...(state.status || {}), isStreaming: Boolean(event.state?.isStreaming) };
    state.messages = (event.messages || []).flatMap(transformMessage);
    state.commands = event.commands || state.commands;
    if (event.models) state.models = event.models;
    clearTransientState();

    if (event.liveAssistantMessage?.role === "assistant") {
      const assistant = transformMessage(event.liveAssistantMessage, Date.now())[0];
      if (assistant) {
        state.liveAssistant = { ...assistant, id: "assistant-live", live: true };
      }
    }

    for (const tool of event.liveTools || []) {
      const text =
        contentToText(tool.result?.content)
        || contentToText(tool.partialResult?.content)
        || JSON.stringify(tool.args || {}, null, 2);

      state.liveTools.set(tool.toolCallId, {
        id: `tool-live-${tool.toolCallId}`,
        kind: "tool",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName || "tool",
        args: tool.args || {},
        command: tool.args?.command || "",
        live: !tool.result,
        title: tool.toolName || "tool",
        text,
        meta: tool.result ? (tool.isError ? "Failed" : "Done") : "Running…",
        details: tool.result?.details || tool.partialResult?.details,
        status: tool.isError ? "error" : (tool.result ? "done" : "running"),
        rawContent: tool.result?.content || tool.partialResult?.content || null,
      });
    }

    renderHeader();
    renderMessages();
    renderSheet();
    renderCommandSuggestions();
    void refreshQuota();
    return;
  }

  if (event.channel === "server") {
    if (event.event === "status") {
      const prevInputSource = state.status?.inputSource;
      state.status = event.data;
      renderHeader();
      if (event.data?.inputSource && event.data.inputSource !== prevInputSource) {
        refreshAll();
      }
      return;
    }
    if (event.event === "stderr") {
      showBanner(event.data?.text?.trim() || "", "error");
      return;
    }
    if (event.event === "reloading") {
      showBanner(event.data?.message || "");
      return;
    }
    if (event.event === "session-spawned") {
      showToast(event.data?.message || "Opened new parallel session.");
      return;
    }
    if (event.event === "single-client-replaced") {
      showBanner(event.data?.message || "This phone session was replaced by another client.", "error");
      return;
    }
    if (event.event === "idle-timeout") {
      showBanner(event.data?.message || "Pi Phone stopped because it was idle.", "error");
      return;
    }
    if (["startup-error", "snapshot-error", "client-error"].includes(event.event)) {
      showToast(event.data?.message || "Server error", "error");
      return;
    }
    if (event.event === "agent-exit") {
      showBanner(event.data?.message || "Pi rpc exited.", "error");
      return;
    }
  }

  if (event.channel === "rpc") {
    handleRpcPayload(event.payload);
  }
}
