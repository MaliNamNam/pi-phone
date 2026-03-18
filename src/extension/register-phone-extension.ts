import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PhoneServerRuntime } from "./phone-server-runtime";

export default function registerPhoneExtension(pi: ExtensionAPI) {
  if (process.env.PI_PHONE_CHILD === "1") {
    return;
  }

  const runtime = new PhoneServerRuntime(pi);

  pi.registerCommand("phone-start", {
    description: "Start the phone web UI. Usage: /phone-start [port] [token] [--cwd path] [--host 127.0.0.1] [--idle-mins 20]",
    handler: async (args, ctx) => {
      await runtime.handlePhoneStart(args, ctx);
    },
  });

  pi.registerCommand("phone-stop", {
    description: "Stop the phone web UI server and remove the matching Tailscale Serve route",
    handler: async (_args, ctx) => {
      await runtime.handlePhoneStop(ctx);
    },
  });

  pi.registerCommand("phone-status", {
    description: "Show phone server and Tailscale Serve status",
    handler: async (_args, ctx) => {
      await runtime.handlePhoneStatus(ctx);
    },
  });

  pi.registerCommand("phone-token", {
    description: "Show the current phone UI token",
    handler: async (_args, ctx) => {
      runtime.handlePhoneToken(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await runtime.handleSessionStart(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await runtime.handleSessionSwitch(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.handleSessionShutdown(ctx);
  });
}
