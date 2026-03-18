import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CodexUsageResponse,
  PhoneQuotaResponse,
  PhoneQuotaWindow,
  RateLimitBucket,
  UsageWindow,
} from "./types";

const agentDirFromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
const agentDir = agentDirFromEnv
  ? agentDirFromEnv
  : join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".pi", "agent");
const authFile = join(agentDir, "auth.json");
const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const sparkModelId = "gpt-5.3-codex-spark";
const sparkLimitName = "GPT-5.3-Codex-Spark";
const missingAuthErrorPrefix = "Missing openai-codex OAuth access/accountId";

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usedToLeftPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return clampPercent(100 - value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeRateLimitBucket(value: unknown): RateLimitBucket | null {
  const record = asObject(value);
  if (!record) return null;
  if (!("primary_window" in record || "secondary_window" in record || "limit_reached" in record || "allowed" in record)) {
    return null;
  }
  return record as RateLimitBucket;
}

function extractSparkRateLimitFromEntry(value: unknown): RateLimitBucket | null {
  const record = asObject(value);
  if (!record) return null;
  if (typeof record.limit_name !== "string" || record.limit_name.trim() !== sparkLimitName) return null;
  return normalizeRateLimitBucket(record.rate_limit);
}

function findSparkRateLimitBucket(data: CodexUsageResponse): RateLimitBucket | null {
  const additional = data.additional_rate_limits;

  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const bucket = extractSparkRateLimitFromEntry(entry);
      if (bucket) return bucket;
    }
    return null;
  }

  const additionalMap = asObject(additional);
  if (!additionalMap) return null;

  for (const value of Object.values(additionalMap)) {
    const bucket = extractSparkRateLimitFromEntry(value);
    if (bucket) return bucket;
  }

  return null;
}

function selectRateLimitBucket(data: CodexUsageResponse, modelId: string): RateLimitBucket | null {
  if (modelId === sparkModelId) {
    return findSparkRateLimitBucket(data);
  }
  return normalizeRateLimitBucket(data.rate_limit);
}

function getResetSeconds(window: UsageWindow | null | undefined): number | null {
  const resetAfterSeconds = window?.reset_after_seconds;
  if (typeof resetAfterSeconds === "number" && !Number.isNaN(resetAfterSeconds)) {
    return resetAfterSeconds;
  }

  const resetAt = window?.reset_at;
  if (typeof resetAt !== "number" || Number.isNaN(resetAt)) return null;

  const resetAtSeconds = resetAt > 100_000_000_000 ? resetAt / 1000 : resetAt;
  return Math.max(0, resetAtSeconds - Date.now() / 1000);
}

function buildQuotaWindow(label: "5h" | "7d", window: UsageWindow | null | undefined): PhoneQuotaWindow | null {
  const leftPercent = usedToLeftPercent(window?.used_percent);
  if (leftPercent === null) return null;

  const roundedLeftPercent = Math.round(leftPercent);
  const roundedUsedPercent = Math.round(clampPercent(typeof window?.used_percent === "number" ? window.used_percent : 100 - leftPercent));

  return {
    label,
    leftPercent: roundedLeftPercent,
    usedPercent: roundedUsedPercent,
    resetAfterSeconds: getResetSeconds(window),
    text: `${roundedLeftPercent}%`,
  };
}

function shouldShowQuotaForModel(provider: string | null | undefined, modelId: string | null | undefined): boolean {
  return provider === "openai-codex" && typeof modelId === "string" && /^gpt-/i.test(modelId);
}

async function loadCodexAuthCredentials(): Promise<{ accessToken: string; accountId: string }> {
  const authRaw = await readFile(authFile, "utf8");
  const auth = JSON.parse(authRaw) as Record<
    string,
    | {
        type?: string;
        access?: string | null;
        accountId?: string | null;
        account_id?: string | null;
      }
    | undefined
  >;

  const codexEntry = auth["openai-codex"];
  const authEntry = codexEntry?.type === "oauth" ? codexEntry : undefined;
  const accessToken = authEntry?.access?.trim();
  const accountId = (authEntry?.accountId ?? authEntry?.account_id)?.trim();

  if (!accessToken || !accountId) {
    throw new Error(`${missingAuthErrorPrefix} in ${authFile}`);
  }

  return { accessToken, accountId };
}

async function requestCodexUsageJson(): Promise<CodexUsageResponse> {
  const credentials = await loadCodexAuthCredentials();
  const response = await fetch(codexUsageUrl, {
    headers: {
      accept: "*/*",
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "content-type": "application/json",
      "user-agent": "codex-cli",
    },
  });

  if (!response.ok) {
    throw new Error(`Codex usage request failed (${response.status})`);
  }

  return (await response.json()) as CodexUsageResponse;
}

export async function getQuotaForModel(provider: string | null | undefined, modelId: string | null | undefined): Promise<PhoneQuotaResponse> {
  if (!shouldShowQuotaForModel(provider, modelId)) {
    return {
      visible: false,
      limited: false,
      primaryWindow: null,
      secondaryWindow: null,
    };
  }

  try {
    const usage = await requestCodexUsageJson();
    const selectedBucket = selectRateLimitBucket(usage, modelId || "");
    const primaryWindow = buildQuotaWindow("5h", selectedBucket?.primary_window);
    const secondaryWindow = buildQuotaWindow("7d", selectedBucket?.secondary_window);

    return {
      visible: Boolean(primaryWindow || secondaryWindow),
      limited: selectedBucket?.limit_reached === true || selectedBucket?.allowed === false,
      primaryWindow,
      secondaryWindow,
    };
  } catch (error) {
    return {
      visible: false,
      limited: false,
      primaryWindow: null,
      secondaryWindow: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
