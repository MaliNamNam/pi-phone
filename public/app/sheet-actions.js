import { renderCommandSuggestions } from "./autocomplete-controller.js";
import {
  handleInsertOnlyLocalCommand,
  insertSlashCommand,
  tryHandleLocalCommand,
} from "./commands.js";
import { el, state } from "./state.js";
import { closeSheet, openSheet } from "./sheet-navigation.js";
import { refreshAll, sendRpc } from "./transport.js";
import { autoResizeTextarea } from "./ui.js";

export function handleSheetButtonAction(button) {
  const action = button.getAttribute("data-sheet-action");
  if (action === "refresh") return refreshSheet(), true;
  if (action === "new-session") return sendRpc({ type: "new_session" }), true;
  if (action === "compact") return sendRpc({ type: "compact" }), true;
  if (action === "stats") return sendRpc({ type: "get_session_stats" }), true;
  if (action === "models") return openSheet("models"), true;
  if (action === "thinking") return openSheet("thinking"), true;
  if (action === "commands") return openSheet("commands"), true;

  const thinkingLevel = button.getAttribute("data-thinking-level");
  if (thinkingLevel) return sendRpc({ type: "set_thinking_level", level: thinkingLevel }), true;

  const modelProvider = button.getAttribute("data-model-provider");
  const modelId = button.getAttribute("data-model-id");
  if (modelProvider && modelId) return sendRpc({ type: "set_model", provider: modelProvider, modelId }), closeSheet(), true;

  const runLocalCommand = button.getAttribute("data-run-local-command");
  if (runLocalCommand) return handleRunLocalCommand(runLocalCommand), true;

  const runCommand = button.getAttribute("data-run-command");
  if (runCommand) return handleInsertRunCommand(runCommand), true;

  return false;
}

function refreshSheet() {
  refreshAll();
}

function handleRunLocalCommand(runLocalCommand) {
  if (handleInsertOnlyLocalCommand(runLocalCommand)) {
    closeSheet();
    return;
  }

  const result = tryHandleLocalCommand(`/${runLocalCommand}`, { hasAttachments: state.attachments.length > 0 });
  if (result === "handled") {
    el.promptInput.value = "";
    autoResizeTextarea();
    renderCommandSuggestions();
  }
}

function handleInsertRunCommand(runCommand) {
  const commandName = runCommand.replace(/^\//, "").trim();
  if (commandName) {
    insertSlashCommand(commandName);
  } else {
    el.promptInput.value = `${runCommand} `;
    autoResizeTextarea();
    renderCommandSuggestions();
    el.promptInput.focus();
  }
  closeSheet();
}
