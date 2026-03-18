import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedPhoneRuntime } from "./types";

const runtimeStateDir = join(tmpdir(), "pi-phone-extension");
export const phoneControlStopPath = "/__pi_phone__/control/stop";

function normalizeControlHost(host: string) {
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function isLoopbackAddress(address: string | undefined | null) {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function buildControlUrl(host: string, port: number, controlToken: string, pathname = phoneControlStopPath) {
  const url = new URL(`http://${normalizeControlHost(host)}:${port}`);
  url.pathname = pathname;
  url.searchParams.set("token", controlToken);
  return url;
}

export function getPersistedRuntimeStatePath(host: string, port: number) {
  const hostKey = ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"].includes(host)
    ? "local"
    : encodeURIComponent(host);
  return join(runtimeStateDir, `${hostKey}-${port}.json`);
}

export async function readPersistedRuntimeState(host: string, port: number): Promise<PersistedPhoneRuntime | null> {
  try {
    const payload = await readFile(getPersistedRuntimeStatePath(host, port), "utf8");
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.host !== "string" || typeof parsed.port !== "number" || typeof parsed.controlToken !== "string") {
      return null;
    }

    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      host: parsed.host,
      port: parsed.port,
      controlToken: parsed.controlToken,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

export async function writePersistedRuntimeState(host: string, port: number, controlToken: string) {
  const nextPath = getPersistedRuntimeStatePath(host, port);
  await mkdir(runtimeStateDir, { recursive: true });
  await writeFile(nextPath, JSON.stringify({
    pid: process.pid,
    host,
    port,
    controlToken,
    startedAt: new Date().toISOString(),
  } satisfies PersistedPhoneRuntime, null, 2), "utf8");
  return nextPath;
}

export async function removePersistedRuntimeState(pathToRemove: string | null) {
  if (!pathToRemove) return;

  try {
    await unlink(pathToRemove);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function isProcessRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPersistedRuntimeShutdown(runtime: PersistedPhoneRuntime, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    try {
      const healthUrl = buildControlUrl(runtime.host, runtime.port, runtime.controlToken, "/api/health");
      healthUrl.searchParams.delete("token");
      await fetch(healthUrl, { method: "GET" });
    } catch {
      return true;
    }
  }
  return false;
}

export async function stopPersistedRuntime(host: string, port: number) {
  const runtimeStatePath = getPersistedRuntimeStatePath(host, port);
  const runtime = await readPersistedRuntimeState(host, port);
  if (!runtime) {
    return { stopped: false, found: false, message: "No running Pi Phone instance was found for this port." };
  }

  try {
    const response = await fetch(buildControlUrl(runtime.host, runtime.port, runtime.controlToken), {
      method: "POST",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      return {
        stopped: false,
        found: true,
        message: `Pi Phone stop request failed with HTTP ${response.status}.`,
      };
    }

    const stopped = await waitForPersistedRuntimeShutdown(runtime);
    if (!stopped) {
      return {
        stopped: false,
        found: true,
        message: "Pi Phone received the stop request but is still shutting down. Try /phone-start again in a moment.",
      };
    }

    await removePersistedRuntimeState(runtimeStatePath);
    return { stopped: true, found: true, message: "Stopped the other Pi Phone instance." };
  } catch (error) {
    if (!isProcessRunning(runtime.pid)) {
      await removePersistedRuntimeState(runtimeStatePath);
      return {
        stopped: false,
        found: true,
        message: "Removed stale Pi Phone runtime state. Nothing was listening anymore.",
      };
    }

    return {
      stopped: false,
      found: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
