import {
  clearAutocompleteSuggestions,
  detectCdAutocompleteContext,
  detectMentionAutocompleteContext,
  detectSlashCommandAutocompleteContext,
  renderAutocompleteItems,
} from "./autocomplete.js";
import { visibleCommandCatalog } from "./command-catalog.js";
import { el, state } from "./state.js";
import { sendLocalCommand } from "./transport.js";

function activeAutocompleteContext() {
  const value = el.promptInput.value || "";
  const cursor = el.promptInput.selectionStart ?? value.length;

  const mention = detectMentionAutocompleteContext(value, cursor);
  if (mention) return mention;

  const cd = detectCdAutocompleteContext(value, cursor);
  if (cd) return cd;

  const slash = detectSlashCommandAutocompleteContext(value, cursor);
  if (slash) return slash;

  return null;
}

function requestPathSuggestions(context) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    renderAutocompleteItems([]);
    return;
  }

  const requestId = ++state.autocompleteRemoteRequestId;
  sendLocalCommand({
    type: "path-suggestions",
    mode: context.mode,
    query: context.query,
    requestId,
  });
}

function queuePathSuggestions(context) {
  if (state.autocompleteRemoteTimer) {
    clearTimeout(state.autocompleteRemoteTimer);
  }

  state.autocompleteRemoteTimer = setTimeout(() => {
    state.autocompleteRemoteTimer = null;
    requestPathSuggestions(context);
  }, 90);
}

export function renderCommandSuggestions() {
  const context = activeAutocompleteContext();
  state.autocompleteContext = context;

  if (!context) {
    clearAutocompleteSuggestions();
    return;
  }

  if (context.type === "slash-command") {
    const matches = visibleCommandCatalog()
      .filter((command) => command.name.toLowerCase().startsWith(context.query.toLowerCase()))
      .slice(0, 10)
      .map((command) => ({
        kind: command.source === "local" ? (command.insertOnly ? "local-command-insert" : "local-command-run") : "remote-command-insert",
        label: `/${command.name}`,
        badge: command.source || "command",
        description: command.description || "",
        name: command.name,
      }));

    renderAutocompleteItems(matches);
    return;
  }

  renderAutocompleteItems([]);
  queuePathSuggestions(context);
}
