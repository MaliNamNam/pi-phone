import { THEME_CSS_VARIABLES, TOKEN_STORAGE_KEY } from "./constants.js";
import { formatCwdDisplay, formatTokenCount } from "./formatters.js";
import { el, state } from "./state.js";

let composerLayoutFrame = 0;

export function storeToken(token) {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function resetToken({ clearInput = false } = {}) {
  state.token = "";
  storeToken("");
  if (clearInput) el.tokenInput.value = "";
}

export function applyThemePalette(themePayload) {
  const root = document.documentElement;
  const colors = themePayload?.colors || {};

  for (const [colorKey, cssVariable] of Object.entries(THEME_CSS_VARIABLES)) {
    const value = typeof colors[colorKey] === "string" ? colors[colorKey].trim() : "";
    if (value) root.style.setProperty(cssVariable, value);
    else root.style.removeProperty(cssVariable);
  }

  if (themePayload?.name) root.dataset.piTheme = themePayload.name;
  else delete root.dataset.piTheme;
}

function currentQuotaModel() {
  const model = state.snapshotState?.model;
  if (!model || typeof model !== "object") return null;
  return {
    provider: typeof model.provider === "string" ? model.provider : "",
    modelId: typeof model.id === "string" ? model.id : "",
  };
}

function shouldShowQuotaForModel(model = currentQuotaModel()) {
  if (!model) return false;
  return model.provider === "openai-codex" && /^gpt-/i.test(model.modelId || "");
}

function quotaPillClassName(leftPercent) {
  if (!Number.isFinite(leftPercent)) return "";
  if (leftPercent <= 10) return "danger";
  if (leftPercent <= 25) return "warn";
  return "good";
}

function contextPillClassName(percent) {
  if (!Number.isFinite(percent)) return "";
  if (percent > 90) return "danger";
  if (percent > 70) return "warn";
  return "";
}

function currentContextUsage() {
  const snapshot = state.snapshotState;
  if (!snapshot || typeof snapshot !== "object") return null;

  const contextWindow = Number(snapshot.contextUsage?.contextWindow ?? snapshot.model?.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  const percent = typeof snapshot.contextUsage?.percent === "number"
    ? snapshot.contextUsage.percent
    : null;
  const percentDisplay = percent === null ? "?" : `${percent.toFixed(1)}%`;

  return {
    percent,
    text: `${percentDisplay}/${formatTokenCount(contextWindow)}`,
  };
}

export function syncComposerReserve() {
  if (!el.composerWrap) return;
  const reserve = Math.max(144, Math.ceil(el.composerWrap.getBoundingClientRect().height + 16));
  document.documentElement.style.setProperty("--composer-reserve", `${reserve}px`);
}

export function scheduleComposerLayoutSync() {
  if (composerLayoutFrame) return;
  composerLayoutFrame = requestAnimationFrame(() => {
    composerLayoutFrame = 0;
    syncComposerReserve();
  });
}

function isAnyModalOpen() {
  return !el.sheetModal.classList.contains("hidden") || !el.uiModal.classList.contains("hidden") || !el.loginModal.classList.contains("hidden");
}

export function scrollMessagesToBottom() {
  if (isAnyModalOpen()) return;
  requestAnimationFrame(() => {
    syncComposerReserve();
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  });
}

export function showBanner(text, kind = "info") {
  if (!text) {
    el.banner.classList.add("hidden");
    el.banner.textContent = "";
    el.banner.classList.remove("error");
    return;
  }
  el.banner.textContent = text;
  el.banner.classList.toggle("error", kind === "error");
  el.banner.classList.remove("hidden");
}

export function showToast(text, kind = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${kind === "error" ? "error" : ""}`;
  toast.textContent = text;
  el.toastHost.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

export function renderQuota() {
  const cwd = state.status?.cwd || state.health?.cwd || "";
  const contextUsage = currentContextUsage();

  if (cwd) {
    el.quotaCwd.textContent = formatCwdDisplay(cwd);
    el.quotaCwd.title = cwd;
    el.quotaCwd.setAttribute("aria-label", `Working directory ${cwd}`);
    el.quotaCwd.className = "quota-pill cwd-pill mono";
  } else {
    el.quotaCwd.textContent = "";
    el.quotaCwd.title = "";
    el.quotaCwd.removeAttribute("aria-label");
    el.quotaCwd.className = "quota-pill cwd-pill mono hidden";
  }

  if (contextUsage) {
    el.quotaContext.textContent = contextUsage.text;
    el.quotaContext.title = "Current context usage";
    el.quotaContext.setAttribute("aria-label", `Current context usage ${contextUsage.text}`);
    el.quotaContext.className = `quota-pill quota-context-pill mono ${contextPillClassName(contextUsage.percent)}`.trim();
  } else {
    el.quotaContext.textContent = "";
    el.quotaContext.title = "";
    el.quotaContext.removeAttribute("aria-label");
    el.quotaContext.className = "quota-pill quota-context-pill mono hidden";
  }

  const quotaSupported = shouldShowQuotaForModel();
  if (!quotaSupported) {
    state.quota = null;
  }

  const primary = quotaSupported ? state.quota?.primaryWindow : null;
  const secondary = quotaSupported ? state.quota?.secondaryWindow : null;
  const hasQuotaPills = Boolean(contextUsage || (state.quota?.visible && (primary || secondary)));

  if (primary) {
    el.quotaPrimary.textContent = primary.text;
    el.quotaPrimary.title = `${primary.label} quota remaining`;
    el.quotaPrimary.setAttribute("aria-label", `${primary.label} quota remaining ${primary.text}`);
    el.quotaPrimary.className = `quota-pill ${quotaPillClassName(primary.leftPercent)}`.trim();
  } else {
    el.quotaPrimary.textContent = "";
    el.quotaPrimary.title = "";
    el.quotaPrimary.removeAttribute("aria-label");
    el.quotaPrimary.className = "quota-pill hidden";
  }

  if (secondary) {
    el.quotaSecondary.textContent = secondary.text;
    el.quotaSecondary.title = `${secondary.label} quota remaining`;
    el.quotaSecondary.setAttribute("aria-label", `${secondary.label} quota remaining ${secondary.text}`);
    el.quotaSecondary.className = `quota-pill ${quotaPillClassName(secondary.leftPercent)}`.trim();
  } else {
    el.quotaSecondary.textContent = "";
    el.quotaSecondary.title = "";
    el.quotaSecondary.removeAttribute("aria-label");
    el.quotaSecondary.className = "quota-pill hidden";
  }

  const hasMetaRow = Boolean(cwd);
  el.quotaMetaRow.classList.toggle("hidden", !hasMetaRow);
  el.quotaPillsRow.classList.toggle("hidden", !hasQuotaPills);
  el.quotaRow.classList.toggle("hidden", !(hasMetaRow || hasQuotaPills));
  scheduleComposerLayoutSync();
}

function updateComposerState() {
  const streaming = Boolean(state.status?.isStreaming || state.snapshotState?.isStreaming);
  const sendLabel = streaming ? "Queue message" : "Send message";

  el.abortButton.disabled = !streaming;
  if (el.stopButton) {
    el.stopButton.disabled = !streaming;
    el.stopButton.classList.toggle("hidden", !streaming);
  }
  el.sendButton.textContent = ">";
  el.sendButton.setAttribute("aria-label", sendLabel);
  el.sendButton.setAttribute("title", sendLabel);
  el.steerButton.classList.toggle("hidden", !streaming);
  scheduleComposerLayoutSync();
}

export function renderHeader() {
  const connected = state.socket?.readyState === WebSocket.OPEN;
  el.connectionPill.textContent = connected ? "Connected" : "Offline";
  el.connectionPill.classList.toggle("offline", !connected);

  const status = state.status || state.health || {};
  applyThemePalette(status.theme || state.health?.theme || null);
  const snapshotMatchesActive = !state.snapshotWorkerId || !state.activeSessionId || state.snapshotWorkerId === state.activeSessionId;
  const snapshot = snapshotMatchesActive ? (state.snapshotState || {}) : {};
  const activeSession = state.activeSessions.find((session) => session.id === state.activeSessionId) || null;
  el.cwdValue.textContent = status.cwd || "—";
  el.sessionValue.textContent = snapshot.sessionName || snapshot.sessionId || activeSession?.label || "Current session";
  el.modelValue.textContent = snapshot.model?.name || snapshot.model?.id || activeSession?.model?.name || "Default";
  el.thinkingValue.textContent = snapshot.thinkingLevel || "—";
  el.streamingValue.textContent = status.isStreaming || snapshot.isStreaming ? "Streaming" : "Idle";
  el.serverValue.textContent = status.port ? `${status.host || "127.0.0.1"}:${status.port}` : "—";
  updateComposerState();
  renderQuota();
}

export function autoResizeTextarea() {
  el.promptInput.style.height = "auto";
  el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 220)}px`;
  scheduleComposerLayoutSync();
}

export function openTokenModal() {
  if (el.loginModal.classList.contains("hidden")) {
    el.tokenInput.value = state.token;
  }
  el.loginModal.classList.remove("hidden");
  setTimeout(() => el.tokenInput.focus(), 10);
}

export function closeTokenModal() {
  el.loginModal.classList.add("hidden");
}

export function clearUiModal() {
  state.pendingUiRequest = null;
  el.uiModal.classList.add("hidden");
  el.uiModalOptions.innerHTML = "";
  el.uiModalButtons.innerHTML = "";
  el.uiModalInput.value = "";
  el.uiModalInput.classList.add("hidden");
}

export function openUiModalForRequest(request, onResponse) {
  state.pendingUiRequest = request;
  el.uiModalTitle.textContent = request.title || "Action required";
  el.uiModalMessage.textContent = request.message || "";
  el.uiModalOptions.innerHTML = "";
  el.uiModalButtons.innerHTML = "";
  el.uiModalInput.value = request.prefill || "";
  el.uiModalInput.classList.add("hidden");

  const addCancel = () => {
    const cancelButton = document.createElement("button");
    cancelButton.className = "secondary";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => onResponse({ id: request.id, cancelled: true }));
    el.uiModalButtons.appendChild(cancelButton);
  };

  if (request.method === "select") {
    for (const option of request.options || []) {
      const button = document.createElement("button");
      button.textContent = option;
      button.className = "secondary";
      button.addEventListener("click", () => onResponse({ id: request.id, value: option }));
      el.uiModalOptions.appendChild(button);
    }
    addCancel();
  } else if (request.method === "confirm") {
    const denyButton = document.createElement("button");
    denyButton.className = "secondary";
    denyButton.textContent = "No";
    denyButton.addEventListener("click", () => onResponse({ id: request.id, confirmed: false }));

    const confirmButton = document.createElement("button");
    confirmButton.textContent = "Yes";
    confirmButton.addEventListener("click", () => onResponse({ id: request.id, confirmed: true }));

    el.uiModalButtons.appendChild(denyButton);
    el.uiModalButtons.appendChild(confirmButton);
  } else if (request.method === "input" || request.method === "editor") {
    el.uiModalInput.classList.remove("hidden");
    el.uiModalInput.placeholder = request.placeholder || "";

    const submitButton = document.createElement("button");
    submitButton.textContent = "Submit";
    submitButton.addEventListener("click", () => onResponse({ id: request.id, value: el.uiModalInput.value }));

    addCancel();
    el.uiModalButtons.appendChild(submitButton);
  }

  el.uiModal.classList.remove("hidden");
  setTimeout(() => {
    if (request.method === "input" || request.method === "editor") el.uiModalInput.focus();
  }, 10);
}
