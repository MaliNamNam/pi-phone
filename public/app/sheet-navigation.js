import { renderSheet } from "./sheets-view.js";
import { el, state } from "./state.js";
import { sendRpc } from "./transport.js";

export function openSheet(mode = "actions") {
  state.sheetMode = mode;
  el.sheetModal.classList.remove("hidden");
  renderSheet();

  if (mode === "actions") sendRpc({ type: "get_session_stats" });
  if (mode === "models") sendRpc({ type: "get_available_models" });
  if (mode === "commands") sendRpc({ type: "get_commands" });
}

export function closeSheet() {
  el.sheetModal.classList.add("hidden");
}
