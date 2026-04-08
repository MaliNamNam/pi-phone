import { TOOL_LANGUAGE_LABELS } from "./constants.js";
import { state } from "./state.js";
import {
  asRecord,
  countTextLines,
  escapeAttribute,
  escapeHtml,
  formatBytes,
  normalizeNewlines,
} from "./formatters.js";
import { renderMarkdownLite } from "./markdown.js";

function normalizedToolName(name = "") {
  return String(name || "").trim().split(" · ")[0].toLowerCase();
}

function detectLanguageLabel(filePath = "") {
  const normalized = String(filePath || "").trim().toLowerCase();
  const match = normalized.match(/\.([a-z0-9]+)$/);
  if (!match) return "";
  return TOOL_LANGUAGE_LABELS[match[1]] || match[1].toUpperCase();
}

function getToolPath(item) {
  return typeof item?.args?.path === "string" ? item.args.path : "";
}

function parseNumberedDiffLines(diffText = "") {
  const normalized = normalizeNewlines(diffText);
  if (!normalized.trim()) return [];

  return normalized
    .split("\n")
    .map((line) => {
      const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
      if (!match) {
        return { kind: "meta", prefix: "", lineNumber: "", text: line };
      }

      const prefix = match[1];
      return {
        kind: prefix === "+" ? "added" : prefix === "-" ? "removed" : "context",
        prefix,
        lineNumber: match[2].trim(),
        text: match[3] || "",
      };
    })
    .filter((line) => line.kind !== "meta" || line.text.trim());
}

function buildEditPreviewLines(oldText = "", newText = "") {
  const oldLines = normalizeNewlines(oldText).split("\n");
  const newLines = normalizeNewlines(newText).split("\n");

  if (oldLines.length === 1 && oldLines[0] === "" && newLines.length === 1 && newLines[0] === "") {
    return [];
  }

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines = [];

  for (let index = 0; index < prefix; index += 1) {
    lines.push({ kind: "context", prefix: " ", lineNumber: String(index + 1), text: oldLines[index] || "" });
  }

  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    lines.push({ kind: "removed", prefix: "-", lineNumber: String(index + 1), text: oldLines[index] || "" });
  }

  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    lines.push({ kind: "added", prefix: "+", lineNumber: String(index + 1), text: newLines[index] || "" });
  }

  for (let index = suffix; index > 0; index -= 1) {
    const oldIndex = oldLines.length - index;
    const newIndex = newLines.length - index;
    lines.push({ kind: "context", prefix: " ", lineNumber: String(newIndex + 1), text: newLines[newIndex] || oldLines[oldIndex] || "" });
  }

  return lines;
}

function computeDiffStats(lines = []) {
  return lines.reduce((stats, line) => {
    if (line.kind === "added") stats.added += 1;
    if (line.kind === "removed") stats.removed += 1;
    return stats;
  }, { added: 0, removed: 0 });
}

function renderToolBadge(text, variant = "neutral") {
  if (!text) return "";
  return `<span class="tool-panel-badge ${variant}">${escapeHtml(text)}</span>`;
}

function renderDiffLine(line) {
  const prefix = line.prefix || (line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ");
  const gutter = `${prefix}${line.lineNumber || ""}`.trimEnd() || prefix || " ";
  const text = line.text === "" ? " " : line.text;

  return `
    <div class="tool-diff-line ${line.kind || "context"}">
      <span class="tool-diff-gutter mono">${escapeHtml(gutter)}</span>
      <span class="tool-diff-code mono">${escapeHtml(text)}</span>
    </div>
  `;
}

function renderDiffPreview(lines, { limit = 80 } = {}) {
  if (!lines.length) {
    return '<div class="tool-panel-note">No diff preview available.</div>';
  }

  const visible = lines.slice(0, limit);
  const hiddenLines = lines.slice(limit);

  return `
    <div class="tool-diff-block">
      ${visible.map(renderDiffLine).join("")}
      ${hiddenLines.length ? `<div class="tool-preview-overflow">${hiddenLines.map(renderDiffLine).join("")}</div>` : ""}
    </div>
    ${hiddenLines.length ? `<button class="tool-preview-truncated" data-count="${hiddenLines.length}" data-kind="diff" data-label="… ${hiddenLines.length} more diff lines">… ${hiddenLines.length} more diff lines</button>` : ""}
  `;
}

function splitToolNotice(text = "") {
  const lines = normalizeNewlines(text).split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  const lastLine = lines[lines.length - 1] || "";
  if (lastLine.startsWith("[") && /(Use offset=|limit reached|truncated|saved to temp file|full output)/i.test(lastLine)) {
    lines.pop();
    return { body: lines.join("\n"), notice: lastLine };
  }

  return { body: lines.join("\n"), notice: "" };
}

function renderCodePreview(text = "", { limit = 24, startLine = 1, emptyLabel = "Empty file." } = {}) {
  const { body, notice } = splitToolNotice(text);
  const allLines = normalizeNewlines(body).split("\n");
  if (allLines.length > 1 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  if (!allLines.length) {
    return `${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ""}<div class="tool-panel-note">${escapeHtml(emptyLabel)}</div>`;
  }

  const visible = allLines.slice(0, limit);
  const hiddenLines = allLines.slice(limit);

  return `
    <div class="tool-code-block">
      ${visible.map((line, index) => `
        <div class="tool-code-line">
          <span class="tool-code-gutter mono">${escapeHtml(String(startLine + index))}</span>
          <span class="tool-code-content mono">${escapeHtml(line === "" ? " " : line)}</span>
        </div>
      `).join("")}
      ${hiddenLines.length ? `<div class="tool-preview-overflow">${hiddenLines.map((line, index) => `
        <div class="tool-code-line">
          <span class="tool-code-gutter mono">${escapeHtml(String(startLine + limit + index))}</span>
          <span class="tool-code-content mono">${escapeHtml(line === "" ? " " : line)}</span>
        </div>
      `).join("")}</div>` : ""}
    </div>
    ${hiddenLines.length ? `<button class="tool-preview-truncated" data-count="${hiddenLines.length}" data-kind="line" data-label="… ${hiddenLines.length} more line${hiddenLines.length === 1 ? "" : "s"}">… ${hiddenLines.length} more line${hiddenLines.length === 1 ? "" : "s"}</button>` : ""}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ""}
  `;
}

function renderMarkdownPreview(text = "", { limit = 80 } = {}) {
  const { body, notice } = splitToolNotice(text);
  const lines = normalizeNewlines(body).split("\n");
  const visible = lines.slice(0, limit).join("\n").trim();
  const hiddenLines = lines.slice(limit);

  return `
    <div class="tool-markdown-preview">
      ${renderMarkdownLite(visible || "(empty markdown file)")}
      ${hiddenLines.length ? `<div class="tool-preview-overflow">${renderMarkdownLite(hiddenLines.join("\n").trim())}</div>` : ""}
    </div>
    ${hiddenLines.length ? `<button class="tool-preview-truncated" data-count="${hiddenLines.length}" data-kind="markdown" data-label="… ${hiddenLines.length} more markdown line${hiddenLines.length === 1 ? "" : "s"}">… ${hiddenLines.length} more markdown line${hiddenLines.length === 1 ? "" : "s"}</button>` : ""}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ""}
  `;
}

function renderTerminalPreview(text = "", { limit = 80 } = {}) {
  const { body, notice } = splitToolNotice(text);
  const lines = normalizeNewlines(body).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const visible = lines.slice(0, limit);
  const hiddenLines = lines.slice(limit);
  const terminalText = visible.length ? visible.join("\n") : "(no output)";

  return `
    <div class="tool-terminal-block">
      <pre class="mono">${escapeHtml(terminalText)}</pre>
      ${hiddenLines.length ? `<pre class="mono tool-preview-overflow">${escapeHtml(hiddenLines.join("\n"))}</pre>` : ""}
    </div>
    ${hiddenLines.length ? `<button class="tool-preview-truncated" data-count="${hiddenLines.length}" data-kind="output" data-label="… ${hiddenLines.length} more output line${hiddenLines.length === 1 ? "" : "s"}">… ${hiddenLines.length} more output line${hiddenLines.length === 1 ? "" : "s"}</button>` : ""}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ""}
  `;
}

function summarizeRange(startLine, lineCount) {
  if (!lineCount) return "";
  const endLine = startLine + lineCount - 1;
  return startLine === endLine ? `L${startLine}` : `${startLine}-${endLine}`;
}

function isMarkdownPath(filePath = "") {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function firstImagePart(content) {
  if (!Array.isArray(content)) return null;
  return content.find((part) => part?.type === "image" && part?.data && part?.mimeType) || null;
}

function renderImagePreview(content, alt = "Image preview") {
  const image = firstImagePart(content);
  if (!image) return "";
  return `
    <div class="tool-image-wrap">
      <img class="tool-image-preview" src="data:${escapeAttribute(image.mimeType)};base64,${escapeAttribute(image.data)}" alt="${escapeAttribute(alt)}" loading="lazy" />
    </div>
  `;
}

function parseGrepMatches(text = "") {
  const { body, notice } = splitToolNotice(text);
  const lines = normalizeNewlines(body).split("\n").filter((line) => line.trim());
  const entries = [];

  for (const line of lines) {
    let match = line.match(/^(.+?):(\d+):\s?(.*)$/);
    if (match) {
      entries.push({ path: match[1], lineNumber: Number(match[2]), text: match[3] || "", kind: "match" });
      continue;
    }

    match = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
    if (match) {
      entries.push({ path: match[1], lineNumber: Number(match[2]), text: match[3] || "", kind: "context" });
      continue;
    }
  }

  const deduped = [];
  let previousKey = "";
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.path}:${entry.lineNumber}:${entry.text}`;
    if (key === previousKey) continue;
    previousKey = key;
    deduped.push(entry);
  }

  return { entries: deduped, notice };
}

function renderGrepPreview(text = "", { limitFiles = 8, limitLinesPerFile = 10 } = {}) {
  const { entries, notice } = parseGrepMatches(text);
  if (!entries.length) {
    return {
      html: text ? `<pre class="tool-terminal-block mono">${escapeHtml(text)}</pre>` : '<div class="tool-panel-note">No matches.</div>',
      matchCount: 0,
      fileCount: 0,
      notice,
    };
  }

  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.path)) groups.set(entry.path, []);
    groups.get(entry.path).push(entry);
  }

  const fileEntries = [...groups.entries()];
  const hiddenFileGroups = fileEntries.slice(limitFiles);

  const html = `
    <div class="tool-match-groups">
      ${fileEntries.slice(0, limitFiles).map(([path, items]) => {
        const visibleItems = items.slice(0, limitLinesPerFile);
        const hiddenLines = items.slice(limitLinesPerFile);
        return `
          <section class="tool-match-group">
            <div class="tool-match-group-header mono">${escapeHtml(path)}</div>
            <div class="tool-match-group-lines">
              ${visibleItems.map((entry) => `
                <div class="tool-match-line ${entry.kind}">
                  <span class="tool-match-gutter mono">${escapeHtml(String(entry.lineNumber))}</span>
                  <span class="tool-match-text mono">${escapeHtml(entry.text === "" ? " " : entry.text)}</span>
                </div>
              `).join("")}
              ${hiddenLines.length ? `<div class="tool-preview-overflow">${hiddenLines.map((entry) => `
                <div class="tool-match-line ${entry.kind}">
                  <span class="tool-match-gutter mono">${escapeHtml(String(entry.lineNumber))}</span>
                  <span class="tool-match-text mono">${escapeHtml(entry.text === "" ? " " : entry.text)}</span>
                </div>
              `).join("")}</div>` : ""}
            </div>
            ${hiddenLines.length ? `<button class="tool-preview-truncated" data-count="${hiddenLines.length}" data-kind="grep-line" data-label="… ${hiddenLines.length} more line${hiddenLines.length === 1 ? "" : "s"} in ${escapeHtml(path)}">… ${hiddenLines.length} more line${hiddenLines.length === 1 ? "" : "s"} in ${escapeHtml(path)}</button>` : ""}
          </section>
        `;
      }).join("")}
      ${hiddenFileGroups.length ? `
        <div class="tool-preview-overflow" data-overflow-kind="file">
          ${hiddenFileGroups.map(([path, items]) => `
            <section class="tool-match-group">
              <div class="tool-match-group-header mono">${escapeHtml(path)}</div>
              <div class="tool-match-group-lines">
                ${items.map((entry) => `
                  <div class="tool-match-line ${entry.kind}">
                    <span class="tool-match-gutter mono">${escapeHtml(String(entry.lineNumber))}</span>
                    <span class="tool-match-text mono">${escapeHtml(entry.text === "" ? " " : entry.text)}</span>
                  </div>
                `).join("")}
              </div>
            </section>
          `).join("")}
        </div>
        <button class="tool-preview-truncated" data-count="${hiddenFileGroups.length}" data-kind="grep-file" data-label="… ${hiddenFileGroups.length} more matching file${hiddenFileGroups.length === 1 ? "" : "s"}">… ${hiddenFileGroups.length} more matching file${hiddenFileGroups.length === 1 ? "" : "s"}</button>
      ` : ""}
    </div>
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ""}
  `;

  return { html, matchCount: entries.filter((entry) => entry.kind === "match").length, fileCount: fileEntries.length, notice };
}

function parseListEntries(text = "") {
  const { body, notice } = splitToolNotice(text);
  return {
    entries: normalizeNewlines(body).split("\n").filter((line) => line.trim()),
    notice,
  };
}

function renderListPreview(entries, { limit = 40 } = {}) {
  if (!entries.length) {
    return '<div class="tool-panel-note">No results.</div>';
  }

  const visible = entries.slice(0, limit);
  const hiddenEntries = entries.slice(limit);

  return `
    <div class="tool-entry-list">
      ${visible.map((entry) => `
        <div class="tool-entry-row ${entry.endsWith("/") ? "directory" : "file"}">
          <span class="tool-entry-icon">${entry.endsWith("/") ? "📁" : "📄"}</span>
          <span class="tool-entry-text mono">${escapeHtml(entry)}</span>
        </div>
      `).join("")}
      ${hiddenEntries.length ? `<div class="tool-preview-overflow">${hiddenEntries.map((entry) => `
        <div class="tool-entry-row ${entry.endsWith("/") ? "directory" : "file"}">
          <span class="tool-entry-icon">${entry.endsWith("/") ? "📁" : "📄"}</span>
          <span class="tool-entry-text mono">${escapeHtml(entry)}</span>
        </div>
      `).join("")}</div>` : ""}
    </div>
    ${hiddenEntries.length ? `<button class="tool-preview-truncated" data-count="${hiddenEntries.length}" data-kind="entry" data-label="… ${hiddenEntries.length} more result${hiddenEntries.length === 1 ? "" : "s"}">… ${hiddenEntries.length} more result${hiddenEntries.length === 1 ? "" : "s"}</button>` : ""}
  `;
}

function isToolPanelOpen(itemId, defaultOpen = false) {
  if (state.toolPanelOpen.has(itemId)) {
    return Boolean(state.toolPanelOpen.get(itemId));
  }
  return defaultOpen;
}

function renderToolPanel(item, {
  variant,
  eyebrow,
  path,
  badges = [],
  note = "",
  content = "",
  defaultOpen = false,
}) {
  const open = isToolPanelOpen(item.id, defaultOpen);

  return `
    <details class="tool-panel tool-panel-${escapeHtml(variant)}" data-tool-panel="${escapeHtml(item.id)}" ${open ? "open" : ""}>
      <summary class="tool-panel-summary">
        <div class="tool-panel-summary-copy">
          <div class="tool-panel-eyebrow">${escapeHtml(eyebrow)}</div>
          <div class="tool-panel-path mono">${escapeHtml(path)}</div>
        </div>
        <div class="tool-panel-badges">${badges.join("")}</div>
      </summary>
      <div class="tool-panel-body">
        ${note ? `<div class="tool-panel-note">${escapeHtml(note)}</div>` : ""}
        ${content}
      </div>
    </details>
  `;
}

function renderEditToolContent(item) {
  const details = asRecord(item.details);
  const path = getToolPath(item);
  if (!path) return "";

  const diffLines = typeof details?.diff === "string"
    ? parseNumberedDiffLines(details.diff)
    : buildEditPreviewLines(item.args?.oldText || "", item.args?.newText || "");

  if (!diffLines.length) return "";

  const stats = computeDiffStats(diffLines);
  const badges = [];
  if (stats.added) badges.push(renderToolBadge(`+${stats.added}`, "added"));
  if (stats.removed) badges.push(renderToolBadge(`-${stats.removed}`, "removed"));
  if (!stats.added && !stats.removed) badges.push(renderToolBadge(item.live ? "editing" : "updated"));
  if (typeof details?.firstChangedLine === "number") badges.push(renderToolBadge(`L${details.firstChangedLine}`, "neutral"));

  return renderToolPanel(item, {
    variant: "edit",
    eyebrow: item.live ? "Editing file" : "Edit diff",
    path,
    badges,
    note: typeof details?.diff === "string" ? "" : "Preview from the requested replacement block.",
    content: renderDiffPreview(diffLines, { limit: item.live ? 120 : 80 }),
    defaultOpen: true,
  });
}

function renderWriteToolContent(item) {
  const path = getToolPath(item);
  const content = typeof item.args?.content === "string" ? item.args.content : "";
  if (!path || !content) return "";

  const lineCount = countTextLines(content);
  const byteCount = typeof TextEncoder === "function" ? new TextEncoder().encode(content).length : content.length;
  const languageLabel = detectLanguageLabel(path);

  const badges = [];
  if (lineCount) badges.push(renderToolBadge(`${lineCount} line${lineCount === 1 ? "" : "s"}`, "neutral"));
  if (byteCount) badges.push(renderToolBadge(formatBytes(byteCount), "neutral"));
  if (languageLabel) badges.push(renderToolBadge(languageLabel, "accent"));

  return renderToolPanel(item, {
    variant: "write",
    eyebrow: item.live ? "Writing file" : "File preview",
    path,
    badges,
    note: "Preview from the content sent to write.",
    content: renderCodePreview(content, { limit: item.live ? 30 : 24 }),
    defaultOpen: item.live || lineCount <= 14,
  });
}

function renderReadToolContent(item) {
  const path = getToolPath(item);
  const text = item.text || "";
  const rawContent = item.rawContent;
  if (!path) return "";

  const imageHtml = renderImagePreview(rawContent, path);
  const languageLabel = detectLanguageLabel(path);
  const startLine = Number.isFinite(Number(item.args?.offset)) && Number(item.args?.offset) > 0 ? Number(item.args.offset) : 1;
  const { body } = splitToolNotice(text);
  const visibleLineCount = countTextLines(body);
  const rangeLabel = summarizeRange(startLine, visibleLineCount);
  const badges = [];
  if (rangeLabel) badges.push(renderToolBadge(rangeLabel, "neutral"));
  if (languageLabel) badges.push(renderToolBadge(languageLabel, "accent"));
  if (imageHtml) badges.push(renderToolBadge("image", "accent"));

  const content = imageHtml
    || (isMarkdownPath(path)
      ? renderMarkdownPreview(text, { limit: 90 })
      : renderCodePreview(text, {
          limit: item.live ? 60 : 32,
          startLine,
          emptyLabel: "No readable text returned.",
        }));

  return renderToolPanel(item, {
    variant: "read",
    eyebrow: item.live ? "Reading file" : "Read result",
    path,
    badges,
    content,
    defaultOpen: Boolean(imageHtml) || isMarkdownPath(path) || visibleLineCount <= 14,
  });
}

function renderBashToolContent(item) {
  const details = asRecord(item.details);
  const command = String(item.command || item.args?.command || item.title?.replace(/^bash\s*·\s*/, "") || item.title || "bash").trim();
  if (!command) return "";

  const badges = [];
  if (item.status === "running" || item.live) badges.push(renderToolBadge("running", "accent"));
  else if (item.status === "error") badges.push(renderToolBadge("failed", "removed"));
  else if (item.status === "cancelled") badges.push(renderToolBadge("cancelled", "neutral"));
  // Skip "done" badge - header already shows status pill
  if (typeof item.args?.timeout === "number") badges.push(renderToolBadge(`${item.args.timeout}s timeout`, "neutral"));
  if (details?.fullOutputPath) badges.push(renderToolBadge("full log saved", "neutral"));

  const note = typeof details?.fullOutputPath === "string" ? `Full output: ${details.fullOutputPath}` : "";

  return renderToolPanel(item, {
    variant: "bash",
    eyebrow: item.live ? "Shell command running" : "Shell command",
    path: command,
    badges,
    note,
    content: renderTerminalPreview(item.text || "", { limit: item.live ? 140 : 100 }),
    defaultOpen: true,
  });
}

function renderGrepToolContent(item) {
  const pattern = typeof item.args?.pattern === "string" ? item.args.pattern : "";
  const searchPath = typeof item.args?.path === "string" && item.args.path.trim() ? item.args.path : ".";
  const preview = renderGrepPreview(item.text || "", { limitFiles: 10, limitLinesPerFile: 8 });
  const badges = [];
  if (pattern) badges.push(renderToolBadge(pattern.length > 28 ? `${pattern.slice(0, 27)}…` : pattern, "accent"));
  if (preview.matchCount) badges.push(renderToolBadge(`${preview.matchCount} match${preview.matchCount === 1 ? "" : "es"}`, "neutral"));
  if (preview.fileCount) badges.push(renderToolBadge(`${preview.fileCount} file${preview.fileCount === 1 ? "" : "s"}`, "neutral"));

  return renderToolPanel(item, {
    variant: "grep",
    eyebrow: item.live ? "Searching files" : "Search results",
    path: searchPath,
    badges,
    content: preview.html,
    defaultOpen: preview.matchCount > 0,
  });
}

function renderFindToolContent(item) {
  const { entries, notice } = parseListEntries(item.text || "");
  const searchPath = typeof item.args?.path === "string" && item.args.path.trim() ? item.args.path : ".";
  const badges = [];
  if (typeof item.args?.pattern === "string") badges.push(renderToolBadge(item.args.pattern, "accent"));
  if (entries.length) badges.push(renderToolBadge(`${entries.length} result${entries.length === 1 ? "" : "s"}`, "neutral"));

  return renderToolPanel(item, {
    variant: "find",
    eyebrow: item.live ? "Finding paths" : "Find results",
    path: searchPath,
    badges,
    note: notice,
    content: renderListPreview(entries, { limit: 60 }),
    defaultOpen: entries.length <= 16,
  });
}

function renderLsToolContent(item) {
  const { entries, notice } = parseListEntries(item.text || "");
  const listPath = typeof item.args?.path === "string" && item.args.path.trim() ? item.args.path : ".";
  const badges = [];
  if (entries.length) badges.push(renderToolBadge(`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`, "neutral"));
  const dirCount = entries.filter((entry) => entry.endsWith("/")).length;
  if (dirCount) badges.push(renderToolBadge(`${dirCount} dir${dirCount === 1 ? "" : "s"}`, "accent"));

  return renderToolPanel(item, {
    variant: "ls",
    eyebrow: item.live ? "Listing directory" : "Directory listing",
    path: listPath,
    badges,
    note: notice,
    content: renderListPreview(entries, { limit: 80 }),
    defaultOpen: entries.length <= 20,
  });
}

export function renderRichToolContent(item) {
  const toolName = normalizedToolName(item.toolName || item.title || "");

  if (toolName === "edit") return renderEditToolContent(item);
  if (toolName === "write") return renderWriteToolContent(item);
  if (toolName === "read") return renderReadToolContent(item);
  if (toolName === "bash") return renderBashToolContent(item);
  if (toolName === "grep") return renderGrepToolContent(item);
  if (toolName === "find") return renderFindToolContent(item);
  if (toolName === "ls") return renderLsToolContent(item);
  return "";
}
