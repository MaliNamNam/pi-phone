import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PhonePathSuggestion, PhonePathSuggestionMode } from "./types";

const agentDirFromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
const agentDir = agentDirFromEnv
  ? agentDirFromEnv
  : join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".pi", "agent");

const PATH_SUGGESTION_LIMIT = 20;
const PATH_SUGGESTION_MAX_RESULTS = 100;

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

export function resolvePhoneCdTargetPath(rawArgs: string | undefined, currentCwd: string, previousCwd?: string | null): string {
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
  const resolvedInput = expanded ? resolve(currentCwd, expanded) : currentCwd;

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

    const directories = readdirSync(baseDir, { withFileTypes: true })
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

    for (const entry of directories.slice(0, PATH_SUGGESTION_LIMIT)) {
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
        kind: "path" as const,
      };
    });
}

export function listPhonePathSuggestions(
  mode: PhonePathSuggestionMode,
  query: string,
  currentCwd: string,
  previousCwd?: string | null,
): PhonePathSuggestion[] {
  return mode === "cd"
    ? createCdPathSuggestions(query, currentCwd, previousCwd)
    : createMentionPathSuggestions(query, currentCwd);
}
