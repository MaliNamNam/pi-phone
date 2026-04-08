const ANSI_TO_CSS = {
  30: "color:#000", 31: "color:#cc6666", 32: "color:#b5bd68", 33: "color:#f0c674",
  34: "color:#81a2be", 35: "color:#b294bb", 36: "color:#8abeb7", 37: "color:#c5c8c6",
  90: "color:#666", 91: "color:#f66", 92: "color:#9c6", 93: "color:#fe7",
  94: "color:#69f", 95: "color:#d8f", 96: "color:#5ee", 97: "color:#fff",
  1: "font-weight:bold", 3: "font-style:italic", 4: "text-decoration:underline",
};

export function ansiToHtml(text = "") {
  let result = "";
  let open = false;
  let i = 0;
  const s = String(text);

  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i + 2);
      if (end === -1) { i++; continue; }
      const codes = s.slice(i + 2, end).split(";").map(Number);
      i = end + 1;

      if (codes.includes(0) || codes.length === 0) {
        if (open) { result += "</span>"; open = false; }
        continue;
      }

      if (open) result += "</span>";
      const styles = codes.map((c) => ANSI_TO_CSS[c]).filter(Boolean).join(";");
      if (styles) { result += `<span style="${styles}">`; open = true; }
    } else {
      const c = s[i++];
      result += c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c;
    }
  }

  if (open) result += "</span>";
  return result;
}

export function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(text = "") {
  return escapeHtml(text).replaceAll("`", "&#096;");
}

export function formatCwdDisplay(path = "") {
  const value = String(path || "").trim();
  if (!value) return "";

  const homeMatch = value.match(/^\/(?:home|Users)\/[^/]+(\/.*)?$/);
  if (homeMatch) {
    const suffix = homeMatch[1] || "";
    const parts = suffix.split("/").filter(Boolean);
    if (!parts.length) return "~";
    if (parts.length === 1) return `~/${parts[0]}`;
    return `~/…/${parts[parts.length - 1]}`;
  }

  if (value === "/") return value;

  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 2) return value;
  return `/…/${parts[parts.length - 1]}`;
}

export function formatTimestamp(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTokenCount(count) {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function normalizeNewlines(text = "") {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

export function stripTerminalControlSequences(text = "") {
  return String(text ?? "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u009D[^\u009C]*\u009C/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

export function countTextLines(text = "") {
  const normalized = normalizeNewlines(text);
  if (!normalized.length) return 0;
  return normalized.split("\n").length;
}

export function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

export function contentToText(content) {
  if (typeof content === "string") return stripTerminalControlSequences(content);
  if (!Array.isArray(content)) return "";
  return stripTerminalControlSequences(content
    .map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "image") return "[image]";
      if (part.type === "thinking") return "";
      if (part.type === "toolCall") return "";
      return "";
    })
    .join(" ")
    .trim());
}

export function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part.type === "image").length;
}

export function assistantParts(content) {
  const parts = { text: "", thinking: "", toolCalls: [] };
  if (!Array.isArray(content)) return parts;

  for (const block of content) {
    if (block.type === "text") parts.text += stripTerminalControlSequences(block.text || "");
    if (block.type === "thinking") parts.thinking += stripTerminalControlSequences(block.thinking || "");
    if (block.type === "toolCall") {
      parts.toolCalls.push({ id: block.id || "", name: block.name || "tool", arguments: block.arguments || {} });
    }
  }

  return parts;
}

export function toDetailString(details) {
  if (details == null) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}
