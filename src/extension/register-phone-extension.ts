import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PhoneServerRuntime } from "./phone-server-runtime";

export default function registerPhoneExtension(pi: ExtensionAPI) {
  const runtime = new PhoneServerRuntime(pi);

  pi.registerCommand("phone", {
    description: "Pi Phone subcommands: start, stop, status, token, pushover",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();
      const spaceIdx = trimmed.indexOf(" ");
      const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      switch (sub) {
        case "start":
          await runtime.handlePhoneStart(rest, ctx);
          break;
        case "stop":
          await runtime.handlePhoneStop(ctx);
          break;
        case "status":
          await runtime.handlePhoneStatus(ctx);
          break;
        case "token":
          runtime.handlePhoneToken(ctx);
          break;
        case "pushover":
          await runtime.handlePhonePushover(ctx);
          break;
        default:
          ctx.ui.notify(
            "Pi Phone commands:\n/phone start [port] [token] [--local] [--cwd path] [--host 127.0.0.1] [--idle-mins 20]\n/phone stop\n/phone status\n/phone token\n/phone pushover",
            "info",
          );
          await runtime.handlePhoneStatus(ctx);
      }
    },
  });

  // CLI input tracking
  pi.on("input", async (event, ctx) => {
    return runtime.handleInput(event, ctx);
  });

  // Session lifecycle → sync status UI + broadcast snapshot to phone
  pi.on("session_start", async (_event, ctx) => {
    await runtime.handleSessionStart(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await runtime.handleSessionSwitch(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    await runtime.handleSessionSwitch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await runtime.handleSessionSwitch(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await runtime.handleSessionSwitch(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.handleSessionShutdown(ctx);
  });

  // Event bridge: forward CLI session events to phone UI via WebSocket
  pi.on("agent_start", (event, ctx) => {
    runtime.bridgeAgentStart(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    runtime.bridgeAgentEnd(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    runtime.bridgeMessageUpdate(event, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    runtime.bridgeMessageEnd(event, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    runtime.bridgeToolExecutionStart(event, ctx);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    runtime.bridgeToolExecutionUpdate(event, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    runtime.bridgeToolExecutionEnd(event, ctx);
  });
}
