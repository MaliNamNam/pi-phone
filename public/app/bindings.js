import { addAttachments, clearAttachments, removeAttachment, renderAttachmentStrip } from "./attachments.js";
import { renderCommandSuggestions } from "./autocomplete-controller.js";
import { applyAutocompleteItem, submitPrompt } from "./commands.js";
import { el, state } from "./state.js";
import { handleSheetButtonAction, sheetButtonActionKey } from "./sheet-actions.js";
import { closeSheet, openSheet } from "./sheet-navigation.js";
import { renderSheet } from "./sheets-view.js";
import { connectSocket, refreshAll, sendRpc } from "./transport.js";
import {
  autoResizeTextarea,
  closeTokenModal,
  scheduleComposerLayoutSync,
  showToast,
  storeToken,
} from "./ui.js";
import { insertCdCommand } from "./autocomplete.js";

export function initializeBindings({ handleEnvelope, handleAuthFailure }) {
  el.promptInput.addEventListener("input", () => {
    autoResizeTextarea();
    renderCommandSuggestions();
  });

  el.promptInput.addEventListener("click", () => {
    renderCommandSuggestions();
  });

  el.promptInput.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      renderCommandSuggestions();
    }
  });

  autoResizeTextarea();
  renderCommandSuggestions();
  renderAttachmentStrip();
  scheduleComposerLayoutSync();

  if ("ResizeObserver" in window && el.composerWrap) {
    const composerResizeObserver = new ResizeObserver(() => scheduleComposerLayoutSync());
    composerResizeObserver.observe(el.composerWrap);
  }

  window.addEventListener("resize", scheduleComposerLayoutSync, { passive: true });
  window.visualViewport?.addEventListener("resize", scheduleComposerLayoutSync, { passive: true });

  el.refreshButton.addEventListener("click", refreshAll);
  el.abortButton.addEventListener("click", () => sendRpc({ type: "abort" }));
  el.stopButton?.addEventListener("click", () => sendRpc({ type: "abort" }));
  el.actionsButton.addEventListener("click", () => openSheet("actions"));
  el.insertCommandButton.addEventListener("click", () => openSheet("commands"));
  el.cdCommandButton?.addEventListener("click", () => {
    insertCdCommand();
    renderCommandSuggestions();
  });
  el.sessionBrowserButton.addEventListener("click", () => openSheet("sessions"));
  el.sessionSidebarButton.addEventListener("click", () => openSheet("active-sessions"));
  el.treeBrowserButton.addEventListener("click", () => openSheet("tree"));
  el.steerButton.addEventListener("click", () => submitPrompt({ steer: true }));
  el.sendButton.addEventListener("click", () => submitPrompt());
  el.sheetCloseButton.addEventListener("click", closeSheet);
  el.attachImageButton.addEventListener("click", () => el.imageInput.click());
  el.imageInput.addEventListener("change", (event) => {
    addAttachments(event.target.files);
    el.imageInput.value = "";
  });

  el.attachmentStrip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-attachment]");
    if (!button) return;
    removeAttachment(button.getAttribute("data-remove-attachment"));
  });

  el.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  });

  el.commandStrip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-autocomplete-index]");
    if (!button) return;

    const index = Number(button.getAttribute("data-autocomplete-index"));
    if (!Number.isFinite(index) || index < 0) return;
    applyAutocompleteItem(state.autocompleteItems[index]);
  });

  el.sheetContent.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    if (!event.target.hasAttribute("data-command-category-select")) return;
    state.commandSheetCategory = event.target.value;
    renderSheet();
  });

  el.sheetContent.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    const shouldHandleEarly = button.hasAttribute("data-active-session-id") || button.getAttribute("data-sheet-action") === "spawn-active-session";
    if (!shouldHandleEarly) return;

    event.preventDefault();
    const actionKey = sheetButtonActionKey(button);
    state.lastSheetPointerAction = actionKey;
    state.lastSheetPointerActionAt = Date.now();
    handleSheetButtonAction(button);
  });

  el.sheetContent.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    const actionKey = sheetButtonActionKey(button);
    if (state.lastSheetPointerAction === actionKey && Date.now() - state.lastSheetPointerActionAt < 800) {
      state.lastSheetPointerAction = "";
      state.lastSheetPointerActionAt = 0;
      return;
    }

    handleSheetButtonAction(button);
  });

  el.tokenSaveButton.addEventListener("click", () => {
    const nextToken = el.tokenInput.value.trim();
    if (!nextToken) {
      showToast("Enter the current /phone-start token.", "error");
      el.tokenInput.focus();
      return;
    }

    state.token = nextToken;
    storeToken(state.token);
    closeTokenModal();
    connectSocket({ handleEnvelope, handleAuthFailure });
  });

  el.tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.tokenSaveButton.click();
    }
  });

  document.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const itemId = details.getAttribute("data-tool-panel");
    if (!itemId) return;
    state.toolPanelOpen.set(itemId, details.open);
  }, true);

  window.addEventListener("beforeunload", () => {
    state.manuallyClosed = true;
    if (state.socket) state.socket.close();
    clearAttachments();
  });
}
