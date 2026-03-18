import { el, state } from "./state.js";
import { escapeHtml, formatBytes } from "./formatters.js";
import { scheduleComposerLayoutSync } from "./ui.js";

export function renderAttachmentStrip() {
  if (!state.attachments.length) {
    el.attachmentStrip.classList.add("hidden");
    el.attachmentStrip.innerHTML = "";
    scheduleComposerLayoutSync();
    return;
  }

  el.attachmentStrip.innerHTML = state.attachments.map((attachment) => `
    <article class="attachment-chip">
      <img src="${attachment.url}" alt="${escapeHtml(attachment.name)}" />
      <div class="attachment-chip-header">
        <div class="attachment-chip-name">${escapeHtml(attachment.name)}</div>
        <button class="attachment-chip-remove" data-remove-attachment="${attachment.id}" aria-label="Remove image">✕</button>
      </div>
      <div class="attachment-chip-meta">${escapeHtml(formatBytes(attachment.size))}</div>
    </article>
  `).join("");
  el.attachmentStrip.classList.remove("hidden");
  scheduleComposerLayoutSync();
}

export function addAttachments(files) {
  const incoming = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
  for (const file of incoming) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.attachments.push({
      id,
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      url: URL.createObjectURL(file),
    });
  }
  renderAttachmentStrip();
}

export function removeAttachment(id) {
  const index = state.attachments.findIndex((attachment) => attachment.id === id);
  if (index === -1) return;
  URL.revokeObjectURL(state.attachments[index].url);
  state.attachments.splice(index, 1);
  renderAttachmentStrip();
}

export function clearAttachments() {
  for (const attachment of state.attachments) {
    URL.revokeObjectURL(attachment.url);
  }
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

export async function buildPromptImages() {
  return Promise.all(
    state.attachments.map(async (attachment) => ({
      type: "image",
      data: await fileToBase64(attachment.file),
      mimeType: attachment.type || "image/png",
    })),
  );
}
