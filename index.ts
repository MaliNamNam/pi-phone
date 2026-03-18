import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { PhoneSessionPool, type PhoneSessionWorker } from "./phone-session-pool";

type AnyCtx = ExtensionContext | ExtensionCommandContext;

type PhoneConfig = {
  host: string;
  port: number;
  token: string;
  cwd: string;
  idleTimeoutMs: number;
};

type ParsedPhoneArgs = {
  config: PhoneConfig;
  tokenSpecified: boolean;
  idleSpecified: boolean;
};

type PersistedPhoneRuntime = {
  pid: number;
  host: string;
  port: number;
  controlToken: string;
  startedAt: string;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingClientResponse = {
  ws: WebSocket;
  responseCommand?: string;
  responseData?: Record<string, unknown>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, "public");
const runtimeStateDir = join(tmpdir(), "pi-phone-extension");
const phoneControlStopPath = "/__pi_phone__/control/stop";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

type UsageWindow = {
  used_percent?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
};

type RateLimitBucket = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
};

type CodexUsageResponse = {
  rate_limit?: RateLimitBucket | null;
  additional_rate_limits?: Record<string, unknown> | unknown[] | null;
};

type PhoneQuotaWindow = {
  label: "5h" | "7d";
  leftPercent: number;
  usedPercent: number;
  resetAfterSeconds: number | null;
  text: string;
};

type PhoneQuotaResponse = {
  visible: boolean;
  limited: boolean;
  primaryWindow: PhoneQuotaWindow | null;
  secondaryWindow: PhoneQuotaWindow | null;
  error?: string;
};

const agentDirFromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
const agentDir = agentDirFromEnv
  ? agentDirFromEnv
  : join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".pi", "agent");
const authFile = join(agentDir, "auth.json");
const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const sparkModelId = "gpt-5.3-codex-spark";
const sparkLimitName = "GPT-5.3-Codex-Spark";
const missingAuthErrorPrefix = "Missing openai-codex OAuth access/accountId";
const PATH_SUGGESTION_LIMIT = 20;
const PATH_SUGGESTION_MAX_RESULTS = 100;

type PhonePathSuggestionMode = "mention" | "cd";

type PhonePathSuggestion = {
  value: string;
  label: string;
  description?: string;
  isDirectory: boolean;
  kind: "path" | "previous";
};

function resolveFdBinaryPath(): string | null {
  const bundledFd = join(agentDir, "bin", "fd");
  if (existsSync(bundledFd)) return bundledFd;

  for (const candidate of ["fd", "fdfind"]) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }

  return null;
}

const fdBinaryPath = resolveFdBinaryPath();

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolvePhoneCdTargetPath(rawArgs: string | undefined, currentCwd: string, previousCwd?: string | null): string {
  const input = stripWrappingQuotes(rawArgs ?? "").trim();

  if (!input) return homedir();
  if (input === "-") {
    if (!previousCwd) {
      throw new Error("No previous directory available yet.");
    }
    return previousCwd;
  }

  const expanded = expandHomePath(input);
  return resolve(currentCwd, expanded);
}

function createCdPathSuggestions(prefix: string, currentCwd: string, previousCwd?: string | null): PhonePathSuggestion[] {
  const raw = prefix ?? "";
  const trimmed = raw.trimStart();
  const suggestions: PhonePathSuggestion[] = [];

  if ("-".startsWith(trimmed)) {
    suggestions.push({
      value: "-",
      label: "-",
      description: previousCwd || "Previous directory",
      isDirectory: true,
      kind: "previous",
    });
  }

  const expanded = expandHomePath(trimmed);
  const endsWithSeparator = /[\\/]$/.test(expanded);
  const resolvedInput = expanded
    ? resolve(currentCwd, expanded)
    : currentCwd;

  const baseDir = expanded
    ? endsWithSeparator
      ? resolvedInput
      : dirname(resolvedInput)
    : currentCwd;

  const partial = expanded && !endsWithSeparator ? basename(expanded) : "";
  const valuePrefix = trimmed
    ? endsWithSeparator
      ? trimmed
      : trimmed.slice(0, Math.max(0, trimmed.length - partial.length))
    : "";

  try {
    if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
      return suggestions.slice(0, PATH_SUGGESTION_LIMIT);
    }

    const dirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return statSync(join(baseDir, entry.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .filter((entry) => !partial || entry.name.startsWith(partial))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of dirs.slice(0, PATH_SUGGESTION_LIMIT)) {
      suggestions.push({
        value: `${valuePrefix}${entry.name}/`,
        label: `${entry.name}/`,
        description: join(baseDir, entry.name),
        isDirectory: true,
        kind: "path",
      });
    }
  } catch {
    return suggestions.slice(0, PATH_SUGGESTION_LIMIT);
  }

  return suggestions.slice(0, PATH_SUGGESTION_LIMIT);
}

function resolveScopedMentionQuery(rawQuery: string, currentCwd: string): { baseDir: string; query: string; displayBase: string } | null {
  const slashIndex = rawQuery.lastIndexOf("/");
  if (slashIndex === -1) return null;

  const displayBase = rawQuery.slice(0, slashIndex + 1);
  const query = rawQuery.slice(slashIndex + 1);
  const baseDir = displayBase.startsWith("~/")
    ? expandHomePath(displayBase)
    : displayBase.startsWith("/")
      ? displayBase
      : join(currentCwd, displayBase);

  try {
    if (!statSync(baseDir).isDirectory()) return null;
  } catch {
    return null;
  }

  return { baseDir, query, displayBase };
}

function scopedPathForDisplay(displayBase: string, relativePath: string): string {
  if (displayBase === "/") return `/${relativePath}`;
  return `${displayBase}${relativePath}`;
}

function scorePhonePathEntry(filePath: string, query: string, isDirectory: boolean): number {
  if (!query) return isDirectory ? 2 : 1;

  const fileName = basename(filePath).toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let score = 0;

  if (fileName === normalizedQuery) score = 100;
  else if (fileName.startsWith(normalizedQuery)) score = 80;
  else if (fileName.includes(normalizedQuery)) score = 50;
  else if (filePath.toLowerCase().includes(normalizedQuery)) score = 30;

  if (isDirectory && score > 0) score += 10;
  return score;
}

function walkDirectoryWithFd(baseDir: string, query: string, maxResults = PATH_SUGGESTION_MAX_RESULTS) {
  if (!fdBinaryPath) return [] as Array<{ path: string; isDirectory: boolean }>;

  const args = [
    "--base-directory",
    baseDir,
    "--max-results",
    String(maxResults),
    "--type",
    "f",
    "--type",
    "d",
    "--full-path",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];

  if (query) args.push(query);

  const result = spawnSync(fdBinaryPath, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      path: line.endsWith("/") ? line.slice(0, -1) : line,
      isDirectory: line.endsWith("/"),
    }))
    .filter((entry) => entry.path !== ".git" && !entry.path.startsWith(".git/") && !entry.path.includes("/.git/"));
}

function createMentionPathSuggestions(query: string, currentCwd: string): PhonePathSuggestion[] {
  const scopedQuery = resolveScopedMentionQuery(query, currentCwd);
  const fdBaseDir = scopedQuery?.baseDir ?? currentCwd;
  const fdQuery = scopedQuery?.query ?? query;
  const entries = walkDirectoryWithFd(fdBaseDir, fdQuery, PATH_SUGGESTION_MAX_RESULTS);

  return entries
    .map((entry) => ({
      ...entry,
      score: scorePhonePathEntry(entry.path, fdQuery, entry.isDirectory),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, PATH_SUGGESTION_LIMIT)
    .map((entry) => {
      const displayPath = scopedQuery
        ? scopedPathForDisplay(scopedQuery.displayBase, entry.path)
        : entry.path;
      const completionPath = entry.isDirectory ? `${displayPath}/` : displayPath;
      return {
        value: completionPath,
        label: `${basename(entry.path)}${entry.isDirectory ? "/" : ""}`,
        description: displayPath,
        isDirectory: entry.isDirectory,
        kind: "path",
      };
    });
}

function listPhonePathSuggestions(
  mode: PhonePathSuggestionMode,
  query: string,
  currentCwd: string,
  previousCwd?: string | null,
): PhonePathSuggestion[] {
  return mode === "cd"
    ? createCdPathSuggestions(query, currentCwd, previousCwd)
    : createMentionPathSuggestions(query, currentCwd);
}

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

async function getQuotaForModel(provider: string | null | undefined, modelId: string | null | undefined): Promise<PhoneQuotaResponse> {
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

function sanitizePath(pathname: string): string | null {
  const normalized = normalize(pathname).replace(/^\/+/, "");
  const filePath = resolve(publicDir, normalized === "" ? "index.html" : normalized);
  if (!filePath.startsWith(publicDir)) return null;
  return filePath;
}

function parseArgs(args: string | undefined, current: PhoneConfig): ParsedPhoneArgs {
  const next = { ...current };
  let tokenSpecified = false;
  let idleSpecified = false;
  if (!args?.trim()) return { config: next, tokenSpecified, idleSpecified };

  const tokens = args.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--port" && tokens[i + 1]) {
      const port = Number(tokens[i + 1]);
      if (Number.isFinite(port) && port > 0) next.port = port;
      i += 2;
      continue;
    }
    if (token.startsWith("--port=")) {
      const port = Number(token.slice(7));
      if (Number.isFinite(port) && port > 0) next.port = port;
      i += 1;
      continue;
    }
    if (token === "--host" && tokens[i + 1]) {
      next.host = tokens[i + 1];
      i += 2;
      continue;
    }
    if (token.startsWith("--host=")) {
      next.host = token.slice(7);
      i += 1;
      continue;
    }
    if (token === "--token" && tokens[i + 1] !== undefined) {
      tokenSpecified = true;
      next.token = tokens[i + 1] === "-" ? "" : tokens[i + 1];
      i += 2;
      continue;
    }
    if (token.startsWith("--token=")) {
      tokenSpecified = true;
      const value = token.slice(8);
      next.token = value === "-" ? "" : value;
      i += 1;
      continue;
    }
    if (token === "--cwd" && tokens[i + 1]) {
      next.cwd = resolve(tokens[i + 1]);
      i += 2;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      next.cwd = resolve(token.slice(6));
      i += 1;
      continue;
    }
    if (token === "--idle-mins" && tokens[i + 1] !== undefined) {
      idleSpecified = true;
      const minutes = Number(tokens[i + 1]);
      if (Number.isFinite(minutes) && minutes >= 0) next.idleTimeoutMs = Math.round(minutes * 60_000);
      i += 2;
      continue;
    }
    if (token.startsWith("--idle-mins=")) {
      idleSpecified = true;
      const minutes = Number(token.slice(12));
      if (Number.isFinite(minutes) && minutes >= 0) next.idleTimeoutMs = Math.round(minutes * 60_000);
      i += 1;
      continue;
    }
    if (token === "--idle-secs" && tokens[i + 1] !== undefined) {
      idleSpecified = true;
      const seconds = Number(tokens[i + 1]);
      if (Number.isFinite(seconds) && seconds >= 0) next.idleTimeoutMs = Math.round(seconds * 1_000);
      i += 2;
      continue;
    }
    if (token.startsWith("--idle-secs=")) {
      idleSpecified = true;
      const seconds = Number(token.slice(12));
      if (Number.isFinite(seconds) && seconds >= 0) next.idleTimeoutMs = Math.round(seconds * 1_000);
      i += 1;
      continue;
    }
    if (/^\d+$/.test(token)) {
      next.port = Number(token);
      i += 1;
      continue;
    }
    if (!token.startsWith("--") && next.token === current.token) {
      tokenSpecified = true;
      next.token = token === "-" ? "" : token;
      i += 1;
      continue;
    }
    i += 1;
  }

  return { config: next, tokenSpecified, idleSpecified };
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_PHONE_CHILD === "1") {
    return;
  }

  let latestCtx: AnyCtx | null = null;
  let latestError = "";

  let config: PhoneConfig = {
    host: "127.0.0.1",
    port: 8787,
    token: process.env.PI_PHONE_TOKEN || "",
    cwd: process.cwd(),
    idleTimeoutMs: Number.isFinite(Number(process.env.PI_PHONE_IDLE_MINUTES))
      ? Math.max(0, Math.round(Number(process.env.PI_PHONE_IDLE_MINUTES) * 60_000))
      : 2 * 60 * 60_000,
  };

  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let sessionPool: PhoneSessionPool | null = null;
  const clients = new Set<WebSocket>();

  let child: ChildProcessWithoutNullStreams | null = null;
  let startPromise: Promise<void> | null = null;
  let stdoutBuffer = "";
  const decoder = new StringDecoder("utf8");
  let requestCounter = 0;
  const pendingRequests = new Map<string, PendingRequest>();
  const pendingClientResponses = new Map<string, PendingClientResponse>();
  let isStreaming = false;
  let currentSessionFile: string | null = null;
  let reloadPromise: Promise<void> | null = null;
  let isRestarting = false;
  let autoRestartTimer: NodeJS.Timeout | null = null;
  let idleStopTimer: NodeJS.Timeout | null = null;
  let lastActivityAt = Date.now();
  let runtimeControlToken = "";
  let activeRuntimeStatePath: string | null = null;

  function captureCtx(ctx: AnyCtx) {
    latestCtx = ctx;
  }

  function activeCwd() {
    return latestCtx?.cwd || config.cwd || process.cwd();
  }

  function rgbToHex(r: number, g: number, b: number) {
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function xterm256ToHex(index: number) {
    const ansi16 = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ];

    if (index >= 0 && index < ansi16.length) {
      return ansi16[index];
    }

    if (index >= 16 && index <= 231) {
      const cube = [0, 95, 135, 175, 215, 255];
      const value = index - 16;
      const r = cube[Math.floor(value / 36)] ?? 0;
      const g = cube[Math.floor((value % 36) / 6)] ?? 0;
      const b = cube[value % 6] ?? 0;
      return rgbToHex(r, g, b);
    }

    if (index >= 232 && index <= 255) {
      const gray = 8 + (index - 232) * 10;
      return rgbToHex(gray, gray, gray);
    }

    return "";
  }

  function ansiColorToCss(value: string | undefined) {
    if (!value) return "";

    const trueColorMatch = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(value);
    if (trueColorMatch) {
      return rgbToHex(Number(trueColorMatch[1]), Number(trueColorMatch[2]), Number(trueColorMatch[3]));
    }

    const color256Match = /\x1b\[38;5;(\d+)m/.exec(value);
    if (color256Match) {
      return xterm256ToHex(Number(color256Match[1]));
    }

    return "";
  }

  function buildThemePayload() {
    const theme = latestCtx?.ui.theme;
    if (!theme) return null;

    const colors = {
      accent: ansiColorToCss(theme.getFgAnsi("accent")),
      mdCode: ansiColorToCss(theme.getFgAnsi("mdCode")),
      mdCodeBlock: ansiColorToCss(theme.getFgAnsi("mdCodeBlock")),
      mdCodeBlockBorder: ansiColorToCss(theme.getFgAnsi("mdCodeBlockBorder")),
    };

    if (!Object.values(colors).some(Boolean)) {
      return null;
    }

    return {
      name: theme.name || "",
      colors,
    };
  }

  function parseSlashCommandText(text: unknown) {
    const value = typeof text === "string" ? text.trim() : "";
    if (!value.startsWith("/")) return null;

    const body = value.slice(1).trim();
    if (!body) return null;

    const spaceIndex = body.indexOf(" ");
    const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);

    return {
      text: `/${body}`,
      name,
    };
  }

  function buildSpawnArgs(sessionFile = currentSessionFile) {
    const args = ["--mode", "rpc"];
    if (sessionFile) {
      args.push("--session", sessionFile);
    }
    return args;
  }

  function rememberState(state: unknown) {
    if (!state || typeof state !== "object") return;

    const nextState = state as {
      isStreaming?: unknown;
      sessionFile?: unknown;
    };

    if (typeof nextState.isStreaming === "boolean") {
      isStreaming = nextState.isStreaming;
    }

    if (typeof nextState.sessionFile === "string" && nextState.sessionFile.trim()) {
      currentSessionFile = nextState.sessionFile;
    }
  }

  function buildStatus() {
    const theme = buildThemePayload();

    if (sessionPool) {
      const status = sessionPool.buildOverallStatus();
      return theme ? { ...status, theme } : status;
    }

    return {
      cwd: config.cwd,
      hasToken: Boolean(config.token),
      isRunning: Boolean(server),
      childRunning: false,
      isStreaming: false,
      lastError: latestError,
      pid: process.pid,
      childPid: null,
      piCommand: "pi --mode rpc",
      connectedClients: 0,
      sessionCount: 0,
      host: config.host,
      port: config.port,
      idleTimeoutMs: config.idleTimeoutMs,
      lastActivityAt,
      singleClientMode: true,
      ...(theme ? { theme } : {}),
    };
  }

  function generateToken() {
    const raw = randomBytes(12).toString("base64url");
    return `${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 16)}`;
  }

  function getPersistedRuntimeStatePath(host: string, port: number) {
    const hostKey = ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"].includes(host)
      ? "local"
      : encodeURIComponent(host);
    return join(runtimeStateDir, `${hostKey}-${port}.json`);
  }

  async function readPersistedRuntimeState(host: string, port: number): Promise<PersistedPhoneRuntime | null> {
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

  async function writePersistedRuntimeState(host: string, port: number, controlToken: string) {
    const nextPath = getPersistedRuntimeStatePath(host, port);
    await mkdir(runtimeStateDir, { recursive: true });
    await writeFile(nextPath, JSON.stringify({
      pid: process.pid,
      host,
      port,
      controlToken,
      startedAt: new Date().toISOString(),
    } satisfies PersistedPhoneRuntime, null, 2), "utf8");
    activeRuntimeStatePath = nextPath;
  }

  async function removePersistedRuntimeState(pathToRemove = activeRuntimeStatePath) {
    if (!pathToRemove) return;
    try {
      await unlink(pathToRemove);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (pathToRemove === activeRuntimeStatePath) {
      activeRuntimeStatePath = null;
    }
  }

  function isLoopbackAddress(address: string | undefined | null) {
    if (!address) return false;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  function normalizeControlHost(host: string) {
    if (!host || host === "0.0.0.0") return "127.0.0.1";
    if (host === "::" || host === "[::]") return "[::1]";
    if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
    return host;
  }

  function buildControlUrl(host: string, port: number, controlToken: string, pathname = phoneControlStopPath) {
    const url = new URL(`http://${normalizeControlHost(host)}:${port}`);
    url.pathname = pathname;
    url.searchParams.set("token", controlToken);
    return url;
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

  async function stopPersistedRuntime(host: string, port: number) {
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

  function isAddressInUseError(error: unknown) {
    const err = error as NodeJS.ErrnoException | null;
    return Boolean(err && (err.code === "EADDRINUSE" || err.message?.includes("EADDRINUSE")));
  }

  function isPhoneServeProxyTarget(proxy: string) {
    try {
      const url = new URL(proxy);
      return url.protocol === "http:" && url.port === String(config.port) && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    } catch {
      return false;
    }
  }

  async function getTailscaleUrl() {
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

  async function getTailscaleServeInfo() {
    const url = await getTailscaleUrl();
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
          if (typeof handler?.Proxy === "string" && isPhoneServeProxyTarget(handler.Proxy)) {
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

  async function enableTailscaleServe() {
    const before = await getTailscaleServeInfo();
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
      const target = `http://127.0.0.1:${config.port}`;
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

      const after = await getTailscaleServeInfo();
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

  async function disableMatchingTailscaleServe() {
    const info = await getTailscaleServeInfo();
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

  function clearIdleStopTimer() {
    if (idleStopTimer) {
      clearTimeout(idleStopTimer);
      idleStopTimer = null;
    }
  }

  function markActivity() {
    lastActivityAt = Date.now();
    scheduleIdleStop();
    broadcastStatus();
  }

  function scheduleIdleStop() {
    clearIdleStopTimer();
    if (!server || config.idleTimeoutMs <= 0) return;

    idleStopTimer = setTimeout(async () => {
      if (!server) return;
      const elapsed = Date.now() - lastActivityAt;
      if (elapsed < config.idleTimeoutMs) {
        scheduleIdleStop();
        return;
      }

      const idlePayload = {
        channel: "server",
        event: "idle-timeout",
        data: { message: `Pi Phone stopped after ${Math.round(config.idleTimeoutMs / 60000) || 1} minute(s) of inactivity.` },
      };

      if (sessionPool) {
        await sessionPool.closeAllClients({ payload: idlePayload, code: 4010, reason: "idle-timeout" });
      } else {
        broadcast(idlePayload);

        for (const client of clients) {
          try {
            client.close(4010, "idle-timeout");
          } catch {
            // ignore
          }
        }
      }

      await stopServer();
      await disableMatchingTailscaleServe();
    }, config.idleTimeoutMs);
  }

  function summarizeSessionEntry(entry: SessionEntry): {
    kind: string;
    preview: string;
    role?: string;
  } {
    if (entry.type === "message") {
      const message: any = entry.message;
      if (message.role === "user") {
        const preview = typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((part: any) => (part.type === "text" ? part.text || "" : part.type === "image" ? "[image]" : ""))
                .join(" ")
            : "";
        return { kind: "message", role: "user", preview: preview || "(user message)" };
      }
      if (message.role === "assistant") {
        const preview = Array.isArray(message.content)
          ? message.content
              .map((part: any) => (part.type === "text" ? part.text || "" : part.type === "toolCall" ? `[tool:${part.name || "tool"}]` : ""))
              .join(" ")
          : "";
        return { kind: "message", role: "assistant", preview: preview || "(assistant message)" };
      }
      if (message.role === "toolResult") {
        const preview = Array.isArray(message.content)
          ? message.content.map((part: any) => (part.type === "text" ? part.text || "" : "")).join(" ")
          : "";
        return { kind: "tool", role: message.toolName || "tool", preview: preview || `(${message.toolName || "tool"} result)` };
      }
      if (message.role === "custom") {
        return { kind: "custom", role: message.customType || "custom", preview: typeof message.content === "string" ? message.content : "(custom message)" };
      }
      if (message.role === "branchSummary") {
        return { kind: "summary", role: "branchSummary", preview: message.summary || "(branch summary)" };
      }
      if (message.role === "compactionSummary") {
        return { kind: "summary", role: "compactionSummary", preview: message.summary || "(compaction summary)" };
      }
      return { kind: "message", role: message.role, preview: `(${message.role || "message"})` };
    }

    if (entry.type === "compaction") {
      return { kind: "compaction", preview: entry.summary || "(compaction)" };
    }
    if (entry.type === "branch_summary") {
      return { kind: "branch_summary", preview: entry.summary || "(branch summary)" };
    }
    if (entry.type === "session_info") {
      return { kind: "session_info", preview: entry.name || "(session info)" };
    }
    if (entry.type === "label") {
      return { kind: "label", preview: entry.label || "(label cleared)" };
    }
    if (entry.type === "model_change") {
      return { kind: "model_change", preview: `${entry.provider}/${entry.modelId}` };
    }
    if (entry.type === "thinking_level_change") {
      return { kind: "thinking_level_change", preview: entry.thinkingLevel || "(thinking change)" };
    }
    if (entry.type === "custom") {
      return { kind: "custom", preview: entry.customType || "(custom entry)" };
    }

    return { kind: entry.type, preview: `(${entry.type})` };
  }

  function flattenTreeNode(node: any, depth = 0, out: any[] = []): any[] {
    const summary = summarizeSessionEntry(node.entry as SessionEntry);
    out.push({
      id: node.entry.id,
      parentId: node.entry.parentId,
      type: node.entry.type,
      depth,
      timestamp: node.entry.timestamp,
      label: node.label,
      childCount: Array.isArray(node.children) ? node.children.length : 0,
      summary,
    });
    for (const childNode of node.children || []) {
      flattenTreeNode(childNode, depth + 1, out);
    }
    return out;
  }

  async function listSessionsForCwd(cwd: string) {
    const sessions = await SessionManager.list(cwd);
    return sessions.map((session) => ({
      path: session.path,
      id: session.id,
      cwd: session.cwd,
      name: session.name,
      parentSessionPath: session.parentSessionPath,
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
    }));
  }

  async function getCurrentSessionFile() {
    const stateResponse = await request({ type: "get_state" });
    rememberState(stateResponse.data);
    return stateResponse.data?.sessionFile as string | undefined;
  }

  async function getTreeState() {
    const sessionFile = await getCurrentSessionFile();
    if (!sessionFile) {
      throw new Error("No session file available for tree view.");
    }

    const sessionManager = SessionManager.open(sessionFile);
    const branch = sessionManager.getBranch();
    const currentPathIds = new Set(branch.map((entry) => entry.id));
    const roots = sessionManager.getTree();
    const nodes = roots.flatMap((root) => flattenTreeNode(root));

    return {
      sessionFile,
      currentLeafId: sessionManager.getLeafId(),
      currentPathIds: [...currentPathIds],
      nodes,
    };
  }

  async function createBranchSessionFromEntry(entryId: string) {
    const sessionFile = await getCurrentSessionFile();
    if (!sessionFile) {
      throw new Error("No active session file.");
    }

    const sessionManager = SessionManager.open(sessionFile);
    const nextPath = sessionManager.createBranchedSession(entryId);
    if (!nextPath) {
      throw new Error("Failed to create branch session.");
    }
    return nextPath;
  }

  async function getActiveWorkerForClient(ws: WebSocket) {
    if (!sessionPool) {
      throw new Error("Pi Phone session pool is not running.");
    }
    return sessionPool.getActiveWorker(ws);
  }

  async function getCurrentSessionFileForWorker(worker: PhoneSessionWorker) {
    const stateResponse = await worker.request({ type: "get_state" });
    return stateResponse.data?.sessionFile as string | undefined;
  }

  async function getTreeStateForWorker(worker: PhoneSessionWorker) {
    const sessionFile = await getCurrentSessionFileForWorker(worker);
    if (!sessionFile) {
      throw new Error("No session file available for tree view.");
    }

    const sessionManager = SessionManager.open(sessionFile);
    const branch = sessionManager.getBranch();
    const currentPathIds = new Set(branch.map((entry) => entry.id));
    const roots = sessionManager.getTree();
    const nodes = roots.flatMap((root) => flattenTreeNode(root));

    return {
      sessionFile,
      currentLeafId: sessionManager.getLeafId(),
      currentPathIds: [...currentPathIds],
      nodes,
    };
  }

  async function createBranchSessionFromEntryForWorker(worker: PhoneSessionWorker, entryId: string) {
    const sessionFile = await getCurrentSessionFileForWorker(worker);
    if (!sessionFile) {
      throw new Error("No active session file.");
    }

    const sessionManager = SessionManager.open(sessionFile);
    const nextPath = sessionManager.createBranchedSession(entryId);
    if (!nextPath) {
      throw new Error("Failed to create branch session.");
    }
    return nextPath;
  }

  async function resolveRemoteSlashCommandForWorker(worker: PhoneSessionWorker, text: unknown) {
    const parsed = parseSlashCommandText(text);
    if (!parsed) return null;

    const commandsResponse = await worker.request({ type: "get_commands" });
    if (!commandsResponse?.success) {
      throw new Error(commandsResponse?.error || "Failed to read available slash commands.");
    }

    const match = (commandsResponse.data?.commands || []).find((command: any) => command?.name === parsed.name);
    if (!match) return null;

    return {
      ...parsed,
      source: typeof match.source === "string" ? match.source : "extension",
    };
  }

  async function dispatchRemoteSlashCommandForWorker(
    worker: PhoneSessionWorker,
    ws: WebSocket,
    input: {
      text: string;
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
    },
    options: {
      responseCommand?: string;
      responseData?: Record<string, unknown>;
      onSuccess?: () => void;
      onError?: () => void;
    } = {},
  ) {
    const slashCommand = await resolveRemoteSlashCommandForWorker(worker, input.text);
    if (!slashCommand) {
      send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: options.responseCommand || "slash_command",
          success: false,
          error: `Unknown slash command: ${typeof input.text === "string" ? input.text : ""}`.trim() || "Unknown slash command.",
        },
      });
      return false;
    }

    const images = Array.isArray(input.images) ? input.images : [];
    if (slashCommand.source === "extension" && images.length > 0) {
      send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: options.responseCommand || "slash_command",
          success: false,
          error: "Extension slash commands do not support image attachments.",
        },
      });
      return false;
    }

    const childCommand: Record<string, unknown> = {
      type: "prompt",
      message: slashCommand.text,
    };

    if (images.length > 0) {
      childCommand.images = images;
    }

    if (slashCommand.source !== "extension" && (input.streamingBehavior === "steer" || input.streamingBehavior === "followUp")) {
      childCommand.streamingBehavior = input.streamingBehavior;
    }

    await worker.sendClientCommand(childCommand, {
      ws,
      responseCommand: options.responseCommand || "slash_command",
      responseData: {
        name: slashCommand.name,
        source: slashCommand.source,
        ...(options.responseData || {}),
      },
      onSuccess: options.onSuccess,
      onError: options.onError,
    });

    return true;
  }

  function send(ws: WebSocket, payload: unknown) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function broadcast(payload: unknown) {
    for (const client of clients) {
      send(client, payload);
    }
  }

  function broadcastStatus() {
    if (sessionPool) {
      sessionPool.broadcastStatus();
      return;
    }

    broadcast({ channel: "server", event: "status", data: buildStatus() });
  }

  function rejectAllPending(error: Error) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
    pendingClientResponses.clear();
  }

  function clearAutoRestartTimer() {
    if (autoRestartTimer) {
      clearTimeout(autoRestartTimer);
      autoRestartTimer = null;
    }
  }

  function scheduleRestartIfNeeded() {
    if (clients.size === 0) return;
    clearAutoRestartTimer();
    autoRestartTimer = setTimeout(() => {
      ensureChildStarted().catch((error) => {
        latestError = error instanceof Error ? error.message : String(error);
        broadcastStatus();
      });
    }, 1500);
  }

  function handleRpcLine(line: string) {
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      latestError = `Failed to parse child rpc output: ${line.slice(0, 200)}`;
      broadcast({ channel: "server", event: "parse-error", data: { line, error: String(error) } });
      broadcastStatus();
      return;
    }

    markActivity();

    if (payload.type === "response" && typeof payload.id === "string") {
      if (payload.success && payload.command === "get_state") {
        rememberState(payload.data);
      }

      const pending = pendingRequests.get(payload.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(payload.id);
        pending.resolve(payload);
      }

      const clientForResponse = pendingClientResponses.get(payload.id);
      if (clientForResponse) {
        pendingClientResponses.delete(payload.id);
        const nextPayload = {
          ...payload,
          ...(clientForResponse.responseCommand ? { command: clientForResponse.responseCommand } : {}),
          ...(payload.success && clientForResponse.responseData
            ? { data: { ...(payload.data || {}), ...clientForResponse.responseData } }
            : {}),
        };
        send(clientForResponse.ws, { channel: "rpc", payload: nextPayload });
      }
      return;
    }

    if (payload.type === "agent_start") {
      isStreaming = true;
      broadcastStatus();
    }

    if (payload.type === "agent_end") {
      isStreaming = false;
      broadcastStatus();
    }

    broadcast({ channel: "rpc", payload });
  }

  function handleStdoutChunk(chunk: Buffer | string) {
    stdoutBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.length) continue;
      handleRpcLine(line);
    }
  }

  async function ensureChildStarted(startOptions: { sessionFile?: string | null } = {}) {
    if (child) return;
    if (startPromise) return startPromise;

    const sessionFile = startOptions.sessionFile ?? currentSessionFile;

    startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const spawned = spawn("pi", buildSpawnArgs(sessionFile), {
        cwd: config.cwd,
        env: {
          ...process.env,
          PI_PHONE_CHILD: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;

      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        latestError = error.message;
        child = null;
        broadcastStatus();
        rejectPromise(error);
      };

      spawned.once("error", (error) => {
        failStart(error instanceof Error ? error : new Error(String(error)));
      });

      spawned.stdout.on("data", (chunk) => {
        handleStdoutChunk(chunk);
      });

      spawned.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        latestError = text.trim() || latestError;
        broadcast({ channel: "server", event: "stderr", data: { text } });
        broadcastStatus();
      });

      spawned.once("exit", (code, signal) => {
        const message = `pi rpc exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`;
        const restarting = isRestarting;
        if (!settled) {
          failStart(new Error(message));
          return;
        }

        child = null;
        isStreaming = false;
        rejectAllPending(new Error(restarting ? "Pi rpc is reloading." : message));

        if (restarting) {
          latestError = "";
          broadcastStatus();
          return;
        }

        latestError = message;
        broadcast({ channel: "server", event: "agent-exit", data: { code, signal, message } });
        broadcastStatus();
        scheduleRestartIfNeeded();
      });

      child = spawned;
      latestError = "";
      stdoutBuffer = "";
      markActivity();
      broadcastStatus();

      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolvePromise();
      }, 300);
    }).finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function stopChildForRestart() {
    const runningChild = child;
    if (!runningChild) return;

    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        resolvePromise();
      };

      const forceKillTimer = setTimeout(() => {
        try {
          runningChild.kill("SIGKILL");
        } catch {
          finish();
        }
      }, 2000);

      runningChild.once("exit", finish);

      try {
        runningChild.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  async function reloadChild() {
    if (reloadPromise) return reloadPromise;

    reloadPromise = (async () => {
      await ensureChildStarted();

      const stateResponse = await request({ type: "get_state" });
      if (!stateResponse?.success) {
        throw new Error(stateResponse?.error || "Failed to read Pi state before reload.");
      }

      const nextState = stateResponse.data || {};
      rememberState(nextState);

      if (nextState.isStreaming) {
        throw new Error("Wait for the current response to finish before reloading.");
      }

      if (nextState.isCompacting) {
        throw new Error("Wait for compaction to finish before reloading.");
      }

      isRestarting = true;
      broadcast({
        channel: "server",
        event: "reloading",
        data: { message: "Reloading extensions, skills, prompts, and themes…" },
      });

      await stopChildForRestart();
      await ensureChildStarted({ sessionFile: currentSessionFile });
      await broadcastSnapshots();
    })().finally(() => {
      isRestarting = false;
      broadcast({ channel: "server", event: "reloading", data: { message: "" } });
      reloadPromise = null;
    });

    return reloadPromise;
  }

  async function request(command: Record<string, unknown>, timeoutMs = 30000) {
    await ensureChildStarted();
    if (!child) throw new Error("pi rpc child is not running");

    const id = `srv-${++requestCounter}`;
    const payload = { ...command, id };

    return new Promise<any>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        rejectPromise(new Error(`Timed out waiting for child response to ${String(command.type)}`));
      }, timeoutMs);

      pendingRequests.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });

      child!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async function sendSnapshot(ws: WebSocket) {
    if (!sessionPool) {
      throw new Error("Pi Phone session pool is not running.");
    }
    await sessionPool.refreshActiveSnapshot(ws);
  }

  async function broadcastSnapshots() {
    if (!sessionPool) return;
    await sessionPool.broadcastSnapshots();
  }

  async function resolveRemoteSlashCommand(text: unknown) {
    const parsed = parseSlashCommandText(text);
    if (!parsed) return null;

    const commandsResponse = await request({ type: "get_commands" });
    if (!commandsResponse?.success) {
      throw new Error(commandsResponse?.error || "Failed to read available slash commands.");
    }

    const match = (commandsResponse.data?.commands || []).find((command: any) => command?.name === parsed.name);
    if (!match) return null;

    return {
      ...parsed,
      source: typeof match.source === "string" ? match.source : "extension",
    };
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    markActivity();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === phoneControlStopPath) {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      if (!runtimeControlToken || url.searchParams.get("token") !== runtimeControlToken || !isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        stopServer().catch((error) => {
          latestError = error instanceof Error ? error.message : String(error);
          broadcastStatus();
        });
      }, 0);
      return;
    }

    if (url.pathname === "/api/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(buildStatus()));
      return;
    }

    if (url.pathname === "/api/quota") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const quota = await getQuotaForModel(url.searchParams.get("provider"), url.searchParams.get("modelId"));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(JSON.stringify(quota));
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = sanitizePath(pathname);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    try {
      const body = await readFile(filePath);
      const extension = extname(filePath);
      const cacheControl = [".html", ".js", ".css", ".webmanifest", ".json"].includes(extension) || pathname === "/sw.js"
        ? "no-store"
        : "public, max-age=60";
      res.writeHead(200, {
        "Content-Type": mimeTypes[extension] || "application/octet-stream",
        "Cache-Control": cacheControl,
      });
      if (req.method === "GET") res.end(body);
      else res.end();
    } catch {
      try {
        const body = await readFile(join(publicDir, "index.html"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to serve file" }));
      }
    }
  }

  async function startServer() {
    if (server) return;

    sessionPool = new PhoneSessionPool({
      cwd: config.cwd,
      send,
      onActivity: markActivity,
      buildStatusMeta: () => {
        const theme = buildThemePayload();
        return {
          cwd: config.cwd,
          hasToken: Boolean(config.token),
          host: config.host,
          port: config.port,
          idleTimeoutMs: config.idleTimeoutMs,
          lastActivityAt,
          singleClientMode: true,
          pid: process.pid,
          piCommand: "pi --mode rpc",
          serverRunning: Boolean(server),
          ...(theme ? { theme } : {}),
        };
      },
    });

    server = createServer((req, res) => {
      handleHttp(req, res).catch((error) => {
        latestError = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: latestError }));
        broadcastStatus();
      });
    });

    wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws: WebSocket) => {
      if (sessionPool && sessionPool.clientCount > 0) {
        sessionPool.closeAllClients({
          payload: {
            channel: "server",
            event: "single-client-replaced",
            data: { message: "This Pi Phone instance was opened from another device or tab." },
          },
          code: 4009,
          reason: "replaced-by-new-client",
        }).catch(() => {});
      }

      clients.add(ws);
      markActivity();
      sessionPool?.addClient(ws).catch((error) => {
        send(ws, {
          channel: "server",
          event: "snapshot-error",
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      });
      broadcastStatus();

      ws.on("close", () => {
        clients.delete(ws);
        sessionPool?.removeClient(ws);
        markActivity();
        broadcastStatus();
      });

      ws.on("message", (raw: RawData) => {
        markActivity();
        handleClientMessage(ws, raw.toString()).catch((error) => {
          send(ws, {
            channel: "server",
            event: "client-error",
            data: { message: error instanceof Error ? error.message : String(error) },
          });
        });
      });
    });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      const tokenMismatch = Boolean(config.token && url.searchParams.get("token") !== config.token);

      wss?.handleUpgrade(req, socket, head, (ws) => {
        if (tokenMismatch) {
          ws.close(1008, "invalid-token");
          return;
        }

        wss?.emit("connection", ws, req);
      });
    });

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server?.once("error", rejectPromise);
        server?.listen(config.port, config.host, () => resolvePromise());
      });

      latestError = "";
      runtimeControlToken = generateToken();
      markActivity();
      await sessionPool.ensureDefaultWorker();
      await writePersistedRuntimeState(config.host, config.port, runtimeControlToken);
      broadcastStatus();
      syncStatusUi();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stopServer();
      latestError = message;
      broadcastStatus();
      syncStatusUi();
      throw error;
    }
  }

  async function stopServer() {
    clearAutoRestartTimer();
    clearIdleStopTimer();

    const runtimeStatePath = activeRuntimeStatePath;
    runtimeControlToken = "";

    if (sessionPool) {
      await sessionPool.dispose();
      sessionPool = null;
    }

    if (wss) {
      const runningWss = wss;
      clients.clear();
      await new Promise<void>((resolvePromise) => {
        runningWss.close(() => resolvePromise());
      });
      wss = null;
    }

    if (server) {
      const runningServer = server;
      await new Promise<void>((resolvePromise) => {
        try {
          runningServer.close(() => resolvePromise());
        } catch {
          resolvePromise();
        }
      });
      server = null;
    }

    if (child) {
      child.kill("SIGTERM");
      child = null;
    }

    await removePersistedRuntimeState(runtimeStatePath);
    isStreaming = false;
    rejectAllPending(new Error("pi phone stopped"));
    latestError = "";
    broadcastStatus();
    syncStatusUi();
  }

  async function handleClientMessage(ws: WebSocket, raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      send(ws, { channel: "server", event: "client-error", data: { message: "Invalid JSON from client." } });
      return;
    }

    if (!sessionPool) {
      throw new Error("Pi Phone session pool is not running.");
    }

    if (message.kind === "refresh") {
      await sessionPool.refreshActiveSnapshot(ws);
      return;
    }

    if (message.kind === "session-select") {
      await sessionPool.selectSession(ws, String(message.sessionId || ""));
      return;
    }

    if (message.kind === "session-spawn") {
      await sessionPool.spawnSession(ws);
      send(ws, { channel: "server", event: "session-spawned", data: { message: "Opened new active session." } });
      return;
    }

    if (message.kind === "local-command") {
      const worker = await getActiveWorkerForClient(ws);

      if (message.command === "reload") {
        try {
          await worker.reload();
          send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "reload",
              success: true,
              data: { sessionFile: worker.currentSessionFile },
            },
          });
          await sessionPool.refreshActiveSnapshot(ws);
        } catch (error) {
          send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "reload",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message.command && typeof message.command === "object" && message.command.type === "path-suggestions") {
        try {
          const mode = message.command.mode === "cd" ? "cd" : "mention";
          const query = typeof message.command.query === "string" ? message.command.query : "";
          const suggestions = listPhonePathSuggestions(mode, query, worker.cwd, worker.previousCwd);

          send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "path_suggestions",
              success: true,
              data: {
                mode,
                query,
                cwd: worker.cwd,
                requestId: Number(message.command.requestId) || 0,
                suggestions,
              },
            },
          });
        } catch (error) {
          send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "path_suggestions",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message.command && typeof message.command === "object" && message.command.type === "cd") {
        try {
          const args = typeof message.command.args === "string" ? message.command.args : "";
          const nextCwd = resolvePhoneCdTargetPath(args, worker.cwd, worker.previousCwd);

          if (!existsSync(nextCwd)) {
            throw new Error(`Directory does not exist: ${nextCwd}`);
          }
          if (!statSync(nextCwd).isDirectory()) {
            throw new Error(`Not a directory: ${nextCwd}`);
          }

          const previousCwd = worker.cwd;
          const slashText = args.trim() ? `/cd ${args}` : "/cd";
          const dispatched = await dispatchRemoteSlashCommandForWorker(
            worker,
            ws,
            { text: slashText },
            {
              responseCommand: "cd",
              responseData: { cwd: nextCwd, previousCwd },
              onSuccess: () => {
                worker.setTrackedCwd(nextCwd, previousCwd);
                sessionPool?.setCwd(nextCwd);
                config.cwd = nextCwd;
              },
            },
          );

          if (!dispatched) return;
        } catch (error) {
          send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "cd",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message.command && typeof message.command === "object" && message.command.type === "slash-command") {
        try {
          await dispatchRemoteSlashCommandForWorker(worker, ws, {
            text: String(message.command.text || ""),
            images: Array.isArray(message.command.images) ? message.command.images : [],
            streamingBehavior: message.command.streamingBehavior === "steer" ? "steer" : message.command.streamingBehavior === "followUp" ? "followUp" : undefined,
          });
        } catch (error) {
          send(ws, {
            channel: "rpc",
            payload: {
              type: "response",
              command: "slash_command",
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      send(ws, { channel: "server", event: "client-error", data: { message: "Unsupported local command." } });
      return;
    }

    if (message.kind !== "rpc" || !message.command || typeof message.command !== "object") {
      send(ws, { channel: "server", event: "client-error", data: { message: "Unsupported client command." } });
      return;
    }

    const command = { ...message.command };

    if (command.type === "phone_list_sessions") {
      const worker = await getActiveWorkerForClient(ws);
      const sessions = await listSessionsForCwd(worker.cwd || config.cwd);
      send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: "phone_list_sessions",
          success: true,
          data: { sessions, cwd: worker.cwd || config.cwd },
          ...(command.id ? { id: command.id } : {}),
        },
      });
      return;
    }

    const worker = await getActiveWorkerForClient(ws);

    if (command.type === "phone_get_tree") {
      const tree = await getTreeStateForWorker(worker);
      send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: "phone_get_tree",
          success: true,
          data: tree,
          ...(command.id ? { id: command.id } : {}),
        },
      });
      return;
    }

    if (command.type === "phone_open_branch_path") {
      const nextPath = await createBranchSessionFromEntryForWorker(worker, String(command.entryId || ""));
      const switchResponse = await worker.request({ type: "switch_session", sessionPath: nextPath });
      send(ws, {
        channel: "rpc",
        payload: {
          type: "response",
          command: "phone_open_branch_path",
          success: true,
          data: { path: nextPath, switchResult: switchResponse.data },
          ...(command.id ? { id: command.id } : {}),
        },
      });
      await sessionPool.refreshActiveSnapshot(ws);
      broadcastStatus();
      return;
    }

    await worker.sendClientCommand(command, { ws });
  }

  function updateStatusUi(ctx: AnyCtx) {
    const theme = ctx.ui.theme;
    if (server) {
      const dot = theme.fg("success", "●");
      const label = theme.fg("muted", " phone on");
      ctx.ui.setStatus("pi-phone", `📱 ${dot}${label}`);
    } else {
      const dot = theme.fg("dim", "○");
      const label = theme.fg("dim", " phone off");
      ctx.ui.setStatus("pi-phone", `📱 ${dot}${label}`);
    }
  }

  function syncStatusUi() {
    if (!latestCtx) return;
    updateStatusUi(latestCtx);
  }

  function statusText() {
    const url = `http://${config.host}:${config.port}`;
    const idleMinutes = config.idleTimeoutMs > 0 ? `${Math.max(1, Math.round(config.idleTimeoutMs / 60_000))}m idle auto-stop` : "idle auto-stop disabled";
    return server
      ? `Pi Phone running at ${url} for ${config.cwd}${config.token ? " (token enabled)" : " (no token)"} · ${idleMinutes}`
      : "Pi Phone is stopped";
  }

  pi.registerCommand("phone-start", {
    description: "Start the phone web UI. Usage: /phone-start [port] [token] [--cwd path] [--host 127.0.0.1] [--idle-mins 20]",
    handler: async (args, ctx) => {
      captureCtx(ctx);
      config.cwd = activeCwd();
      const parsed = parseArgs(args, config);
      const nextConfig = parsed.config;

      if (!nextConfig.token && !parsed.tokenSpecified) {
        nextConfig.token = generateToken();
      }

      const changed = ["host", "port", "token", "cwd", "idleTimeoutMs"].some((key) => nextConfig[key as keyof PhoneConfig] !== config[key as keyof PhoneConfig]);
      const generatedToken = nextConfig.token && nextConfig.token !== config.token && !parsed.tokenSpecified;
      config = nextConfig;

      if (server && changed) {
        await stopServer();
      }

      if (!server) {
        try {
          await startServer();
        } catch (error) {
          if (isAddressInUseError(error)) {
            latestError = error instanceof Error ? error.message : String(error);
            updateStatusUi(ctx);
            const existingRuntime = await readPersistedRuntimeState(config.host, config.port);
            ctx.ui.notify(
              existingRuntime
                ? `Another Pi Phone instance is already using ${config.host}:${config.port}. Run /phone-stop, then /phone-start again.`
                : `Port ${config.host}:${config.port} is already in use. If it is another Pi Phone instance, run /phone-stop, then /phone-start again.`,
              "warning",
            );
            return;
          }
          throw error;
        }
      }

      await sessionPool?.ensureDefaultWorker();
      const tailscale = await enableTailscaleServe();
      updateStatusUi(ctx);
      ctx.ui.notify(statusText(), "info");
      if (tailscale.enabled) {
        if (tailscale.changed) {
          ctx.ui.notify(`Tailscale Serve ready${tailscale.url ? `: ${tailscale.url}` : " for this device."}`, "info");
          if (tailscale.replacedExisting) {
            ctx.ui.notify("Updated the current Tailscale Serve web route to point to Pi Phone.", "warning");
          }
        } else {
          ctx.ui.notify(`Tailscale Serve already points to Pi Phone${tailscale.url ? `: ${tailscale.url}` : "."}`, "info");
        }
      } else if (tailscale.error) {
        ctx.ui.notify(`Could not configure Tailscale Serve automatically: ${tailscale.error}`, "warning");
        ctx.ui.notify(`Manual fallback: tailscale serve --bg --https=443 http://127.0.0.1:${config.port}`, "info");
      }
      if (generatedToken) {
        ctx.ui.notify(`Generated token: ${config.token}`, "warning");
      } else if (config.token) {
        ctx.ui.notify("Token required: use the token you started this server with.", "info");
      }
    },
  });

  pi.registerCommand("phone-stop", {
    description: "Stop the phone web UI server and remove the matching Tailscale Serve route",
    handler: async (_args, ctx) => {
      captureCtx(ctx);
      const hadLocalServer = Boolean(server);
      await stopServer();
      const externalStop = hadLocalServer ? null : await stopPersistedRuntime(config.host, config.port);
      const tailscale = await disableMatchingTailscaleServe();
      updateStatusUi(ctx);

      if (hadLocalServer || externalStop?.stopped) {
        if (tailscale.disabled) {
          ctx.ui.notify("Pi Phone stopped and matching Tailscale Serve route disabled", "info");
        } else {
          ctx.ui.notify("Pi Phone stopped", "info");
          if (tailscale.error) {
            ctx.ui.notify(`Could not disable Tailscale Serve automatically: ${tailscale.error}`, "warning");
          }
        }
        return;
      }

      if (externalStop?.found && externalStop.message) {
        const kind = externalStop.message.startsWith("Removed stale") ? "info" : "warning";
        ctx.ui.notify(externalStop.message, kind);
      } else {
        ctx.ui.notify("Pi Phone is already stopped.", "info");
      }

      if (tailscale.disabled) {
        ctx.ui.notify("Disabled the matching Tailscale Serve route.", "info");
      } else if (tailscale.error) {
        ctx.ui.notify(`Could not disable Tailscale Serve automatically: ${tailscale.error}`, "warning");
      }
    },
  });

  pi.registerCommand("phone-status", {
    description: "Show phone server and Tailscale Serve status",
    handler: async (_args, ctx) => {
      captureCtx(ctx);
      updateStatusUi(ctx);
      ctx.ui.notify(statusText(), server ? "info" : "warning");

      const tailscale = await getTailscaleServeInfo();
      if (tailscale.active) {
        if (server) {
          ctx.ui.notify(`Tailscale Serve: ${tailscale.url || "enabled for Pi Phone"}`, "info");
        } else {
          ctx.ui.notify(`Tailscale Serve is still pointing at Pi Phone${tailscale.url ? `: ${tailscale.url}` : "."}`, "warning");
        }
      } else if (server) {
        if (tailscale.error) {
          ctx.ui.notify(`Tailscale Serve check failed: ${tailscale.error}`, "warning");
        } else {
          ctx.ui.notify("Tailscale Serve is not currently pointing to Pi Phone.", "warning");
        }
      }
    },
  });

  pi.registerCommand("phone-token", {
    description: "Show the current phone UI token",
    handler: async (_args, ctx) => {
      captureCtx(ctx);
      if (config.token) {
        ctx.ui.notify(`Pi Phone token: ${config.token}`, "warning");
      } else {
        ctx.ui.notify("Pi Phone token is disabled for this server.", "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    captureCtx(ctx);
    if (!server) {
      config.cwd = activeCwd();
    }
    updateStatusUi(ctx);
    broadcastStatus();
  });

  pi.on("session_switch", async (_event, ctx) => {
    captureCtx(ctx);
    if (!server) {
      config.cwd = activeCwd();
    }
    updateStatusUi(ctx);
    broadcastStatus();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    captureCtx(ctx);
    await stopServer();
    await disableMatchingTailscaleServe();
    updateStatusUi(ctx);
  });
}
