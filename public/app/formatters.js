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
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "image") return "[image]";
      if (part.type === "thinking") return "";
      if (part.type === "toolCall") return "";
      return "";
    })
    .join(" ")
    .trim();
}

export function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part.type === "image").length;
}

export function assistantParts(content) {
  const parts = { text: "", thinking: "", toolCalls: [] };
  if (!Array.isArray(content)) return parts;

  for (const block of content) {
    if (block.type === "text") parts.text += block.text || "";
    if (block.type === "thinking") parts.thinking += block.thinking || "";
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
