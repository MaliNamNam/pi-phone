import { insertTextAtCursor } from "./autocomplete.js";
import { escapeHtml, formatBytes } from "./formatters.js";
import { el, state } from "./state.js";
import { autoResizeTextarea, scheduleComposerLayoutSync } from "./ui.js";

function currentPromptText() {
  return String(el.promptInput?.value || "");
}

function createAttachmentRecord(file) {
  const tokenOrder = state.nextAttachmentTokenId || 1;
  state.nextAttachmentTokenId = tokenOrder + 1;

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    url: URL.createObjectURL(file),
    token: `⟦img${tokenOrder}⟧`,
    tokenOrder,
  };
}

function orderedAttachments(promptText = currentPromptText()) {
  return [...state.attachments].sort((left, right) => {
    const leftIndex = promptText.indexOf(left.token);
    const rightIndex = promptText.indexOf(right.token);
    const leftMissing = leftIndex === -1;
    const rightMissing = rightIndex === -1;

    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (!leftMissing && leftIndex !== rightIndex) return leftIndex - rightIndex;
    return (left.tokenOrder || 0) - (right.tokenOrder || 0);
  });
}

function disposeAttachment(attachment) {
  if (attachment?.url) {
    URL.revokeObjectURL(attachment.url);
  }
}

function disposeAttachments(attachments = []) {
  for (const attachment of attachments) {
    disposeAttachment(attachment);
  }
}

function buildTokenInsertion(tokens) {
  if (!tokens.length) return "";

  const value = currentPromptText();
  const start = el.promptInput.selectionStart ?? value.length;
  const end = el.promptInput.selectionEnd ?? start;
  const beforeChar = start > 0 ? value[start - 1] : "";
  const afterChar = end < value.length ? value[end] : "";
  const needsLeadingSpace = beforeChar && !/\s/.test(beforeChar);
  const needsTrailingSpace = !afterChar || !/\s/.test(afterChar);

  return `${needsLeadingSpace ? " " : ""}${tokens.join(" ")}${needsTrailingSpace ? " " : ""}`;
}

function stripTokenFromPrompt(token) {
  const value = currentPromptText();
  if (!token || !value.includes(token)) return false;

  const selectionStart = el.promptInput.selectionStart ?? value.length;
  const selectionEnd = el.promptInput.selectionEnd ?? selectionStart;
  let nextText = "";
  let nextSelectionStart = selectionStart;
  let nextSelectionEnd = selectionEnd;
  let offset = 0;

  while (offset < value.length) {
    const index = value.indexOf(token, offset);
    if (index === -1) break;

    nextText += value.slice(offset, index);

    if (index < nextSelectionStart) {
      nextSelectionStart -= Math.min(token.length, nextSelectionStart - index);
    }
    if (index < nextSelectionEnd) {
      nextSelectionEnd -= Math.min(token.length, nextSelectionEnd - index);
    }

    offset = index + token.length;
  }

  nextText += value.slice(offset);
  if (nextText === value) return false;

  el.promptInput.value = nextText;
  const clampedStart = Math.max(0, Math.min(nextText.length, nextSelectionStart));
  const clampedEnd = Math.max(clampedStart, Math.min(nextText.length, nextSelectionEnd));
  el.promptInput.focus();
  el.promptInput.setSelectionRange(clampedStart, clampedEnd);
  autoResizeTextarea();
  return true;
}

export function renderAttachmentStrip() {
  const attachments = orderedAttachments();
  if (!attachments.length) {
    el.attachmentStrip.classList.add("hidden");
    el.attachmentStrip.innerHTML = "";
    scheduleComposerLayoutSync();
    return;
  }

  el.attachmentStrip.innerHTML = attachments.map((attachment) => `
    <article class="attachment-chip">
      <img src="${attachment.url}" alt="${escapeHtml(attachment.name)}" />
      <div class="attachment-chip-header">
        <div class="attachment-chip-token mono">${escapeHtml(attachment.token)}</div>
        <button class="attachment-chip-remove" data-remove-attachment="${attachment.id}" aria-label="Remove image ${escapeHtml(attachment.token)}">✕</button>
      </div>
      <div class="attachment-chip-name">${escapeHtml(attachment.name)}</div>
      <div class="attachment-chip-meta">${escapeHtml(formatBytes(attachment.size))}</div>
    </article>
  `).join("");
  el.attachmentStrip.classList.remove("hidden");
  scheduleComposerLayoutSync();
}

export function addAttachments(files) {
  const incoming = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
  if (!incoming.length) return;

  const added = incoming.map((file) => createAttachmentRecord(file));
  state.attachments.push(...added);

  const insertion = buildTokenInsertion(added.map((attachment) => attachment.token));
  if (insertion) {
    insertTextAtCursor(insertion);
  }

  syncAttachmentsWithPrompt();
  renderAttachmentStrip();
}

export function removeAttachment(id) {
  const index = state.attachments.findIndex((attachment) => attachment.id === id);
  if (index === -1) return;

  const [removed] = state.attachments.splice(index, 1);
  stripTokenFromPrompt(removed.token);
  disposeAttachment(removed);
  renderAttachmentStrip();
}

export function clearAttachments(options = {}) {
  if (options.removeTokensFromPrompt) {
    for (const attachment of state.attachments) {
      stripTokenFromPrompt(attachment.token);
    }
  }

  disposeAttachments(state.attachments);
  state.attachments = [];
  renderAttachmentStrip();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function syncAttachmentsWithPrompt() {
  if (!state.attachments.length) return [];

  const promptText = currentPromptText();
  const kept = [];
  const removed = [];

  for (const attachment of state.attachments) {
    if (promptText.includes(attachment.token)) {
      kept.push(attachment);
    } else {
      removed.push(attachment);
    }
  }

  if (removed.length) {
    disposeAttachments(removed);
    state.attachments = kept;
  }

  renderAttachmentStrip();
  return removed;
}

function attachmentOccurrences(promptText = currentPromptText()) {
  const matches = [];

  for (const attachment of state.attachments) {
    let offset = 0;
    while (offset <= promptText.length) {
      const index = promptText.indexOf(attachment.token, offset);
      if (index === -1) break;
      matches.push({ index, attachment });
      offset = index + attachment.token.length;
    }
  }

  matches.sort((left, right) => left.index - right.index || (left.attachment.tokenOrder || 0) - (right.attachment.tokenOrder || 0));
  return matches.map((match) => match.attachment);
}

export async function buildPromptPayload(promptText = currentPromptText()) {
  const rawPrompt = String(promptText || "");
  const attachments = attachmentOccurrences(rawPrompt);

  const images = await Promise.all(
    attachments.map(async (attachment) => ({
      type: "image",
      data: await fileToBase64(attachment.file),
      mimeType: attachment.type || "image/png",
    })),
  );

  return { message: rawPrompt, images };
}
