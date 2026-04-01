import type { WebSocket } from "ws";

export type PhoneConfig = {
  host: string;
  port: number;
  token: string;
  cwd: string;
  idleTimeoutMs: number;
  cfToken: string;
  cfHostname: string;
};

export type ParsedPhoneArgs = {
  config: PhoneConfig;
  tokenSpecified: boolean;
  idleSpecified: boolean;
  local: boolean;
  cfTokenSpecified: boolean;
};

export type PersistedPhoneRuntime = {
  pid: number;
  host: string;
  port: number;
  controlToken: string;
  startedAt: string;
};

export type PendingClientResponse = {
  ws: WebSocket;
  responseCommand?: string;
  responseData?: Record<string, unknown>;
};

export type UsageWindow = {
  used_percent?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
};

export type RateLimitBucket = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
};

export type CodexUsageResponse = {
  rate_limit?: RateLimitBucket | null;
  additional_rate_limits?: Record<string, unknown> | unknown[] | null;
};

export type PhoneQuotaWindow = {
  label: "5h" | "7d";
  leftPercent: number;
  usedPercent: number;
  resetAfterSeconds: number | null;
  text: string;
};

export type PhoneQuotaResponse = {
  visible: boolean;
  limited: boolean;
  primaryWindow: PhoneQuotaWindow | null;
  secondaryWindow: PhoneQuotaWindow | null;
  error?: string;
};

export type PhonePathSuggestionMode = "mention" | "cd";

export type PhonePathSuggestion = {
  value: string;
  label: string;
  description?: string;
  isDirectory: boolean;
  kind: "path" | "previous";
};
