import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function isPhoneServeProxyTarget(proxy: string, port: number) {
  try {
    const url = new URL(proxy);
    return url.protocol === "http:" && url.port === String(port) && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function getTailscaleUrl(pi: ExtensionAPI) {
  try {
    const status = await pi.exec("tailscale", ["status", "--json"], { timeout: 5000 });
    if (status.code !== 0) return "";

    const payload = JSON.parse(status.stdout || "{}");
    const dnsName = typeof payload?.Self?.DNSName === "string" ? payload.Self.DNSName.replace(/\.$/, "") : "";
    return dnsName ? `https://${dnsName}/` : "";
  } catch {
    return "";
  }
}

export async function getTailscaleServeInfo(pi: ExtensionAPI, port: number) {
  const url = await getTailscaleUrl(pi);
  try {
    const status = await pi.exec("tailscale", ["serve", "status", "--json"], { timeout: 5000 });
    if (status.code !== 0) {
      return {
        active: false,
        url,
        hadAnyWebConfig: false,
        error: (status.stderr || status.stdout || `tailscale serve status exited ${status.code}`).trim(),
      };
    }

    let payload: any;
    try {
      payload = JSON.parse(status.stdout || "{}");
    } catch {
      return {
        active: false,
        url,
        hadAnyWebConfig: false,
        error: "Failed to parse tailscale serve status output.",
      };
    }

    const services = Object.values(payload?.Web || {}) as any[];
    let active = false;
    for (const service of services) {
      const handlers = service?.Handlers || {};
      for (const handler of Object.values(handlers) as any[]) {
        if (typeof handler?.Proxy === "string" && isPhoneServeProxyTarget(handler.Proxy, port)) {
          active = true;
          break;
        }
      }
      if (active) break;
    }

    return {
      active,
      url,
      hadAnyWebConfig: services.length > 0,
      error: "",
    };
  } catch (error) {
    return {
      active: false,
      url,
      hadAnyWebConfig: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function enableTailscaleServe(pi: ExtensionAPI, port: number) {
  const before = await getTailscaleServeInfo(pi, port);
  if (before.active) {
    return {
      enabled: true,
      changed: false,
      replacedExisting: false,
      url: before.url,
      error: "",
    };
  }

  try {
    const target = `http://127.0.0.1:${port}`;
    const result = await pi.exec("tailscale", ["serve", "--bg", "--yes", "--https=443", target], { timeout: 5000 });
    if (result.code !== 0) {
      return {
        enabled: false,
        changed: false,
        replacedExisting: before.hadAnyWebConfig,
        url: before.url,
        error: (result.stderr || result.stdout || `tailscale serve exited ${result.code}`).trim(),
      };
    }

    const after = await getTailscaleServeInfo(pi, port);
    return {
      enabled: after.active || !after.error,
      changed: true,
      replacedExisting: before.hadAnyWebConfig,
      url: after.url || before.url,
      error: after.active ? "" : after.error,
    };
  } catch (error) {
    return {
      enabled: false,
      changed: false,
      replacedExisting: before.hadAnyWebConfig,
      url: before.url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disableMatchingTailscaleServe(pi: ExtensionAPI, port: number) {
  const info = await getTailscaleServeInfo(pi, port);
  if (!info.active) {
    return {
      disabled: false,
      error: info.error,
    };
  }

  try {
    const off = await pi.exec("tailscale", ["serve", "--yes", "--https=443", "off"], { timeout: 5000 });
    if (off.code === 0) {
      return { disabled: true, error: "" };
    }

    return {
      disabled: false,
      error: (off.stderr || off.stdout || `tailscale serve --https=443 off exited ${off.code}`).trim(),
    };
  } catch (error) {
    return {
      disabled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
