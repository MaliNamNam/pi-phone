import { spawn, type ChildProcess } from "node:child_process";
import { bin as cloudflareBin } from "cloudflared";

let child: ChildProcess | null = null;
let tunnelUrl = "";

export async function enableCloudflareTunnel(port: number): Promise<{ url: string; error: string }> {
  if (child && !child.killed) {
    return { url: tunnelUrl, error: "" };
  }

  tunnelUrl = "";

  try {
    const spawned = spawn(cloudflareBin, ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child = spawned;

    return await new Promise<{ url: string; error: string }>((resolve) => {
      let settled = false;
      const finish = (url: string, error: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tunnelUrl = url;
        resolve({ url, error });
      };

      const timer = setTimeout(() => finish("", "cloudflared did not produce a tunnel URL within 15 seconds"), 15_000);

      const handleData = (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) finish(match[0], "");
      };

      spawned.stdout.on("data", handleData);
      spawned.stderr.on("data", handleData);

      spawned.once("error", (err) => {
        child = null;
        finish("", err.message);
      });

      spawned.once("exit", (code) => {
        child = null;
        finish("", `cloudflared exited with code ${code}`);
      });
    });
  } catch (err) {
    child = null;
    return { url: "", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function disableCloudflareTunnel(): Promise<{ error: string }> {
  const proc = child;
  if (!proc) {
    tunnelUrl = "";
    return { error: "" };
  }

  return new Promise<{ error: string }>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      child = null;
      tunnelUrl = "";
      resolve({ error: "" });
    };

    const forceKillTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { finish(); }
    }, 2000);

    proc.once("exit", finish);

    try {
      proc.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

export function getCloudflareTunnelInfo(): { active: boolean; url: string } {
  const active = child !== null && !child.killed;
  return { active, url: active ? tunnelUrl : "" };
}
