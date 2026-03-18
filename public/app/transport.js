import { state } from "./state.js";
import { openTokenModal, renderHeader, renderQuota, showBanner, showToast } from "./ui.js";

export function clearReconnectTimer() {
  if (!state.reconnectTimer) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

export function sendRpc(command) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast("Not connected to Pi.", "error");
    return false;
  }
  state.socket.send(JSON.stringify({ kind: "rpc", command }));
  return true;
}

export function sendLocalCommand(command) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast("Not connected to Pi.", "error");
    return false;
  }

  state.socket.send(JSON.stringify({ kind: "local-command", command }));
  return true;
}

export function requestReload() {
  if (state.status?.isStreaming || state.snapshotState?.isStreaming) {
    showToast("Wait for the current response to finish before reloading.", "error");
    return false;
  }

  if (state.snapshotState?.isCompacting) {
    showToast("Wait for compaction to finish before reloading.", "error");
    return false;
  }

  return sendLocalCommand("reload");
}

export async function refreshQuota({ force = false } = {}) {
  const model = state.snapshotState?.model;
  const currentModel = model && typeof model === "object"
    ? {
        provider: typeof model.provider === "string" ? model.provider : "",
        modelId: typeof model.id === "string" ? model.id : "",
      }
    : null;

  if (!currentModel || currentModel.provider !== "openai-codex" || !/^gpt-/i.test(currentModel.modelId || "")) {
    state.quota = null;
    renderQuota();
    return;
  }

  const requestId = ++state.quotaRequestId;

  try {
    const url = new URL("/api/quota", window.location.origin);
    url.searchParams.set("provider", currentModel.provider);
    url.searchParams.set("modelId", currentModel.modelId);
    if (force) url.searchParams.set("force", "1");

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Quota request failed (${response.status})`);

    const quota = await response.json();
    if (requestId !== state.quotaRequestId) return;
    state.quota = quota;
  } catch {
    if (requestId !== state.quotaRequestId) return;
    if (!state.quota?.visible) {
      state.quota = null;
    }
  }

  renderQuota();
}

export function refreshAll(options = {}) {
  const { forceQuota = false } = options;

  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ kind: "refresh" }));
    sendRpc({ type: "get_commands" });
    sendRpc({ type: "get_available_models" });
  }

  void refreshQuota({ force: forceQuota });
}

export function connectSocket({ handleEnvelope, handleAuthFailure }) {
  clearReconnectTimer();
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  if (state.token) url.searchParams.set("token", state.token);

  const socket = new WebSocket(url);
  state.socket = socket;
  renderHeader();

  socket.addEventListener("open", () => {
    clearReconnectTimer();
    showBanner("");
    renderHeader();
    refreshAll();
  });

  socket.addEventListener("message", (event) => {
    try {
      handleEnvelope(JSON.parse(event.data));
    } catch {
      showToast("Received malformed data from server.", "error");
    }
  });

  socket.addEventListener("close", (event) => {
    if (state.socket === socket) {
      state.socket = null;
    }
    renderHeader();
    if (event.code === 4009) {
      showBanner("This Pi Phone instance was opened from another device or tab.", "error");
      return;
    }
    if (event.code === 4010) {
      showBanner("Pi Phone stopped due to inactivity. Run /phone-start again when needed.", "error");
      return;
    }
    if (event.code === 1008) {
      handleAuthFailure();
      return;
    }
    if (event.code === 1006) {
      showBanner("Connection lost. Retrying…", "error");
    }
    if (!state.manuallyClosed) {
      clearReconnectTimer();
      state.reconnectTimer = setTimeout(() => connectSocket({ handleEnvelope, handleAuthFailure }), 1800);
    }
  });

  socket.addEventListener("error", () => {
    renderHeader();
  });
}

export async function loadHealth() {
  const response = await fetch("/api/health", { cache: "no-store" });
  if (!response.ok) throw new Error(`Health check failed (${response.status})`);
  state.health = await response.json();
  state.status = state.health;
  renderHeader();
}

export async function boot({ handleEnvelope, handleAuthFailure }) {
  try {
    await loadHealth();
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Failed to reach server.", "error");
    return;
  }

  if (state.health?.hasToken && !state.token) openTokenModal();
  else connectSocket({ handleEnvelope, handleAuthFailure });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}
