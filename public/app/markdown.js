import { escapeHtml } from "./formatters.js";

function findInlineCodeMarker(text, startIndex = 0) {
  for (let index = Math.max(0, startIndex); index < text.length; index += 1) {
    if (text[index] !== "`") continue;
    if (text[index - 1] === "`" || text[index + 1] === "`") continue;
    return index;
  }
  return -1;
}

function renderStrongText(text = "") {
  let html = "";
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf("**", cursor);
    if (open === -1) {
      html += escapeHtml(text.slice(cursor));
      break;
    }

    const close = text.indexOf("**", open + 2);
    if (close === -1) {
      html += escapeHtml(text.slice(cursor));
      break;
    }

    html += escapeHtml(text.slice(cursor, open));
    html += `<strong>${escapeHtml(text.slice(open + 2, close))}</strong>`;
    cursor = close + 2;
  }

  return html;
}

function renderInlineMarkdown(text = "") {
  let html = "";
  let cursor = 0;

  while (cursor < text.length) {
    const open = findInlineCodeMarker(text, cursor);
    if (open === -1) {
      html += renderStrongText(text.slice(cursor));
      break;
    }

    const close = findInlineCodeMarker(text, open + 1);
    if (close === -1) {
      html += renderStrongText(text.slice(cursor));
      break;
    }

    html += renderStrongText(text.slice(cursor, open));
    html += `<code>${escapeHtml(text.slice(open + 1, close))}</code>`;
    cursor = close + 1;
  }

  return html;
}

function renderTextBlocks(text = "") {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => (block.trim() ? `<p>${renderInlineMarkdown(block)}</p>` : ""))
    .filter(Boolean);

  if (blocks.length) return blocks.join("");
  return text.trim() ? `<p>${renderInlineMarkdown(text)}</p>` : "";
}

function renderCodeBlock(code = "") {
  return `
    <pre class="message-code-block"><code>${escapeHtml(code)}</code></pre>
  `;
}

export function renderMarkdownLite(text = "") {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const fencePattern = /```([^`\n]*)\n([\s\S]*?)```/g;
  const parts = [];
  let cursor = 0;
  let match;

  while ((match = fencePattern.exec(normalized))) {
    if (match.index > cursor) {
      parts.push({ type: "text", value: normalized.slice(cursor, match.index) });
    }

    parts.push({ type: "code", value: match[2].replace(/\n$/, "") });
    cursor = match.index + match[0].length;
  }

  if (cursor < normalized.length) {
    parts.push({ type: "text", value: normalized.slice(cursor) });
  }

  const html = parts.map((part) => (
    part.type === "code"
      ? renderCodeBlock(part.value)
      : renderTextBlocks(part.value)
  )).join("");

  return html || '<p><span class="label">(no text)</span></p>';
}
