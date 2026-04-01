import { resolve } from "node:path";
import type { ParsedPhoneArgs, PhoneConfig } from "./types";

export function parsePhoneStartArgs(args: string | undefined, current: PhoneConfig): ParsedPhoneArgs {
  const next = { ...current };
  let tokenSpecified = false;
  let idleSpecified = false;
  let local = false;
  let cfTokenSpecified = false;

  if (!args?.trim()) {
    return { config: next, tokenSpecified, idleSpecified, local, cfTokenSpecified };
  }

  const tokens = args.trim().split(/\s+/);
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === "--port" && tokens[index + 1]) {
      const port = Number(tokens[index + 1]);
      if (Number.isFinite(port) && port > 0) next.port = port;
      index += 2;
      continue;
    }

    if (token.startsWith("--port=")) {
      const port = Number(token.slice(7));
      if (Number.isFinite(port) && port > 0) next.port = port;
      index += 1;
      continue;
    }

    if (token === "--host" && tokens[index + 1]) {
      next.host = tokens[index + 1];
      index += 2;
      continue;
    }

    if (token.startsWith("--host=")) {
      next.host = token.slice(7);
      index += 1;
      continue;
    }

    if (token === "--token" && tokens[index + 1] !== undefined) {
      tokenSpecified = true;
      next.token = tokens[index + 1] === "-" ? "" : tokens[index + 1];
      index += 2;
      continue;
    }

    if (token.startsWith("--token=")) {
      tokenSpecified = true;
      const value = token.slice(8);
      next.token = value === "-" ? "" : value;
      index += 1;
      continue;
    }

    if (token === "--cwd" && tokens[index + 1]) {
      next.cwd = resolve(tokens[index + 1]);
      index += 2;
      continue;
    }

    if (token.startsWith("--cwd=")) {
      next.cwd = resolve(token.slice(6));
      index += 1;
      continue;
    }

    if (token === "--idle-mins" && tokens[index + 1] !== undefined) {
      idleSpecified = true;
      const minutes = Number(tokens[index + 1]);
      if (Number.isFinite(minutes) && minutes >= 0) next.idleTimeoutMs = Math.round(minutes * 60_000);
      index += 2;
      continue;
    }

    if (token.startsWith("--idle-mins=")) {
      idleSpecified = true;
      const minutes = Number(token.slice(12));
      if (Number.isFinite(minutes) && minutes >= 0) next.idleTimeoutMs = Math.round(minutes * 60_000);
      index += 1;
      continue;
    }

    if (token === "--idle-secs" && tokens[index + 1] !== undefined) {
      idleSpecified = true;
      const seconds = Number(tokens[index + 1]);
      if (Number.isFinite(seconds) && seconds >= 0) next.idleTimeoutMs = Math.round(seconds * 1_000);
      index += 2;
      continue;
    }

    if (token.startsWith("--idle-secs=")) {
      idleSpecified = true;
      const seconds = Number(token.slice(12));
      if (Number.isFinite(seconds) && seconds >= 0) next.idleTimeoutMs = Math.round(seconds * 1_000);
      index += 1;
      continue;
    }

    if (token === "--cf-token" && tokens[index + 1] !== undefined) {
      cfTokenSpecified = true;
      next.cfToken = tokens[index + 1];
      index += 2;
      continue;
    }

    if (token.startsWith("--cf-token=")) {
      cfTokenSpecified = true;
      next.cfToken = token.slice(11);
      index += 1;
      continue;
    }

    if (token === "--cf-hostname" && tokens[index + 1]) {
      next.cfHostname = tokens[index + 1];
      index += 2;
      continue;
    }

    if (token.startsWith("--cf-hostname=")) {
      next.cfHostname = token.slice(14);
      index += 1;
      continue;
    }

    if (token === "--local" || token === "local") {
      local = true;
      index += 1;
      continue;
    }

    if (/^\d+$/.test(token)) {
      next.port = Number(token);
      index += 1;
      continue;
    }

    if (!token.startsWith("--") && next.token === current.token) {
      tokenSpecified = true;
      next.token = token === "-" ? "" : token;
      index += 1;
      continue;
    }

    index += 1;
  }

  return { config: next, tokenSpecified, idleSpecified, local, cfTokenSpecified };
}
