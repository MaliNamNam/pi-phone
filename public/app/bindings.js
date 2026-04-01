import { addAttachments, clearAttachments, removeAttachment, renderAttachmentStrip, syncAttachmentsWithPrompt } from "./attachments.js";
import { renderCommandSuggestions } from "./autocomplete-controller.js";
import { applyAutocompleteItem, submitPrompt } from "./commands.js";
import { el, state } from "./state.js";
import { updateMessageCaps } from "./messages.js";
import { handleSheetButtonAction } from "./sheet-actions.js";
import { closeSheet, openSheet } from "./sheet-navigation.js";
import { renderSheet } from "./sheets-view.js";
import { connectSocket, refreshAll, sendRpc } from "./transport.js";
import {
  autoResizeTextarea,
  closeTokenModal,
  isNearBottom,
  scheduleComposerLayoutSync,
  scrollMessagesToBottom,
  setFollowLatest,
  showToast,
  storeToken,
} from "./ui.js";
import { insertCdCommand } from "./autocomplete.js";

export function initializeBindings({ handleEnvelope, handleAuthFailure }) {
  el.promptInput.addEventListener("input", () => {
    syncAttachmentsWithPrompt();
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

  const noteUserScrollIntent = () => {
    state.lastUserScrollIntentAt = Date.now();
  };

  const syncFollowLatestOnScroll = () => {
    const now = Date.now();
    const fromUser = now - state.lastUserScrollIntentAt < 400;
    if (!fromUser && now < state.ignoreScrollTrackingUntil) return;
    setFollowLatest(isNearBottom());
  };

  window.addEventListener("wheel", noteUserScrollIntent, { passive: true });
  window.addEventListener("touchmove", noteUserScrollIntent, { passive: true });
  window.addEventListener("scroll", syncFollowLatestOnScroll, { passive: true });

  el.refreshButton.addEventListener("click", refreshAll);
  el.stopButton?.addEventListener("click", () => sendRpc({ type: "abort" }));
  el.jumpToLatestButton?.addEventListener("click", () => {
    setFollowLatest(true);
    scrollMessagesToBottom({ force: true, behavior: "smooth" });
  });
  el.actionsButton.addEventListener("click", () => openSheet("actions"));
  el.insertCommandButton.addEventListener("click", () => openSheet("commands"));
  el.cdCommandButton?.addEventListener("click", () => {
    insertCdCommand();
    renderCommandSuggestions();
  });
  el.steerButton.addEventListener("click", () => submitPrompt({ steer: true }));
  el.sendButton.addEventListener("click", () => submitPrompt());
  el.sheetCloseButton.addEventListener("click", closeSheet);
  el.attachImageButton.addEventListener("click", () => el.imageInput.click());
  el.imageInput.addEventListener("change", (event) => {
    addAttachments(event.target.files);
    renderCommandSuggestions();
    el.imageInput.value = "";
  });

  el.attachmentStrip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-attachment]");
    if (!button) return;
    removeAttachment(button.getAttribute("data-remove-attachment"));
    renderCommandSuggestions();
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

  el.sheetContent.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    handleSheetButtonAction(button);
  });

  el.tokenSaveButton.addEventListener("click", () => {
    const nextToken = el.tokenInput.value.trim();
    if (!nextToken) {
      showToast("Enter the current /phone start token.", "error");
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

  document.addEventListener("click", (event) => {
    const button = event.target.closest(".tool-preview-truncated");
    if (!button) return;

    event.preventDefault();
    const block = button.closest(".tool-diff-block, .tool-code-block, .tool-markdown-preview, .tool-terminal-block, .tool-match-group, .tool-match-groups, .tool-entry-list");
    if (block) {
      const wasExpanded = block.classList.contains("expanded");
      block.classList.toggle("expanded");
      button.classList.toggle("expanded");
      const originalText = button.dataset.label || button.textContent;
      button.textContent = wasExpanded
        ? originalText
        : "Show less";
    }
  });

  // Message expand/collapse (button or gradient click)
  document.addEventListener("click", (event) => {
    const target = event.target.closest(".msg-expand-btn, .msg-gradient");
    if (!target) return;

    const article = target.closest(".message");
    const msgId = article?.dataset.itemId;
    if (!msgId) return;

    const wasExpanded = state.messageExpanded.has(msgId);
    if (wasExpanded) {
      state.messageExpanded.delete(msgId);
    } else {
      state.messageExpanded.add(msgId);
    }

    updateMessageCaps();

    // When collapsing, scroll to keep the message in view
    if (wasExpanded && article) {
      article.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  document.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const itemId = details.getAttribute("data-tool-panel");
    if (!itemId) return;
    state.toolPanelOpen.set(itemId, details.open);
  }, true);

  // Re-measure message caps when images load
  el.messages.addEventListener("load", (e) => {
    if (e.target instanceof HTMLImageElement) updateMessageCaps();
  }, true);

  window.addEventListener("beforeunload", () => {
    state.manuallyClosed = true;
    if (state.socket) state.socket.close();
    clearAttachments();
  });
}
