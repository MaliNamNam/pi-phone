const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const LOCAL_COMMAND_NAMES = new Set(['new', 'compact', 'reload', 'refresh', 'stats', 'cost', 'model', 'thinking', 'commands', 'sessions', 'tree', 'cd']);

const LOCAL_COMMANDS = [
  { name: 'new', description: 'Start a new session', run: () => sendRpc({ type: 'new_session' }) },
  { name: 'compact', description: 'Compact the current session', run: () => sendRpc({ type: 'compact' }) },
  { name: 'reload', description: 'Reload extensions, skills, prompts, and themes', run: () => requestReload() },
  { name: 'stats', description: 'Show session stats', run: () => openSheet('actions') },
  { name: 'cost', description: 'Show session cost stats', run: () => openSheet('actions') },
  { name: 'model', description: 'Open model picker', run: () => openSheet('models') },
  { name: 'thinking', description: 'Open thinking level picker', run: () => openSheet('thinking') },
  { name: 'commands', description: 'Browse commands, skills, and prompts', run: () => openSheet('commands') },
  { name: 'sessions', description: 'Browse saved sessions', run: () => openSheet('sessions') },
  { name: 'tree', description: 'Browse the current session tree', run: () => openSheet('tree') },
  { name: 'cd', description: 'Change Pi working directory', insertOnly: true, run: () => insertCdCommand() },
  { name: 'refresh', description: 'Refresh snapshot', run: () => refreshAll() },
];
const COMMAND_CATEGORY_ORDER = ['local', 'extension', 'prompt', 'skill'];
const AUTOCOMPLETE_DELIMITERS = new Set([' ', '\t', '\n', '"', "'", '=']);

const TOKEN_STORAGE_KEY = 'pi-phone-token';

const state = {
  health: null,
  status: null,
  snapshotState: null,
  snapshotWorkerId: null,
  messages: [],
  commands: [],
  models: [],
  sessions: [],
  activeSessions: [],
  activeSessionId: null,
  tree: null,
  stats: null,
  widgets: new Map(),
  footerStatus: '',
  quota: null,
  quotaRequestId: 0,
  liveAssistant: null,
  liveTools: new Map(),
  pendingUiRequest: null,
  socket: null,
  reconnectTimer: null,
  manuallyClosed: false,
  token: localStorage.getItem(TOKEN_STORAGE_KEY) || '',
  sheetMode: 'actions',
  commandSheetCategory: 'local',
  autocompleteContext: null,
  autocompleteItems: [],
  autocompleteRemoteRequestId: 0,
  autocompleteRemoteTimer: null,
  attachments: [],
  lastSheetPointerAction: '',
  lastSheetPointerActionAt: 0,
  toolPanelOpen: new Map(),
};

const el = {
  abortButton: document.querySelector('#abort-button'),
  actionsButton: document.querySelector('#actions-button'),
  attachImageButton: document.querySelector('#attach-image-button'),
  cdCommandButton: document.querySelector('#cd-command-button'),
  attachmentStrip: document.querySelector('#attachment-strip'),
  banner: document.querySelector('#banner'),
  commandStrip: document.querySelector('#command-strip'),
  composerActions: document.querySelector('.composer-actions'),
  connectionPill: document.querySelector('#connection-pill'),
  cwdValue: document.querySelector('#cwd-value'),
  imageInput: document.querySelector('#image-input'),
  insertCommandButton: document.querySelector('#insert-command-button'),
  loginModal: document.querySelector('#login-modal'),
  messages: document.querySelector('#messages'),
  modelValue: document.querySelector('#model-value'),
  promptInput: document.querySelector('#prompt-input'),
  quotaCwd: document.querySelector('#quota-cwd'),
  quotaPrimary: document.querySelector('#quota-primary'),
  quotaRow: document.querySelector('#quota-row'),
  quotaSecondary: document.querySelector('#quota-secondary'),
  refreshButton: document.querySelector('#refresh-button'),
  sendButton: document.querySelector('#send-button'),
  stopButton: document.querySelector('#stop-button'),
  serverValue: document.querySelector('#server-value'),
  sessionBrowserButton: document.querySelector('#session-browser-button'),
  sessionSidebarButton: document.querySelector('#session-sidebar-button'),
  sessionValue: document.querySelector('#session-value'),
  sheetCloseButton: document.querySelector('#sheet-close-button'),
  sheetContent: document.querySelector('#sheet-content'),
  sheetModal: document.querySelector('#sheet-modal'),
  sheetTitle: document.querySelector('#sheet-title'),
  steerButton: document.querySelector('#steer-button'),
  streamingValue: document.querySelector('#streaming-value'),
  thinkingValue: document.querySelector('#thinking-value'),
  toastHost: document.querySelector('#toast-host'),
  tokenInput: document.querySelector('#token-input'),
  tokenSaveButton: document.querySelector('#token-save-button'),
  treeBrowserButton: document.querySelector('#tree-browser-button'),
  uiModal: document.querySelector('#ui-modal'),
  uiModalButtons: document.querySelector('#ui-modal-buttons'),
  uiModalInput: document.querySelector('#ui-modal-input'),
  uiModalMessage: document.querySelector('#ui-modal-message'),
  uiModalOptions: document.querySelector('#ui-modal-options'),
  uiModalTitle: document.querySelector('#ui-modal-title'),
  widgetStack: document.querySelector('#widget-stack'),
};

function storeToken(token) {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function clearReconnectTimer() {
  if (!state.reconnectTimer) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function resetToken({ clearInput = false } = {}) {
  state.token = '';
  storeToken('');
  if (clearInput) el.tokenInput.value = '';
}

function handleAuthFailure() {
  resetToken({ clearInput: true });
  state.socket = null;
  renderHeader();
  openTokenModal();
  showBanner('Access token required. Enter the current /phone-start token.', 'error');
}

function escapeHtml(text = '') {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const THEME_CSS_VARIABLES = {
  mdCode: '--md-code',
  mdCodeBlock: '--md-code-block',
  mdCodeBlockBorder: '--md-code-block-border',
};

function applyThemePalette(themePayload) {
  const root = document.documentElement;
  const colors = themePayload?.colors || {};

  for (const [colorKey, cssVariable] of Object.entries(THEME_CSS_VARIABLES)) {
    const value = typeof colors[colorKey] === 'string' ? colors[colorKey].trim() : '';
    if (value) root.style.setProperty(cssVariable, value);
    else root.style.removeProperty(cssVariable);
  }

  if (themePayload?.name) root.dataset.piTheme = themePayload.name;
  else delete root.dataset.piTheme;
}

function findInlineCodeMarker(text, startIndex = 0) {
  for (let index = Math.max(0, startIndex); index < text.length; index += 1) {
    if (text[index] !== '`') continue;
    if (text[index - 1] === '`' || text[index + 1] === '`') continue;
    return index;
  }
  return -1;
}

function renderStrongText(text = '') {
  let html = '';
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf('**', cursor);
    if (open === -1) {
      html += escapeHtml(text.slice(cursor));
      break;
    }

    const close = text.indexOf('**', open + 2);
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

function renderInlineMarkdown(text = '') {
  let html = '';
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

function renderTextBlocks(text = '') {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => (block.trim() ? `<p>${renderInlineMarkdown(block)}</p>` : ''))
    .filter(Boolean);

  if (blocks.length) return blocks.join('');
  return text.trim() ? `<p>${renderInlineMarkdown(text)}</p>` : '';
}

function renderCodeBlock(code = '') {
  return `
    <pre class="message-code-block"><code>${escapeHtml(code)}</code></pre>
  `;
}

function renderMarkdownLite(text = '') {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const fencePattern = /```([^`\n]*)\n([\s\S]*?)```/g;
  const parts = [];
  let cursor = 0;
  let match;

  while ((match = fencePattern.exec(normalized))) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: normalized.slice(cursor, match.index) });
    }

    parts.push({ type: 'code', value: match[2].replace(/\n$/, '') });
    cursor = match.index + match[0].length;
  }

  if (cursor < normalized.length) {
    parts.push({ type: 'text', value: normalized.slice(cursor) });
  }

  const html = parts.map((part) => (
    part.type === 'code'
      ? renderCodeBlock(part.value)
      : renderTextBlocks(part.value)
  )).join('');

  return html || '<p><span class="label">(no text)</span></p>';
}

const TOOL_LANGUAGE_LABELS = {
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  css: 'CSS',
  go: 'Go',
  h: 'Header',
  hpp: 'C++',
  html: 'HTML',
  java: 'Java',
  js: 'JS',
  jsx: 'JSX',
  json: 'JSON',
  kt: 'Kotlin',
  md: 'Markdown',
  mjs: 'JS',
  php: 'PHP',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  scss: 'SCSS',
  sh: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  toml: 'TOML',
  ts: 'TypeScript',
  tsx: 'TSX',
  txt: 'Text',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Shell',
};

function normalizeNewlines(text = '') {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function countTextLines(text = '') {
  const normalized = normalizeNewlines(text);
  if (!normalized.length) return 0;
  return normalized.split('\n').length;
}

function normalizedToolName(name = '') {
  return String(name || '').trim().split(' · ')[0].toLowerCase();
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function detectLanguageLabel(filePath = '') {
  const normalized = String(filePath || '').trim().toLowerCase();
  const match = normalized.match(/\.([a-z0-9]+)$/);
  if (!match) return '';
  return TOOL_LANGUAGE_LABELS[match[1]] || match[1].toUpperCase();
}

function getToolPath(item) {
  return typeof item?.args?.path === 'string' ? item.args.path : '';
}

function parseNumberedDiffLines(diffText = '') {
  const normalized = normalizeNewlines(diffText);
  if (!normalized.trim()) return [];

  return normalized
    .split('\n')
    .map((line) => {
      const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
      if (!match) {
        return { kind: 'meta', prefix: '', lineNumber: '', text: line };
      }

      const prefix = match[1];
      return {
        kind: prefix === '+' ? 'added' : prefix === '-' ? 'removed' : 'context',
        prefix,
        lineNumber: match[2].trim(),
        text: match[3] || '',
      };
    })
    .filter((line) => line.kind !== 'meta' || line.text.trim());
}

function buildEditPreviewLines(oldText = '', newText = '') {
  const oldLines = normalizeNewlines(oldText).split('\n');
  const newLines = normalizeNewlines(newText).split('\n');

  if (oldLines.length === 1 && oldLines[0] === '' && newLines.length === 1 && newLines[0] === '') {
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
    lines.push({ kind: 'context', prefix: ' ', lineNumber: String(index + 1), text: oldLines[index] || '' });
  }

  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    lines.push({ kind: 'removed', prefix: '-', lineNumber: String(index + 1), text: oldLines[index] || '' });
  }

  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    lines.push({ kind: 'added', prefix: '+', lineNumber: String(index + 1), text: newLines[index] || '' });
  }

  for (let index = suffix; index > 0; index -= 1) {
    const oldIndex = oldLines.length - index;
    const newIndex = newLines.length - index;
    lines.push({ kind: 'context', prefix: ' ', lineNumber: String(newIndex + 1), text: newLines[newIndex] || oldLines[oldIndex] || '' });
  }

  return lines;
}

function computeDiffStats(lines = []) {
  return lines.reduce((stats, line) => {
    if (line.kind === 'added') stats.added += 1;
    if (line.kind === 'removed') stats.removed += 1;
    return stats;
  }, { added: 0, removed: 0 });
}

function renderToolBadge(text, variant = 'neutral') {
  if (!text) return '';
  return `<span class="tool-panel-badge ${variant}">${escapeHtml(text)}</span>`;
}

function renderDiffLine(line) {
  const prefix = line.prefix || (line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ');
  const gutter = `${prefix}${line.lineNumber || ''}`.trimEnd() || prefix || ' ';
  const text = line.text === '' ? ' ' : line.text;

  return `
    <div class="tool-diff-line ${line.kind || 'context'}">
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
  const hiddenCount = Math.max(0, lines.length - visible.length);

  return `
    <div class="tool-diff-block">
      ${visible.map(renderDiffLine).join('')}
    </div>
    ${hiddenCount > 0 ? `<div class="tool-preview-truncated">… ${hiddenCount} more diff lines</div>` : ''}
  `;
}

function splitToolNotice(text = '') {
  const lines = normalizeNewlines(text).split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const lastLine = lines[lines.length - 1] || '';
  if (lastLine.startsWith('[') && /(Use offset=|limit reached|truncated|saved to temp file|full output)/i.test(lastLine)) {
    lines.pop();
    return { body: lines.join('\n'), notice: lastLine };
  }

  return { body: lines.join('\n'), notice: '' };
}

function renderCodePreview(text = '', { limit = 24, startLine = 1, emptyLabel = 'Empty file.' } = {}) {
  const { body, notice } = splitToolNotice(text);
  const allLines = normalizeNewlines(body).split('\n');
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  if (!allLines.length) {
    return `${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ''}<div class="tool-panel-note">${escapeHtml(emptyLabel)}</div>`;
  }

  const visible = allLines.slice(0, limit);
  const hiddenCount = Math.max(0, allLines.length - visible.length);

  return `
    <div class="tool-code-block">
      ${visible.map((line, index) => `
        <div class="tool-code-line">
          <span class="tool-code-gutter mono">${escapeHtml(String(startLine + index))}</span>
          <span class="tool-code-content mono">${escapeHtml(line === '' ? ' ' : line)}</span>
        </div>
      `).join('')}
    </div>
    ${hiddenCount > 0 ? `<div class="tool-preview-truncated">… ${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}</div>` : ''}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ''}
  `;
}

function renderMarkdownPreview(text = '', { limit = 80 } = {}) {
  const { body, notice } = splitToolNotice(text);
  const lines = normalizeNewlines(body).split('\n');
  const visible = lines.slice(0, limit).join('\n').trim();
  const hiddenCount = Math.max(0, lines.length - limit);

  return `
    <div class="tool-markdown-preview">
      ${renderMarkdownLite(visible || '(empty markdown file)')}
    </div>
    ${hiddenCount > 0 ? `<div class="tool-preview-truncated">… ${hiddenCount} more markdown line${hiddenCount === 1 ? '' : 's'}</div>` : ''}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ''}
  `;
}

function renderTerminalPreview(text = '', { limit = 80 } = {}) {
  const { body, notice } = splitToolNotice(text);
  const lines = normalizeNewlines(body).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const visible = lines.slice(0, limit);
  const hiddenCount = Math.max(0, lines.length - visible.length);
  const terminalText = visible.length ? visible.join('\n') : '(no output)';

  return `
    <pre class="tool-terminal-block mono">${escapeHtml(terminalText)}</pre>
    ${hiddenCount > 0 ? `<div class="tool-preview-truncated">… ${hiddenCount} more output line${hiddenCount === 1 ? '' : 's'}</div>` : ''}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ''}
  `;
}

function summarizeRange(startLine, lineCount) {
  if (!lineCount) return '';
  const endLine = startLine + lineCount - 1;
  return startLine === endLine ? `L${startLine}` : `${startLine}-${endLine}`;
}

function isMarkdownPath(filePath = '') {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function firstImagePart(content) {
  if (!Array.isArray(content)) return null;
  return content.find((part) => part?.type === 'image' && part?.data && part?.mimeType) || null;
}

function escapeAttribute(text = '') {
  return escapeHtml(text).replaceAll('`', '&#096;');
}

function renderImagePreview(content, alt = 'Image preview') {
  const image = firstImagePart(content);
  if (!image) return '';
  return `
    <div class="tool-image-wrap">
      <img class="tool-image-preview" src="data:${escapeAttribute(image.mimeType)};base64,${escapeAttribute(image.data)}" alt="${escapeAttribute(alt)}" loading="lazy" />
    </div>
  `;
}

function parseGrepMatches(text = '') {
  const { body, notice } = splitToolNotice(text);
  const lines = normalizeNewlines(body).split('\n').filter((line) => line.trim());
  const entries = [];

  for (const line of lines) {
    let match = line.match(/^(.+?):(\d+):\s?(.*)$/);
    if (match) {
      entries.push({ path: match[1], lineNumber: Number(match[2]), text: match[3] || '', kind: 'match' });
      continue;
    }

    match = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
    if (match) {
      entries.push({ path: match[1], lineNumber: Number(match[2]), text: match[3] || '', kind: 'context' });
      continue;
    }
  }

  const deduped = [];
  let previousKey = '';
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.path}:${entry.lineNumber}:${entry.text}`;
    if (key === previousKey) continue;
    previousKey = key;
    deduped.push(entry);
  }

  return { entries: deduped, notice };
}

function renderGrepPreview(text = '', { limitFiles = 8, limitLinesPerFile = 10 } = {}) {
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
  const hiddenFiles = Math.max(0, fileEntries.length - limitFiles);
  const visibleFiles = fileEntries.slice(0, limitFiles);

  const html = `
    <div class="tool-match-groups">
      ${visibleFiles.map(([path, items]) => {
        const visibleItems = items.slice(0, limitLinesPerFile);
        const hiddenLines = Math.max(0, items.length - visibleItems.length);
        return `
          <section class="tool-match-group">
            <div class="tool-match-group-header mono">${escapeHtml(path)}</div>
            <div class="tool-match-group-lines">
              ${visibleItems.map((entry) => `
                <div class="tool-match-line ${entry.kind}">
                  <span class="tool-match-gutter mono">${escapeHtml(String(entry.lineNumber))}</span>
                  <span class="tool-match-text mono">${escapeHtml(entry.text === '' ? ' ' : entry.text)}</span>
                </div>
              `).join('')}
            </div>
            ${hiddenLines > 0 ? `<div class="tool-preview-truncated">… ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'} in ${escapeHtml(path)}</div>` : ''}
          </section>
        `;
      }).join('')}
    </div>
    ${hiddenFiles > 0 ? `<div class="tool-preview-truncated">… ${hiddenFiles} more matching file${hiddenFiles === 1 ? '' : 's'}</div>` : ''}
    ${notice ? `<div class="tool-panel-note">${escapeHtml(notice)}</div>` : ''}
  `;

  return { html, matchCount: entries.filter((entry) => entry.kind === 'match').length, fileCount: fileEntries.length, notice };
}

function parseListEntries(text = '') {
  const { body, notice } = splitToolNotice(text);
  return {
    entries: normalizeNewlines(body).split('\n').filter((line) => line.trim()),
    notice,
  };
}

function renderListPreview(entries, { limit = 40 } = {}) {
  if (!entries.length) {
    return '<div class="tool-panel-note">No results.</div>';
  }

  const visible = entries.slice(0, limit);
  const hiddenCount = Math.max(0, entries.length - visible.length);

  return `
    <div class="tool-entry-list">
      ${visible.map((entry) => `
        <div class="tool-entry-row ${entry.endsWith('/') ? 'directory' : 'file'}">
          <span class="tool-entry-icon">${entry.endsWith('/') ? '📁' : '📄'}</span>
          <span class="tool-entry-text mono">${escapeHtml(entry)}</span>
        </div>
      `).join('')}
    </div>
    ${hiddenCount > 0 ? `<div class="tool-preview-truncated">… ${hiddenCount} more result${hiddenCount === 1 ? '' : 's'}</div>` : ''}
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
  note = '',
  content = '',
  defaultOpen = false,
}) {
  const open = isToolPanelOpen(item.id, defaultOpen);

  return `
    <details class="tool-panel tool-panel-${escapeHtml(variant)}" data-tool-panel="${escapeHtml(item.id)}" ${open ? 'open' : ''}>
      <summary class="tool-panel-summary">
        <div class="tool-panel-summary-copy">
          <div class="tool-panel-eyebrow">${escapeHtml(eyebrow)}</div>
          <div class="tool-panel-path mono">${escapeHtml(path)}</div>
        </div>
        <div class="tool-panel-badges">${badges.join('')}</div>
      </summary>
      <div class="tool-panel-body">
        ${note ? `<div class="tool-panel-note">${escapeHtml(note)}</div>` : ''}
        ${content}
      </div>
    </details>
  `;
}

function renderEditToolContent(item) {
  const details = asRecord(item.details);
  const path = getToolPath(item);
  if (!path) return '';

  const diffLines = typeof details?.diff === 'string'
    ? parseNumberedDiffLines(details.diff)
    : buildEditPreviewLines(item.args?.oldText || '', item.args?.newText || '');

  if (!diffLines.length) return '';

  const stats = computeDiffStats(diffLines);
  const badges = [];
  if (stats.added) badges.push(renderToolBadge(`+${stats.added}`, 'added'));
  if (stats.removed) badges.push(renderToolBadge(`-${stats.removed}`, 'removed'));
  if (!stats.added && !stats.removed) badges.push(renderToolBadge(item.live ? 'editing' : 'updated'));
  if (typeof details?.firstChangedLine === 'number') badges.push(renderToolBadge(`L${details.firstChangedLine}`, 'neutral'));

  return renderToolPanel(item, {
    variant: 'edit',
    eyebrow: item.live ? 'Editing file' : 'Edit diff',
    path,
    badges,
    note: typeof details?.diff === 'string' ? '' : 'Preview from the requested replacement block.',
    content: renderDiffPreview(diffLines, { limit: item.live ? 120 : 80 }),
    defaultOpen: true,
  });
}

function renderWriteToolContent(item) {
  const path = getToolPath(item);
  const content = typeof item.args?.content === 'string' ? item.args.content : '';
  if (!path || !content) return '';

  const lineCount = countTextLines(content);
  const byteCount = typeof TextEncoder === 'function' ? new TextEncoder().encode(content).length : content.length;
  const languageLabel = detectLanguageLabel(path);

  const badges = [];
  if (lineCount) badges.push(renderToolBadge(`${lineCount} line${lineCount === 1 ? '' : 's'}`, 'neutral'));
  if (byteCount) badges.push(renderToolBadge(formatBytes(byteCount), 'neutral'));
  if (languageLabel) badges.push(renderToolBadge(languageLabel, 'accent'));

  return renderToolPanel(item, {
    variant: 'write',
    eyebrow: item.live ? 'Writing file' : 'File preview',
    path,
    badges,
    note: 'Preview from the content sent to write.',
    content: renderCodePreview(content, { limit: item.live ? 30 : 24 }),
    defaultOpen: item.live || lineCount <= 14,
  });
}

function renderReadToolContent(item) {
  const path = getToolPath(item);
  const text = item.text || '';
  const rawContent = item.rawContent;
  if (!path) return '';

  const imageHtml = renderImagePreview(rawContent, path);
  const languageLabel = detectLanguageLabel(path);
  const startLine = Number.isFinite(Number(item.args?.offset)) && Number(item.args?.offset) > 0 ? Number(item.args.offset) : 1;
  const { body } = splitToolNotice(text);
  const visibleLineCount = countTextLines(body);
  const rangeLabel = summarizeRange(startLine, visibleLineCount);
  const badges = [];
  if (rangeLabel) badges.push(renderToolBadge(rangeLabel, 'neutral'));
  if (languageLabel) badges.push(renderToolBadge(languageLabel, 'accent'));
  if (imageHtml) badges.push(renderToolBadge('image', 'accent'));

  const content = imageHtml
    || (isMarkdownPath(path)
      ? renderMarkdownPreview(text, { limit: 90 })
      : renderCodePreview(text, {
          limit: item.live ? 60 : 32,
          startLine,
          emptyLabel: 'No readable text returned.',
        }));

  return renderToolPanel(item, {
    variant: 'read',
    eyebrow: item.live ? 'Reading file' : 'Read result',
    path,
    badges,
    content,
    defaultOpen: Boolean(imageHtml) || isMarkdownPath(path) || visibleLineCount <= 14,
  });
}

function renderBashToolContent(item) {
  const details = asRecord(item.details);
  const command = String(item.command || item.args?.command || item.title?.replace(/^bash\s*·\s*/, '') || item.title || 'bash').trim();
  if (!command) return '';

  const badges = [];
  if (item.status === 'running' || item.live) badges.push(renderToolBadge('running', 'accent'));
  else if (item.status === 'error') badges.push(renderToolBadge('failed', 'removed'));
  else if (item.status === 'cancelled') badges.push(renderToolBadge('cancelled', 'neutral'));
  else badges.push(renderToolBadge('done', 'added'));
  if (typeof item.args?.timeout === 'number') badges.push(renderToolBadge(`${item.args.timeout}s timeout`, 'neutral'));
  if (details?.fullOutputPath) badges.push(renderToolBadge('full log saved', 'neutral'));

  const note = typeof details?.fullOutputPath === 'string' ? `Full output: ${details.fullOutputPath}` : '';

  return renderToolPanel(item, {
    variant: 'bash',
    eyebrow: item.live ? 'Shell command running' : 'Shell command',
    path: command,
    badges,
    note,
    content: renderTerminalPreview(item.text || '', { limit: item.live ? 140 : 100 }),
    defaultOpen: true,
  });
}

function renderGrepToolContent(item) {
  const pattern = typeof item.args?.pattern === 'string' ? item.args.pattern : '';
  const searchPath = typeof item.args?.path === 'string' && item.args.path.trim() ? item.args.path : '.';
  const preview = renderGrepPreview(item.text || '', { limitFiles: 10, limitLinesPerFile: 8 });
  const badges = [];
  if (pattern) badges.push(renderToolBadge(pattern.length > 28 ? `${pattern.slice(0, 27)}…` : pattern, 'accent'));
  if (preview.matchCount) badges.push(renderToolBadge(`${preview.matchCount} match${preview.matchCount === 1 ? '' : 'es'}`, 'neutral'));
  if (preview.fileCount) badges.push(renderToolBadge(`${preview.fileCount} file${preview.fileCount === 1 ? '' : 's'}`, 'neutral'));

  return renderToolPanel(item, {
    variant: 'grep',
    eyebrow: item.live ? 'Searching files' : 'Search results',
    path: searchPath,
    badges,
    content: preview.html,
    defaultOpen: preview.matchCount > 0,
  });
}

function renderFindToolContent(item) {
  const { entries, notice } = parseListEntries(item.text || '');
  const searchPath = typeof item.args?.path === 'string' && item.args.path.trim() ? item.args.path : '.';
  const badges = [];
  if (typeof item.args?.pattern === 'string') badges.push(renderToolBadge(item.args.pattern, 'accent'));
  if (entries.length) badges.push(renderToolBadge(`${entries.length} result${entries.length === 1 ? '' : 's'}`, 'neutral'));

  return renderToolPanel(item, {
    variant: 'find',
    eyebrow: item.live ? 'Finding paths' : 'Find results',
    path: searchPath,
    badges,
    note: notice,
    content: renderListPreview(entries, { limit: 60 }),
    defaultOpen: entries.length <= 16,
  });
}

function renderLsToolContent(item) {
  const { entries, notice } = parseListEntries(item.text || '');
  const listPath = typeof item.args?.path === 'string' && item.args.path.trim() ? item.args.path : '.';
  const badges = [];
  if (entries.length) badges.push(renderToolBadge(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, 'neutral'));
  const dirCount = entries.filter((entry) => entry.endsWith('/')).length;
  if (dirCount) badges.push(renderToolBadge(`${dirCount} dir${dirCount === 1 ? '' : 's'}`, 'accent'));

  return renderToolPanel(item, {
    variant: 'ls',
    eyebrow: item.live ? 'Listing directory' : 'Directory listing',
    path: listPath,
    badges,
    note: notice,
    content: renderListPreview(entries, { limit: 80 }),
    defaultOpen: entries.length <= 20,
  });
}

function renderRichToolContent(item) {
  const toolName = normalizedToolName(item.toolName || item.title || '');

  if (toolName === 'edit') return renderEditToolContent(item);
  if (toolName === 'write') return renderWriteToolContent(item);
  if (toolName === 'read') return renderReadToolContent(item);
  if (toolName === 'bash') return renderBashToolContent(item);
  if (toolName === 'grep') return renderGrepToolContent(item);
  if (toolName === 'find') return renderFindToolContent(item);
  if (toolName === 'ls') return renderLsToolContent(item);
  return '';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image') return '[image]';
      if (part.type === 'thinking') return '';
      if (part.type === 'toolCall') return '';
      return '';
    })
    .join(' ')
    .trim();
}

function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part.type === 'image').length;
}

function assistantParts(content) {
  const parts = { text: '', thinking: '', toolCalls: [] };
  if (!Array.isArray(content)) return parts;

  for (const block of content) {
    if (block.type === 'text') parts.text += block.text || '';
    if (block.type === 'thinking') parts.thinking += block.thinking || '';
    if (block.type === 'toolCall') {
      parts.toolCalls.push({ id: block.id || '', name: block.name || 'tool', arguments: block.arguments || {} });
    }
  }

  return parts;
}

function toDetailString(details) {
  if (details == null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function transformMessage(message, index) {
  if (!message || typeof message !== 'object') return [];

  if (message.role === 'user') {
    return [{
      id: `user-${message.timestamp || index}`,
      kind: 'user',
      meta: formatTimestamp(message.timestamp),
      text: contentToText(message.content),
      imageCount: countImages(message.content),
    }];
  }

  if (message.role === 'assistant') {
    const parts = assistantParts(message.content);
    return [{
      id: `assistant-${message.timestamp || index}`,
      kind: 'assistant',
      meta: [message.model, formatTimestamp(message.timestamp)].filter(Boolean).join(' · '),
      text: parts.text,
      thinking: parts.thinking,
      toolCalls: parts.toolCalls,
      details: message.usage || message.stopReason ? {
        usage: message.usage,
        stopReason: message.stopReason,
      } : undefined,
    }];
  }

  if (message.role === 'toolResult') {
    return [{
      id: `tool-${message.toolCallId || message.timestamp || index}`,
      kind: 'tool',
      toolCallId: message.toolCallId,
      toolName: message.toolName || 'tool',
      title: message.toolName || 'tool',
      status: message.isError ? 'error' : 'done',
      text: contentToText(message.content),
      rawContent: message.content,
      meta: formatTimestamp(message.timestamp),
      details: message.details,
    }];
  }

  if (message.role === 'bashExecution') {
    return [{
      id: `bash-${message.timestamp || index}`,
      kind: 'tool',
      toolName: 'bash',
      title: `bash · ${message.command || ''}`,
      command: message.command || '',
      args: { command: message.command || '' },
      status: message.cancelled ? 'cancelled' : 'done',
      text: message.output || '',
      meta: formatTimestamp(message.timestamp),
      details: {
        exitCode: message.exitCode,
        truncated: message.truncated,
        fullOutputPath: message.fullOutputPath,
      },
    }];
  }

  if (message.role === 'custom') {
    if (message.display === false) return [];
    return [{
      id: `custom-${message.timestamp || index}`,
      kind: 'custom',
      title: message.customType || 'extension',
      text: contentToText(message.content),
      meta: formatTimestamp(message.timestamp),
      details: message.details,
      imageCount: countImages(message.content),
    }];
  }

  if (message.role === 'branchSummary') {
    return [{
      id: `branch-summary-${message.timestamp || index}`,
      kind: 'summary',
      title: 'Branch summary',
      text: message.summary || '',
      meta: formatTimestamp(message.timestamp),
      details: { fromId: message.fromId },
    }];
  }

  if (message.role === 'compactionSummary') {
    return [{
      id: `compaction-summary-${message.timestamp || index}`,
      kind: 'summary',
      title: `Compaction summary${message.tokensBefore ? ` · ${message.tokensBefore.toLocaleString()} tokens` : ''}`,
      text: message.summary || '',
      meta: formatTimestamp(message.timestamp),
    }];
  }

  return [];
}

function renderMessageMeta(item) {
  const pills = [];
  if (item.imageCount) pills.push(`<span class="inline-pill">${item.imageCount} image${item.imageCount === 1 ? '' : 's'}</span>`);
  if (item.status) pills.push(`<span class="inline-pill">${escapeHtml(item.status)}</span>`);
  return pills.join(' ');
}

function renderDetailSection(title, value, options = {}) {
  if (!value) return '';

  const body = options.markdown
    ? `<div class="detail-content detail-markdown">${renderMarkdownLite(value)}</div>`
    : `<pre class="detail-pre">${escapeHtml(value)}</pre>`;

  return `
    <details>
      <summary>${escapeHtml(title)}</summary>
      ${body}
    </details>
  `;
}

function renderAssistantDetails(item) {
  const sections = [];
  if (item.thinking) sections.push(renderDetailSection('Thinking', item.thinking, { markdown: true }));

  if (item.toolCalls?.length) {
    sections.push(renderDetailSection('Tool calls', JSON.stringify(item.toolCalls, null, 2)));
  }

  if (item.details) {
    sections.push(renderDetailSection('Details', toDetailString(item.details)));
  }

  return sections.join('');
}

function toolDetailsForSecondarySection(item) {
  if (!item.details) return null;

  const details = asRecord(item.details);
  if (normalizedToolName(item.toolName || item.title || '') !== 'edit' || !details) {
    return item.details;
  }

  const { diff, firstChangedLine, ...rest } = details;
  return Object.keys(rest).length ? rest : null;
}

function renderMessage(item) {
  const richTool = item.kind === 'tool' ? renderRichToolContent(item) : '';
  const roleLabel = {
    assistant: 'Pi',
    custom: item.title || 'Extension',
    summary: item.title || 'Summary',
    system: 'System',
    tool: richTool ? 'Tool' : item.title || 'Tool',
    user: 'You',
  }[item.kind] || 'Message';

  const bodyMain = richTool || (item.kind === 'tool'
    ? `<pre>${escapeHtml(item.text || '')}</pre>`
    : renderMarkdownLite(item.text || ''));

  const detailValue = item.kind === 'tool' ? toolDetailsForSecondarySection(item) : item.details;
  const extraDetails = item.kind === 'assistant'
    ? renderAssistantDetails(item)
    : detailValue
      ? renderDetailSection('Details', toDetailString(detailValue))
      : '';

  return `
    <article class="message ${item.kind}">
      <div class="message-header">
        <div class="role-badge">${escapeHtml(roleLabel)}${item.live ? ' · live' : ''}</div>
        <div class="meta">${escapeHtml(item.meta || '')}</div>
      </div>
      <div class="message-body">
        ${bodyMain}
        ${richTool ? '' : renderMessageMeta(item)}
        ${extraDetails}
      </div>
    </article>
  `;
}

function enrichToolItems(items) {
  const toolCalls = new Map();

  for (const item of items) {
    if (item.kind !== 'assistant' || !Array.isArray(item.toolCalls)) continue;
    for (const toolCall of item.toolCalls) {
      if (!toolCall?.id) continue;
      toolCalls.set(toolCall.id, toolCall);
    }
  }

  return items.map((item) => {
    if (item.kind !== 'tool' || item.args || !item.toolCallId) return item;
    const linked = toolCalls.get(item.toolCallId);
    if (!linked) return item;
    return { ...item, args: linked.arguments || {} };
  });
}

function currentItems() {
  const items = [...state.messages];
  for (const tool of state.liveTools.values()) items.push(tool);
  if (state.liveAssistant) items.push(state.liveAssistant);
  return enrichToolItems(items);
}

function isAnyModalOpen() {
  return !el.sheetModal.classList.contains('hidden') || !el.uiModal.classList.contains('hidden') || !el.loginModal.classList.contains('hidden');
}

function scrollMessagesToBottom() {
  if (isAnyModalOpen()) return;
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
}

function renderMessages() {
  const items = currentItems();
  if (!items.length) {
    el.messages.innerHTML = `
      <article class="message system">
        <div class="message-header"><div class="role-badge">Ready</div></div>
        <div class="message-body">
          <p>This phone UI now exposes much more of Pi: commands, models, thinking, sessions, tree history, custom extension messages, and image upload.</p>
        </div>
      </article>
    `;
    return;
  }

  el.messages.innerHTML = items.map(renderMessage).join('');
  scrollMessagesToBottom();
}

function renderWidgets() {
  const widgets = [...state.widgets.entries()];
  if (!widgets.length && !state.footerStatus) {
    el.widgetStack.classList.add('hidden');
    el.widgetStack.innerHTML = '';
    return;
  }

  const cards = widgets.map(([key, lines]) => `
    <article class="widget-card">
      <h3>${escapeHtml(key)}</h3>
      <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    </article>
  `);

  if (state.footerStatus) {
    cards.unshift(`
      <article class="widget-card">
        <h3>Extension status</h3>
        <div>${escapeHtml(state.footerStatus)}</div>
      </article>
    `);
  }

  el.widgetStack.innerHTML = cards.join('');
  el.widgetStack.classList.remove('hidden');
}

function showBanner(text, kind = 'info') {
  if (!text) {
    el.banner.classList.add('hidden');
    el.banner.textContent = '';
    el.banner.classList.remove('error');
    return;
  }
  el.banner.textContent = text;
  el.banner.classList.toggle('error', kind === 'error');
  el.banner.classList.remove('hidden');
}

function showToast(text, kind = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind === 'error' ? 'error' : ''}`;
  toast.textContent = text;
  el.toastHost.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function currentQuotaModel() {
  const model = state.snapshotState?.model;
  if (!model || typeof model !== 'object') return null;
  return {
    provider: typeof model.provider === 'string' ? model.provider : '',
    modelId: typeof model.id === 'string' ? model.id : '',
  };
}

function shouldShowQuotaForModel(model = currentQuotaModel()) {
  if (!model) return false;
  return model.provider === 'openai-codex' && /^gpt-/i.test(model.modelId || '');
}

function quotaPillClassName(leftPercent) {
  if (!Number.isFinite(leftPercent)) return '';
  if (leftPercent <= 10) return 'danger';
  if (leftPercent <= 25) return 'warn';
  return 'good';
}

function renderQuota() {
  const cwd = state.status?.cwd || state.health?.cwd || '';
  if (cwd) {
    el.quotaCwd.textContent = `cwd: ${cwd}`;
    el.quotaCwd.title = cwd;
    el.quotaCwd.className = 'quota-pill cwd-pill mono';
  } else {
    el.quotaCwd.textContent = '';
    el.quotaCwd.title = '';
    el.quotaCwd.className = 'quota-pill cwd-pill mono hidden';
  }

  if (!shouldShowQuotaForModel()) {
    state.quota = null;
    el.quotaPrimary.textContent = '';
    el.quotaSecondary.textContent = '';
    el.quotaPrimary.title = '';
    el.quotaSecondary.title = '';
    el.quotaPrimary.removeAttribute('aria-label');
    el.quotaSecondary.removeAttribute('aria-label');
    el.quotaPrimary.className = 'quota-pill hidden';
    el.quotaSecondary.className = 'quota-pill hidden';
    el.quotaRow.classList.toggle('hidden', !cwd);
    return;
  }

  const primary = state.quota?.primaryWindow;
  const secondary = state.quota?.secondaryWindow;
  if (!state.quota?.visible || (!primary && !secondary)) {
    el.quotaPrimary.textContent = '';
    el.quotaSecondary.textContent = '';
    el.quotaPrimary.title = '';
    el.quotaSecondary.title = '';
    el.quotaPrimary.removeAttribute('aria-label');
    el.quotaSecondary.removeAttribute('aria-label');
    el.quotaPrimary.className = 'quota-pill hidden';
    el.quotaSecondary.className = 'quota-pill hidden';
    el.quotaRow.classList.toggle('hidden', !cwd);
    return;
  }

  if (primary) {
    el.quotaPrimary.textContent = primary.text;
    el.quotaPrimary.title = `${primary.label} quota remaining`;
    el.quotaPrimary.setAttribute('aria-label', `${primary.label} quota remaining ${primary.text}`);
    el.quotaPrimary.className = `quota-pill ${quotaPillClassName(primary.leftPercent)}`.trim();
    el.quotaPrimary.classList.remove('hidden');
  } else {
    el.quotaPrimary.textContent = '';
    el.quotaPrimary.title = '';
    el.quotaPrimary.removeAttribute('aria-label');
    el.quotaPrimary.className = 'quota-pill hidden';
  }

  if (secondary) {
    el.quotaSecondary.textContent = secondary.text;
    el.quotaSecondary.title = `${secondary.label} quota remaining`;
    el.quotaSecondary.setAttribute('aria-label', `${secondary.label} quota remaining ${secondary.text}`);
    el.quotaSecondary.className = `quota-pill ${quotaPillClassName(secondary.leftPercent)}`.trim();
    el.quotaSecondary.classList.remove('hidden');
  } else {
    el.quotaSecondary.textContent = '';
    el.quotaSecondary.title = '';
    el.quotaSecondary.removeAttribute('aria-label');
    el.quotaSecondary.className = 'quota-pill hidden';
  }

  el.quotaRow.classList.remove('hidden');
}

async function refreshQuota({ force = false } = {}) {
  const model = currentQuotaModel();
  if (!shouldShowQuotaForModel(model)) {
    state.quota = null;
    renderQuota();
    return;
  }

  const requestId = ++state.quotaRequestId;

  try {
    const url = new URL('/api/quota', window.location.origin);
    url.searchParams.set('provider', model.provider);
    url.searchParams.set('modelId', model.modelId);
    if (force) url.searchParams.set('force', '1');

    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Quota request failed (${response.status})`);

    const quota = await response.json();
    if (requestId !== state.quotaRequestId) return;
    state.quota = quota;
  } catch {
    if (requestId !== state.quotaRequestId) return;
    if (!state.quota?.visible) {
      state.quota = null;
    }
  }

  renderQuota();
}

function updateComposerState() {
  const streaming = Boolean(state.status?.isStreaming || state.snapshotState?.isStreaming);
  const sendLabel = streaming ? 'Queue message' : 'Send message';

  el.abortButton.disabled = !streaming;
  if (el.stopButton) {
    el.stopButton.disabled = !streaming;
    el.stopButton.classList.toggle('hidden', !streaming);
  }
  el.sendButton.textContent = '>';
  el.sendButton.setAttribute('aria-label', sendLabel);
  el.sendButton.setAttribute('title', sendLabel);
  el.steerButton.classList.toggle('hidden', !streaming);
}

function renderHeader() {
  const connected = state.socket?.readyState === WebSocket.OPEN;
  el.connectionPill.textContent = connected ? 'Connected' : 'Offline';
  el.connectionPill.classList.toggle('offline', !connected);

  const status = state.status || state.health || {};
  applyThemePalette(status.theme || state.health?.theme || null);
  const snapshotMatchesActive = !state.snapshotWorkerId || !state.activeSessionId || state.snapshotWorkerId === state.activeSessionId;
  const snapshot = snapshotMatchesActive ? (state.snapshotState || {}) : {};
  const activeSession = state.activeSessions.find((session) => session.id === state.activeSessionId) || null;
  el.cwdValue.textContent = status.cwd || '—';
  el.sessionValue.textContent = snapshot.sessionName || snapshot.sessionId || activeSession?.label || 'Current session';
  el.modelValue.textContent = snapshot.model?.name || snapshot.model?.id || activeSession?.model?.name || 'Default';
  el.thinkingValue.textContent = snapshot.thinkingLevel || '—';
  el.streamingValue.textContent = status.isStreaming || snapshot.isStreaming ? 'Streaming' : 'Idle';
  el.serverValue.textContent = status.port ? `${status.host || '127.0.0.1'}:${status.port}` : '—';
  updateComposerState();
  renderQuota();
}

function autoResizeTextarea() {
  el.promptInput.style.height = 'auto';
  el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 220)}px`;
}

function openTokenModal() {
  clearReconnectTimer();
  if (el.loginModal.classList.contains('hidden')) {
    el.tokenInput.value = state.token;
  }
  el.loginModal.classList.remove('hidden');
  setTimeout(() => el.tokenInput.focus(), 10);
}

function closeTokenModal() {
  el.loginModal.classList.add('hidden');
}

function clearUiModal() {
  state.pendingUiRequest = null;
  el.uiModal.classList.add('hidden');
  el.uiModalOptions.innerHTML = '';
  el.uiModalButtons.innerHTML = '';
  el.uiModalInput.value = '';
  el.uiModalInput.classList.add('hidden');
}

function sendUiResponse(payload) {
  sendRpc({ type: 'extension_ui_response', ...payload });
  clearUiModal();
}

function openUiModalForRequest(request) {
  state.pendingUiRequest = request;
  el.uiModalTitle.textContent = request.title || 'Action required';
  el.uiModalMessage.textContent = request.message || '';
  el.uiModalOptions.innerHTML = '';
  el.uiModalButtons.innerHTML = '';
  el.uiModalInput.value = request.prefill || '';
  el.uiModalInput.classList.add('hidden');

  const addCancel = () => {
    const cancelButton = document.createElement('button');
    cancelButton.className = 'secondary';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => sendUiResponse({ id: request.id, cancelled: true }));
    el.uiModalButtons.appendChild(cancelButton);
  };

  if (request.method === 'select') {
    for (const option of request.options || []) {
      const button = document.createElement('button');
      button.textContent = option;
      button.className = 'secondary';
      button.addEventListener('click', () => sendUiResponse({ id: request.id, value: option }));
      el.uiModalOptions.appendChild(button);
    }
    addCancel();
  } else if (request.method === 'confirm') {
    const denyButton = document.createElement('button');
    denyButton.className = 'secondary';
    denyButton.textContent = 'No';
    denyButton.addEventListener('click', () => sendUiResponse({ id: request.id, confirmed: false }));

    const confirmButton = document.createElement('button');
    confirmButton.textContent = 'Yes';
    confirmButton.addEventListener('click', () => sendUiResponse({ id: request.id, confirmed: true }));

    el.uiModalButtons.appendChild(denyButton);
    el.uiModalButtons.appendChild(confirmButton);
  } else if (request.method === 'input' || request.method === 'editor') {
    el.uiModalInput.classList.remove('hidden');
    el.uiModalInput.placeholder = request.placeholder || '';

    const submitButton = document.createElement('button');
    submitButton.textContent = 'Submit';
    submitButton.addEventListener('click', () => sendUiResponse({ id: request.id, value: el.uiModalInput.value }));

    addCancel();
    el.uiModalButtons.appendChild(submitButton);
  }

  el.uiModal.classList.remove('hidden');
  setTimeout(() => {
    if (request.method === 'input' || request.method === 'editor') el.uiModalInput.focus();
  }, 10);
}

function handleExtensionUiRequest(request) {
  if (request.method === 'notify') {
    showToast(request.message || 'Notification');
    return;
  }

  if (request.method === 'setStatus') {
    state.footerStatus = request.statusText || '';
    renderWidgets();
    return;
  }

  if (request.method === 'setWidget') {
    if (request.widgetLines?.length) state.widgets.set(request.widgetKey || 'widget', request.widgetLines);
    else state.widgets.delete(request.widgetKey || 'widget');
    renderWidgets();
    return;
  }

  if (request.method === 'setTitle') {
    document.title = request.title || 'Pi Phone';
    return;
  }

  if (request.method === 'set_editor_text') {
    el.promptInput.value = request.text || '';
    autoResizeTextarea();
    renderCommandSuggestions();
    return;
  }

  if (!['select', 'confirm', 'input', 'editor'].includes(request.method)) {
    showToast(`Unsupported UI request: ${request.method || 'unknown'}`);
    return;
  }

  openUiModalForRequest(request);
}

function handleAssistantEvent(event) {
  if (!event) return;
  if (!state.liveAssistant) {
    state.liveAssistant = {
      id: 'assistant-live',
      kind: 'assistant',
      live: true,
      text: '',
      thinking: '',
      toolCalls: [],
      meta: 'Streaming…',
    };
  }

  if (event.type === 'text_delta') state.liveAssistant.text += event.delta || '';
  if (event.type === 'thinking_delta') state.liveAssistant.thinking += event.delta || '';
  if (event.type === 'toolcall_end' && event.toolCall) {
    state.liveAssistant.toolCalls.push({ id: event.toolCall.id || '', name: event.toolCall.name || 'tool', arguments: event.toolCall.arguments || {} });
  }
  if (event.type === 'error') showToast(event.message || 'Agent error', 'error');
  renderMessages();
}

function upsertLiveTool(toolId, value) {
  state.liveTools.set(toolId, value);
  renderMessages();
}

function clearTransientState() {
  state.liveAssistant = null;
  state.liveTools.clear();
}

function clearSnapshotView() {
  state.snapshotState = null;
  state.snapshotWorkerId = null;
  state.messages = [];
  clearTransientState();
}

function compareCommandNames(left, right) {
  return String(left?.name || '').localeCompare(String(right?.name || ''));
}

function sortCommandCategories(categories = []) {
  return [...categories].sort((left, right) => {
    const leftIndex = COMMAND_CATEGORY_ORDER.indexOf(left);
    const rightIndex = COMMAND_CATEGORY_ORDER.indexOf(right);
    const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

    if (normalizedLeftIndex !== normalizedRightIndex) return normalizedLeftIndex - normalizedRightIndex;
    return String(left || '').localeCompare(String(right || ''));
  });
}

function localCommandCatalog() {
  return LOCAL_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    source: 'local',
    insertOnly: Boolean(command.insertOnly),
  }));
}

function visibleCommandCatalog() {
  const localCommands = localCommandCatalog();
  const localNames = new Set(localCommands.map((command) => command.name));
  return [
    ...localCommands,
    ...state.commands.filter((command) => !localNames.has(command.name)),
  ];
}

function findLocalCommandDefinition(name) {
  return LOCAL_COMMANDS.find((command) => command.name === name) || null;
}

function groupedCommands() {
  const groups = new Map();
  const merged = visibleCommandCatalog();

  for (const command of merged) {
    const key = command.source || 'command';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(command);
  }

  for (const commands of groups.values()) {
    commands.sort(compareCommandNames);
  }

  return new Map(sortCommandCategories([...groups.keys()]).map((category) => [category, groups.get(category) || []]));
}

function commandCategoryLabel(category = '') {
  if (!category) return 'Commands';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function selectedCommandCategory(categories = []) {
  if (!categories.length) {
    state.commandSheetCategory = '';
    return '';
  }

  if (categories.includes(state.commandSheetCategory)) {
    return state.commandSheetCategory;
  }

  state.commandSheetCategory = categories[0];
  return state.commandSheetCategory;
}

function activeAutocompleteContext() {
  const value = el.promptInput.value || '';
  const cursor = el.promptInput.selectionStart ?? value.length;

  const mention = detectMentionAutocompleteContext(value, cursor);
  if (mention) return mention;

  const cd = detectCdAutocompleteContext(value, cursor);
  if (cd) return cd;

  const slash = detectSlashCommandAutocompleteContext(value, cursor);
  if (slash) return slash;

  return null;
}

function clearAutocompleteSuggestions() {
  if (state.autocompleteRemoteTimer) {
    clearTimeout(state.autocompleteRemoteTimer);
    state.autocompleteRemoteTimer = null;
  }
  state.autocompleteContext = null;
  state.autocompleteItems = [];
  el.commandStrip.classList.add('hidden');
  el.commandStrip.innerHTML = '';
}

function renderAutocompleteItems(items = []) {
  state.autocompleteItems = items;

  if (!items.length) {
    el.commandStrip.classList.add('hidden');
    el.commandStrip.innerHTML = '';
    return;
  }

  el.commandStrip.innerHTML = items.map((item, index) => `
    <button class="command-chip secondary" data-autocomplete-index="${index}" title="${escapeAttribute(item.title || item.description || item.label || '')}">
      <span>${escapeHtml(item.label || '')}</span>
      <span class="source">${escapeHtml(item.badge || '')}</span>
    </button>
  `).join('');
  el.commandStrip.classList.remove('hidden');
}

function requestPathSuggestions(context) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    renderAutocompleteItems([]);
    return;
  }

  const requestId = ++state.autocompleteRemoteRequestId;
  sendLocalCommand({
    type: 'path-suggestions',
    mode: context.mode,
    query: context.query,
    requestId,
  });
}

function queuePathSuggestions(context) {
  if (state.autocompleteRemoteTimer) {
    clearTimeout(state.autocompleteRemoteTimer);
  }

  state.autocompleteRemoteTimer = setTimeout(() => {
    state.autocompleteRemoteTimer = null;
    requestPathSuggestions(context);
  }, 90);
}

function renderCommandSuggestions() {
  const context = activeAutocompleteContext();
  state.autocompleteContext = context;

  if (!context) {
    clearAutocompleteSuggestions();
    return;
  }

  if (context.type === 'slash-command') {
    const matches = visibleCommandCatalog()
      .filter((command) => command.name.toLowerCase().startsWith(context.query.toLowerCase()))
      .slice(0, 10)
      .map((command) => ({
        kind: command.source === 'local' ? (command.insertOnly ? 'local-command-insert' : 'local-command-run') : 'remote-command-insert',
        label: `/${command.name}`,
        badge: command.source || 'command',
        description: command.description || '',
        name: command.name,
      }));

    renderAutocompleteItems(matches);
    return;
  }

  renderAutocompleteItems([]);
  queuePathSuggestions(context);
}

function delimiterBeforeIndex(text, index) {
  return index <= 0 || AUTOCOMPLETE_DELIMITERS.has(text[index - 1]);
}

function findTokenBounds(text, start, end) {
  let tokenStart = start;
  let tokenEnd = end;

  while (tokenStart > 0 && !AUTOCOMPLETE_DELIMITERS.has(text[tokenStart - 1])) {
    tokenStart -= 1;
  }
  while (tokenEnd < text.length && !AUTOCOMPLETE_DELIMITERS.has(text[tokenEnd])) {
    tokenEnd += 1;
  }

  return { start: tokenStart, end: tokenEnd };
}

function detectMentionAutocompleteContext(text, cursor) {
  const scanLimit = Math.min(cursor, text.length);
  let tokenStart = scanLimit;
  while (tokenStart > 0 && !AUTOCOMPLETE_DELIMITERS.has(text[tokenStart - 1])) {
    tokenStart -= 1;
  }

  if (text[tokenStart] !== '@') return null;
  if (!delimiterBeforeIndex(text, tokenStart)) return null;

  const bounds = findTokenBounds(text, tokenStart, cursor);
  return {
    type: 'path',
    mode: 'mention',
    query: text.slice(tokenStart + 1, cursor),
    replaceStart: bounds.start,
    replaceEnd: bounds.end,
  };
}

function detectCdAutocompleteContext(text, cursor) {
  const leadingWhitespace = text.match(/^\s*/)?.[0] || '';
  const trimmed = text.slice(leadingWhitespace.length);
  if (!trimmed.startsWith('/cd')) return null;

  const afterCommand = trimmed.slice(3);
  if (afterCommand && !/^\s/.test(afterCommand)) return null;

  const commandStart = leadingWhitespace.length;
  const argsStart = commandStart + 3 + (afterCommand.match(/^\s*/) || [''])[0].length;
  if (cursor < argsStart) return null;

  return {
    type: 'path',
    mode: 'cd',
    query: text.slice(argsStart, cursor),
    replaceStart: argsStart,
    replaceEnd: text.length,
  };
}

function detectSlashCommandAutocompleteContext(text, cursor) {
  const leadingWhitespace = text.match(/^\s*/)?.[0] || '';
  const trimmedBeforeCursor = text.slice(leadingWhitespace.length, cursor);
  if (!trimmedBeforeCursor.startsWith('/')) return null;
  if (/\s/.test(trimmedBeforeCursor.slice(1))) return null;

  return {
    type: 'slash-command',
    query: trimmedBeforeCursor.slice(1),
  };
}

function replacePromptRange(start, end, nextText) {
  const value = el.promptInput.value;
  el.promptInput.value = `${value.slice(0, start)}${nextText}${value.slice(end)}`;
  const nextCursor = start + nextText.length;
  el.promptInput.focus();
  el.promptInput.setSelectionRange(nextCursor, nextCursor);
  autoResizeTextarea();
  renderCommandSuggestions();
}

function insertTextAtCursor(text) {
  const start = el.promptInput.selectionStart ?? el.promptInput.value.length;
  const end = el.promptInput.selectionEnd ?? start;
  replacePromptRange(start, end, text);
}

function insertCdCommand() {
  const value = el.promptInput.value;
  if (!value.trim()) {
    el.promptInput.value = '/cd ';
    el.promptInput.focus();
    el.promptInput.setSelectionRange(4, 4);
    autoResizeTextarea();
    renderCommandSuggestions();
    return;
  }

  insertTextAtCursor('/cd ');
}

function applyAutocompleteItem(item) {
  const context = state.autocompleteContext;
  if (!item) return;

  if (item.kind === 'local-command-run') {
    const result = tryHandleLocalCommand(`/${item.name}`, { hasAttachments: state.attachments.length > 0 });
    if (result === 'handled') {
      el.promptInput.value = '';
      autoResizeTextarea();
      renderCommandSuggestions();
    }
    return;
  }

  if (item.kind === 'local-command-insert' || item.kind === 'remote-command-insert') {
    el.promptInput.value = `/${item.name} `;
    autoResizeTextarea();
    renderCommandSuggestions();
    el.promptInput.focus();
    return;
  }

  if (!context || context.type !== 'path') return;

  if (context.mode === 'mention') {
    const suffix = item.isDirectory ? '' : ' ';
    replacePromptRange(context.replaceStart, context.replaceEnd, `@${item.value}${suffix}`);
    return;
  }

  const suffix = item.isDirectory ? '' : ' ';
  replacePromptRange(context.replaceStart, context.replaceEnd, `${item.value}${suffix}`);
}

function renderAttachmentStrip() {
  if (!state.attachments.length) {
    el.attachmentStrip.classList.add('hidden');
    el.attachmentStrip.innerHTML = '';
    return;
  }

  el.attachmentStrip.innerHTML = state.attachments.map((attachment) => `
    <article class="attachment-chip">
      <img src="${attachment.url}" alt="${escapeHtml(attachment.name)}" />
      <div class="attachment-chip-header">
        <div class="attachment-chip-name">${escapeHtml(attachment.name)}</div>
        <button class="attachment-chip-remove" data-remove-attachment="${attachment.id}" aria-label="Remove image">✕</button>
      </div>
      <div class="attachment-chip-meta">${escapeHtml(formatBytes(attachment.size))}</div>
    </article>
  `).join('');
  el.attachmentStrip.classList.remove('hidden');
}

function addAttachments(files) {
  const incoming = Array.from(files || []).filter((file) => file.type.startsWith('image/'));
  for (const file of incoming) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.attachments.push({
      id,
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      url: URL.createObjectURL(file),
    });
  }
  renderAttachmentStrip();
}

function removeAttachment(id) {
  const index = state.attachments.findIndex((attachment) => attachment.id === id);
  if (index === -1) return;
  URL.revokeObjectURL(state.attachments[index].url);
  state.attachments.splice(index, 1);
  renderAttachmentStrip();
}

function clearAttachments() {
  for (const attachment of state.attachments) {
    URL.revokeObjectURL(attachment.url);
  }
  state.attachments = [];
  renderAttachmentStrip();
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function buildPromptImages() {
  return Promise.all(
    state.attachments.map(async (attachment) => ({
      type: 'image',
      data: await fileToBase64(attachment.file),
      mimeType: attachment.type || 'image/png',
    })),
  );
}

function refreshAll(options = {}) {
  const { forceQuota = false } = options;

  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ kind: 'refresh' }));
    sendRpc({ type: 'get_commands' });
    sendRpc({ type: 'get_available_models' });
  }

  void refreshQuota({ force: forceQuota });
}

function sendRpc(command) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast('Not connected to Pi.', 'error');
    return false;
  }
  state.socket.send(JSON.stringify({ kind: 'rpc', command }));
  return true;
}

function sendLocalCommand(command) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast('Not connected to Pi.', 'error');
    return false;
  }

  state.socket.send(JSON.stringify({ kind: 'local-command', command }));
  return true;
}

function requestReload() {
  if (state.status?.isStreaming || state.snapshotState?.isStreaming) {
    showToast('Wait for the current response to finish before reloading.', 'error');
    return false;
  }

  if (state.snapshotState?.isCompacting) {
    showToast('Wait for compaction to finish before reloading.', 'error');
    return false;
  }

  return sendLocalCommand('reload');
}

function sendCdCommand(args = '') {
  return sendLocalCommand({ type: 'cd', args });
}

function parseLocalCommandInput(text) {
  const match = String(text || '').match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1] || '',
    args: match[2] || '',
  };
}

function parseSlashCommandText(text) {
  const value = String(text || '').trim();
  if (!value.startsWith('/')) return null;

  const body = value.slice(1).trim();
  if (!body) return null;

  const spaceIndex = body.indexOf(' ');
  const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);

  return {
    text: `/${body}`,
    name,
  };
}

function findRemoteSlashCommand(text) {
  const parsed = parseSlashCommandText(text);
  if (!parsed) return null;

  const match = state.commands.find((command) => command.name === parsed.name);
  if (!match) return null;

  return {
    ...parsed,
    source: match.source || 'extension',
  };
}

function sendRemoteSlashCommand(command, { images = [], steer = false } = {}) {
  if (command.source === 'extension' && images.length > 0) {
    showToast('Extension slash commands do not support image attachments.', 'error');
    return 'blocked';
  }

  const streaming = Boolean(state.status?.isStreaming || state.snapshotState?.isStreaming);
  const sent = sendLocalCommand({
    type: 'slash-command',
    text: command.text,
    ...(images.length ? { images } : {}),
    ...(command.source !== 'extension'
      ? steer
        ? { streamingBehavior: 'steer' }
        : streaming
          ? { streamingBehavior: 'followUp' }
          : {}
      : {}),
  });

  return sent ? 'handled' : false;
}

function openSheet(mode = 'actions') {
  state.sheetMode = mode;
  el.sheetModal.classList.remove('hidden');
  renderSheet();

  if (mode === 'actions') sendRpc({ type: 'get_session_stats' });
  if (mode === 'models') sendRpc({ type: 'get_available_models' });
  if (mode === 'commands') sendRpc({ type: 'get_commands' });
  if (mode === 'sessions') sendRpc({ type: 'phone_list_sessions' });
  if (mode === 'tree') sendRpc({ type: 'phone_get_tree' });
}

function closeSheet() {
  el.sheetModal.classList.add('hidden');
}

function renderStatsSection() {
  if (!state.stats) return '<div class="label">Session stats will appear here after refresh.</div>';
  const tokens = state.stats.tokens || {};
  return `
    <div class="stat-grid">
      <div class="stat-chip"><span>Input tokens</span><strong>${escapeHtml((tokens.input || 0).toLocaleString())}</strong></div>
      <div class="stat-chip"><span>Output tokens</span><strong>${escapeHtml((tokens.output || 0).toLocaleString())}</strong></div>
      <div class="stat-chip"><span>Total tokens</span><strong>${escapeHtml((tokens.total || 0).toLocaleString())}</strong></div>
      <div class="stat-chip"><span>Tool calls</span><strong>${escapeHtml(String(state.stats.toolCalls || 0))}</strong></div>
      <div class="stat-chip"><span>Messages</span><strong>${escapeHtml(String(state.stats.totalMessages || 0))}</strong></div>
      <div class="stat-chip"><span>Cost</span><strong>${escapeHtml(state.stats.cost != null ? `$${Number(state.stats.cost).toFixed(4)}` : '—')}</strong></div>
    </div>
  `;
}

function renderActionsSheet() {
  return `
    <section class="sheet-section">
      <h3>Quick actions</h3>
      <div class="sheet-actions">
        <div class="sheet-action-row">
          <button class="secondary" data-sheet-action="refresh">Refresh snapshot</button>
          <button class="secondary" data-sheet-action="new-session">New session</button>
          <button class="secondary" data-sheet-action="compact">Compact session</button>
          <button class="secondary" data-sheet-action="stats">Refresh stats</button>
        </div>
        <div class="sheet-action-row">
          <button class="secondary" data-sheet-action="models">Open model picker</button>
          <button class="secondary" data-sheet-action="thinking">Open thinking picker</button>
          <button class="secondary" data-sheet-action="commands">Browse commands</button>
          <button class="secondary" data-sheet-action="sessions">Browse sessions</button>
          <button class="secondary" data-sheet-action="tree">Browse tree</button>
        </div>
      </div>
    </section>
    <section class="sheet-section">
      <h3>Session stats</h3>
      ${renderStatsSection()}
    </section>
  `;
}

function renderThinkingSheet() {
  return `
    <section class="sheet-section">
      <h3>Thinking levels</h3>
      <div class="sheet-list">
        ${THINKING_LEVELS.map((level) => `
          <button class="secondary" data-thinking-level="${escapeHtml(level)}">
            ${escapeHtml(level)}${state.snapshotState?.thinkingLevel === level ? ' · current' : ''}
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderModelsSheet() {
  return `
    <section class="sheet-section">
      <h3>Models</h3>
      <div class="model-list">
        ${state.models.length
          ? state.models.map((model) => `
            <button class="secondary" data-model-provider="${escapeHtml(model.provider)}" data-model-id="${escapeHtml(model.id)}">
              <div><strong>${escapeHtml(model.name || model.id)}</strong></div>
              <div class="label">${escapeHtml(`${model.provider}/${model.id}`)}${state.snapshotState?.model?.id === model.id && state.snapshotState?.model?.provider === model.provider ? ' · current' : ''}</div>
            </button>
          `).join('')
          : '<div class="label">Loading available models…</div>'}
      </div>
    </section>
  `;
}

function renderCommandsSheet() {
  const groups = groupedCommands();
  const categories = sortCommandCategories([...new Set([...COMMAND_CATEGORY_ORDER, ...groups.keys()])]);
  const activeCategory = selectedCommandCategory(categories);
  const commands = groups.get(activeCategory) || [];
  const emptyLabel = activeCategory ? `${commandCategoryLabel(activeCategory).toLowerCase()} commands` : 'commands';

  return `
    <section class="sheet-section">
      <h3>Commands, skills, prompts</h3>
      <label class="sheet-filter">
        <span class="label">Category</span>
        <select class="sheet-select" data-command-category-select aria-label="Command category">
          ${categories.map((category) => `
            <option value="${escapeHtml(category)}" ${category === activeCategory ? 'selected' : ''}>${escapeHtml(commandCategoryLabel(category))}</option>
          `).join('')}
        </select>
      </label>
      <div class="sheet-list">
        ${commands.length ? commands.map((command) => `
          <button
            class="secondary"
            ${command.source === 'local'
              ? `data-run-local-command="${escapeHtml(command.name)}"`
              : `data-run-command="/${escapeHtml(command.name)}"`}
          >
            <div><strong>${escapeHtml(`/${command.name}`)}</strong></div>
            <div class="label">${escapeHtml(command.description || 'No description')}</div>
          </button>
        `).join('') : `<div class="label">No ${escapeHtml(emptyLabel)} available.</div>`}
      </div>
    </section>
  `;
}

function renderSessionsSheet() {
  return `
    <section class="sheet-section">
      <h3>Sessions for this project</h3>
      <div class="sheet-list">
        ${state.sessions.length ? state.sessions.map((session) => `
          <button class="secondary" data-session-path="${escapeHtml(session.path)}">
            <div><strong>${escapeHtml(session.name || session.firstMessage || session.id)}</strong></div>
            <div class="label">${escapeHtml(formatDateTime(session.modified))} · ${escapeHtml(String(session.messageCount))} messages</div>
            <div class="label mono">${escapeHtml(session.path)}</div>
          </button>
        `).join('') : '<div class="label">No sessions found yet for this cwd.</div>'}
      </div>
    </section>
  `;
}

function sortedActiveSessions() {
  return [...state.activeSessions].sort((left, right) => {
    const leftCurrent = left.id === state.activeSessionId ? 1 : 0;
    const rightCurrent = right.id === state.activeSessionId ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;

    const leftLive = left.isStreaming ? 1 : 0;
    const rightLive = right.isStreaming ? 1 : 0;
    if (leftLive !== rightLive) return rightLive - leftLive;

    const leftLabel = left.label || left.sessionId || left.id;
    const rightLabel = right.label || right.sessionId || right.id;
    return leftLabel.localeCompare(rightLabel);
  });
}

function renderActiveSessionsSheet() {
  const sessions = sortedActiveSessions();

  return `
    <section class="sheet-section">
      <h3>Active sessions</h3>
      <div class="button-row compact">
        <button class="secondary" data-sheet-action="spawn-active-session">New active session</button>
        <button class="secondary" data-sheet-action="sessions">Saved sessions</button>
      </div>
      <div class="sheet-list">
        ${sessions.length ? sessions.map((session) => {
          const statusBits = [
            session.id === state.activeSessionId ? 'current' : '',
            session.isStreaming ? 'live' : '',
            session.hasPendingUiRequest ? 'needs input' : '',
            session.model?.name || '',
            Number.isFinite(session.messageCount) ? `${session.messageCount} messages` : '',
            session.secondaryLabel || '',
          ].filter(Boolean).join(' · ');

          const preview = session.lastUserPreview || session.firstUserPreview || '';

          return `
            <button class="secondary" data-active-session-id="${escapeHtml(session.id)}">
              <div><strong>${escapeHtml(session.label || 'Session')}</strong></div>
              ${statusBits ? `<div class="label">${escapeHtml(statusBits)}</div>` : ''}
              ${preview ? `<div class="label">${escapeHtml(preview)}</div>` : ''}
            </button>
          `;
        }).join('') : '<div class="label">No active sessions yet. Start one with “New active session”.</div>'}
      </div>
    </section>
  `;
}

function renderTreeSheet() {
  if (!state.tree) {
    return `
      <section class="sheet-section">
        <h3>Session tree</h3>
        <div class="label">Loading tree…</div>
      </section>
    `;
  }

  return `
    <section class="sheet-section">
      <h3>Session tree</h3>
      <div class="label mono">${escapeHtml(state.tree.sessionFile || '')}</div>
      <div class="sheet-list">
        ${state.tree.nodes.map((node) => {
          const isCurrent = state.tree.currentLeafId === node.id;
          const onPath = state.tree.currentPathIds.includes(node.id);
          return `
            <div class="sheet-section" style="margin-left:${Math.min(node.depth * 12, 72)}px">
              <div><strong>${escapeHtml(node.summary.kind)}</strong>${node.summary.role ? ` <span class="label">${escapeHtml(node.summary.role)}</span>` : ''}${node.label ? ` <span class="label">#${escapeHtml(node.label)}</span>` : ''}${isCurrent ? ' <span class="label">current</span>' : onPath ? ' <span class="label">path</span>' : ''}</div>
              <div class="label">${escapeHtml(formatDateTime(node.timestamp))}</div>
              <div>${escapeHtml(node.summary.preview || '(empty)')}</div>
              <div class="button-row compact">
                <button class="secondary" data-open-branch-entry="${escapeHtml(node.id)}">Open path</button>
                ${node.summary.role === 'user' ? `<button class="secondary" data-fork-entry="${escapeHtml(node.id)}">Fork here</button>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderSheet() {
  if (el.sheetModal.classList.contains('hidden')) return;

  const titles = {
    actions: 'Actions',
    commands: 'Commands',
    models: 'Models',
    thinking: 'Thinking',
    sessions: 'Sessions',
    'active-sessions': 'Active sessions',
    tree: 'Tree',
  };
  const nextTitle = titles[state.sheetMode] || 'Actions';
  if (el.sheetTitle.textContent !== nextTitle) {
    el.sheetTitle.textContent = nextTitle;
  }

  const sections = {
    actions: renderActionsSheet() + renderThinkingSheet() + renderModelsSheet(),
    commands: renderCommandsSheet(),
    models: renderModelsSheet() + renderThinkingSheet(),
    thinking: renderThinkingSheet() + renderModelsSheet(),
    sessions: renderSessionsSheet(),
    'active-sessions': renderActiveSessionsSheet(),
    tree: renderTreeSheet(),
  };

  const nextHtml = sections[state.sheetMode] || sections.actions;
  if (el.sheetContent.innerHTML !== nextHtml) {
    el.sheetContent.innerHTML = nextHtml;
  }
}

function handleRpcPayload(payload) {
  if (!payload) return;

  if (payload.type === 'response') {
    if (!payload.success) {
      if (payload.command === 'path_suggestions') {
        renderAutocompleteItems([]);
        return;
      }
      showToast(payload.error || `Command failed: ${payload.command}`, 'error');
      return;
    }

    if (payload.command === 'get_state') {
      state.snapshotState = payload.data || state.snapshotState;
      renderHeader();
      void refreshQuota();
      return;
    }

    if (payload.command === 'get_messages') {
      state.messages = (payload.data?.messages || []).flatMap(transformMessage);
      clearTransientState();
      renderMessages();
      return;
    }

    if (payload.command === 'get_commands') {
      state.commands = payload.data?.commands || [];
      renderCommandSuggestions();
      renderSheet();
      return;
    }

    if (payload.command === 'path_suggestions') {
      const context = state.autocompleteContext;
      if (!context || context.type !== 'path') return;
      if (Number(payload.data?.requestId) !== state.autocompleteRemoteRequestId) return;
      if (payload.data?.mode !== context.mode) return;
      if ((payload.data?.query || '') !== context.query) return;

      const suggestions = Array.isArray(payload.data?.suggestions) ? payload.data.suggestions : [];
      renderAutocompleteItems(suggestions.map((suggestion) => ({
        kind: 'path',
        label: context.mode === 'mention'
          ? `@${suggestion.value}`
          : suggestion.value,
        badge: suggestion.kind === 'previous' ? 'recent' : suggestion.isDirectory ? 'dir' : 'file',
        description: suggestion.description || suggestion.value,
        value: suggestion.value,
        isDirectory: Boolean(suggestion.isDirectory),
        title: suggestion.description || suggestion.value,
      })));
      return;
    }

    if (payload.command === 'cd') {
      showToast(`Changed directory to ${payload.data?.cwd || 'the selected path'}.`);
      refreshAll();
      return;
    }

    if (payload.command === 'get_available_models') {
      state.models = payload.data?.models || [];
      renderSheet();
      return;
    }

    if (payload.command === 'get_session_stats') {
      state.stats = payload.data || null;
      renderSheet();
      return;
    }

    if (payload.command === 'phone_list_sessions') {
      state.sessions = payload.data?.sessions || [];
      renderSheet();
      return;
    }

    if (payload.command === 'phone_get_tree') {
      state.tree = payload.data || null;
      renderSheet();
      return;
    }

    if (payload.command === 'new_session') {
      clearTransientState();
      refreshAll();
      showToast('Started a new Pi session.');
      return;
    }

    if (payload.command === 'compact') {
      showToast('Compaction completed.');
      refreshAll();
      return;
    }

    if (payload.command === 'slash_command') {
      if (payload.data?.source === 'extension') {
        refreshAll({ forceQuota: true });
      }
      return;
    }

    if (payload.command === 'reload') {
      clearTransientState();
      showToast('Reloaded extensions, skills, prompts, and themes.');
      refreshAll({ forceQuota: true });
      return;
    }

    if (payload.command === 'set_model') {
      showToast('Model updated.');
      refreshAll();
      return;
    }

    if (payload.command === 'set_thinking_level') {
      showToast('Thinking level updated.');
      refreshAll();
      return;
    }

    if (payload.command === 'switch_session') {
      showToast('Session switched.');
      refreshAll();
      closeSheet();
      return;
    }

    if (payload.command === 'fork') {
      showToast('Fork created.');
      refreshAll();
      closeSheet();
      return;
    }

    if (payload.command === 'phone_open_branch_path') {
      showToast('Opened selected branch path as a new session.');
      refreshAll();
      closeSheet();
      return;
    }

    return;
  }

  if (payload.type === 'agent_start') {
    state.status = { ...(state.status || {}), isStreaming: true };
    renderHeader();
    return;
  }

  if (payload.type === 'agent_end') {
    state.status = { ...(state.status || {}), isStreaming: false };
    renderHeader();
    refreshAll({ forceQuota: true });
    return;
  }

  if (payload.type === 'message_update') {
    handleAssistantEvent(payload.assistantMessageEvent);
    return;
  }

  if (payload.type === 'message_end' && payload.message?.role === 'assistant') {
    const transformed = transformMessage(payload.message, Date.now())[0];
    if (transformed) {
      state.liveAssistant = { ...transformed, live: false };
      renderMessages();
    }
    return;
  }

  if (payload.type === 'tool_execution_start') {
    upsertLiveTool(payload.toolCallId, {
      id: `tool-live-${payload.toolCallId}`,
      kind: 'tool',
      toolCallId: payload.toolCallId,
      toolName: payload.toolName || 'tool',
      args: payload.args || {},
      command: payload.args?.command || '',
      live: true,
      title: payload.toolName || 'tool',
      text: JSON.stringify(payload.args || {}, null, 2),
      meta: 'Running…',
      status: 'running',
      rawContent: null,
    });
    return;
  }

  if (payload.type === 'tool_execution_update') {
    upsertLiveTool(payload.toolCallId, {
      ...(state.liveTools.get(payload.toolCallId) || {}),
      id: `tool-live-${payload.toolCallId}`,
      kind: 'tool',
      toolCallId: payload.toolCallId,
      toolName: payload.toolName || 'tool',
      args: payload.args || state.liveTools.get(payload.toolCallId)?.args || {},
      command: payload.args?.command || state.liveTools.get(payload.toolCallId)?.command || '',
      live: true,
      title: payload.toolName || 'tool',
      text: contentToText(payload.partialResult?.content) || JSON.stringify(payload.args || {}, null, 2),
      meta: 'Running…',
      status: 'running',
      details: payload.partialResult?.details,
      rawContent: payload.partialResult?.content || state.liveTools.get(payload.toolCallId)?.rawContent || null,
    });
    return;
  }

  if (payload.type === 'tool_execution_end') {
    upsertLiveTool(payload.toolCallId, {
      ...(state.liveTools.get(payload.toolCallId) || {}),
      id: `tool-live-${payload.toolCallId}`,
      kind: 'tool',
      toolCallId: payload.toolCallId,
      toolName: payload.toolName || 'tool',
      args: payload.args || state.liveTools.get(payload.toolCallId)?.args || {},
      command: payload.args?.command || state.liveTools.get(payload.toolCallId)?.command || '',
      live: false,
      title: payload.toolName || 'tool',
      text: contentToText(payload.result?.content),
      meta: payload.isError ? 'Failed' : 'Done',
      status: payload.isError ? 'error' : 'done',
      details: payload.result?.details,
      rawContent: payload.result?.content || state.liveTools.get(payload.toolCallId)?.rawContent || null,
    });
    return;
  }

  if (payload.type === 'extension_ui_request') {
    handleExtensionUiRequest(payload);
    return;
  }

  if (payload.type === 'auto_retry_start') {
    showBanner(`Retrying after error: ${payload.errorMessage || 'temporary failure'}`);
    return;
  }

  if (payload.type === 'auto_retry_end') {
    showBanner(payload.success ? '' : `Retry failed: ${payload.finalError || 'Unknown error'}`, payload.success ? 'info' : 'error');
  }
}

function handleEnvelope(event) {
  if (event.channel === 'sessions' && event.event === 'catalog') {
    const nextActiveSessionId = event.data?.activeSessionId || state.activeSessionId;
    const activeSessionChanged = nextActiveSessionId !== state.activeSessionId;

    state.activeSessions = event.data?.sessions || [];
    state.activeSessionId = nextActiveSessionId;

    if (activeSessionChanged && state.snapshotWorkerId && state.snapshotWorkerId !== state.activeSessionId) {
      clearSnapshotView();
      renderMessages();
    }

    renderHeader();
    renderSheet();
    return;
  }

  if (event.channel === 'snapshot') {
    if (event.sessionWorkerId && state.activeSessionId && event.sessionWorkerId !== state.activeSessionId) {
      return;
    }

    state.snapshotState = event.state || null;
    state.snapshotWorkerId = event.sessionWorkerId || state.activeSessionId || null;
    state.status = { ...(state.status || {}), isStreaming: Boolean(event.state?.isStreaming) };
    state.messages = (event.messages || []).flatMap(transformMessage);
    state.commands = event.commands || state.commands;
    clearTransientState();

    if (event.liveAssistantMessage?.role === 'assistant') {
      const assistant = transformMessage(event.liveAssistantMessage, Date.now())[0];
      if (assistant) {
        state.liveAssistant = { ...assistant, id: 'assistant-live', live: true };
      }
    }

    for (const tool of event.liveTools || []) {
      const text =
        contentToText(tool.result?.content) ||
        contentToText(tool.partialResult?.content) ||
        JSON.stringify(tool.args || {}, null, 2);

      state.liveTools.set(tool.toolCallId, {
        id: `tool-live-${tool.toolCallId}`,
        kind: 'tool',
        toolCallId: tool.toolCallId,
        toolName: tool.toolName || 'tool',
        args: tool.args || {},
        command: tool.args?.command || '',
        live: !tool.result,
        title: tool.toolName || 'tool',
        text,
        meta: tool.result ? (tool.isError ? 'Failed' : 'Done') : 'Running…',
        details: tool.result?.details || tool.partialResult?.details,
        status: tool.isError ? 'error' : (tool.result ? 'done' : 'running'),
        rawContent: tool.result?.content || tool.partialResult?.content || null,
      });
    }

    renderHeader();
    renderMessages();
    renderSheet();
    renderCommandSuggestions();
    void refreshQuota();
    return;
  }

  if (event.channel === 'server') {
    if (event.event === 'status') {
      state.status = event.data;
      renderHeader();
      return;
    }
    if (event.event === 'stderr') {
      showBanner(event.data?.text?.trim() || '', 'error');
      return;
    }
    if (event.event === 'reloading') {
      showBanner(event.data?.message || '');
      return;
    }
    if (event.event === 'session-spawned') {
      showToast(event.data?.message || 'Opened new active session.');
      return;
    }
    if (event.event === 'single-client-replaced') {
      showBanner(event.data?.message || 'This phone session was replaced by another client.', 'error');
      return;
    }
    if (event.event === 'idle-timeout') {
      showBanner(event.data?.message || 'Pi Phone stopped because it was idle.', 'error');
      return;
    }
    if (['startup-error', 'snapshot-error', 'client-error'].includes(event.event)) {
      showToast(event.data?.message || 'Server error', 'error');
      return;
    }
    if (event.event === 'agent-exit') {
      showBanner(event.data?.message || 'Pi rpc exited.', 'error');
      return;
    }
  }

  if (event.channel === 'rpc') {
    handleRpcPayload(event.payload);
  }
}

function connectSocket() {
  clearReconnectTimer();
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  if (state.token) url.searchParams.set('token', state.token);

  const socket = new WebSocket(url);
  state.socket = socket;
  renderHeader();

  socket.addEventListener('open', () => {
    clearReconnectTimer();
    showBanner('');
    renderHeader();
    refreshAll();
  });

  socket.addEventListener('message', (event) => {
    try {
      handleEnvelope(JSON.parse(event.data));
    } catch {
      showToast('Received malformed data from server.', 'error');
    }
  });

  socket.addEventListener('close', (event) => {
    if (state.socket === socket) {
      state.socket = null;
    }
    renderHeader();
    if (event.code === 4009) {
      showBanner('This Pi Phone instance was opened from another device or tab.', 'error');
      return;
    }
    if (event.code === 4010) {
      showBanner('Pi Phone stopped due to inactivity. Run /phone-start again when needed.', 'error');
      return;
    }
    if (event.code === 1008) {
      handleAuthFailure();
      return;
    }
    if (event.code === 1006) {
      showBanner('Connection lost. Retrying…', 'error');
    }
    if (!state.manuallyClosed) {
      clearReconnectTimer();
      state.reconnectTimer = setTimeout(connectSocket, 1800);
    }
  });

  socket.addEventListener('error', () => {
    renderHeader();
  });
}

async function loadHealth() {
  const response = await fetch('/api/health', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Health check failed (${response.status})`);
  state.health = await response.json();
  state.status = state.health;
  renderHeader();
}

async function boot() {
  try {
    await loadHealth();
  } catch (error) {
    showBanner(error instanceof Error ? error.message : 'Failed to reach server.', 'error');
    return;
  }

  if (state.health?.hasToken && !state.token) openTokenModal();
  else connectSocket();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function tryHandleLocalCommand(text, { hasAttachments = false } = {}) {
  if (!text.startsWith('/')) return false;
  const parsed = parseLocalCommandInput(text);
  if (!parsed?.name) return false;
  const { name, args } = parsed;

  if (hasAttachments && LOCAL_COMMAND_NAMES.has(name)) {
    showToast('Local phone commands do not support image attachments.', 'error');
    return 'blocked';
  }

  if (name === 'new') {
    sendRpc({ type: 'new_session' });
    return 'handled';
  }
  if (name === 'compact') {
    sendRpc({ type: 'compact' });
    return 'handled';
  }
  if (name === 'reload') {
    return requestReload() ? 'handled' : 'blocked';
  }
  if (name === 'refresh') {
    refreshAll();
    return 'handled';
  }
  if (name === 'stats' || name === 'cost') {
    openSheet('actions');
    sendRpc({ type: 'get_session_stats' });
    return 'handled';
  }
  if (name === 'commands') {
    openSheet('commands');
    return 'handled';
  }
  if (name === 'sessions') {
    openSheet('sessions');
    return 'handled';
  }
  if (name === 'tree') {
    openSheet('tree');
    return 'handled';
  }
  if (name === 'cd') {
    return sendCdCommand(args) ? 'handled' : 'blocked';
  }
  if (name === 'thinking') {
    if (args && THINKING_LEVELS.includes(args)) {
      sendRpc({ type: 'set_thinking_level', level: args });
    } else {
      openSheet('thinking');
    }
    return 'handled';
  }
  if (name === 'model') {
    if (args) {
      const [provider, modelId] = args.includes('/') ? args.split('/', 2) : [null, args];
      const match = state.models.find((model) => (provider ? model.provider === provider && model.id === modelId : model.id === modelId || model.name === modelId));
      if (match) {
        sendRpc({ type: 'set_model', provider: match.provider, modelId: match.id });
      } else {
        openSheet('models');
        sendRpc({ type: 'get_available_models' });
        showToast('Model not found locally. Pick one from the sheet.', 'error');
      }
    } else {
      openSheet('models');
      sendRpc({ type: 'get_available_models' });
    }
    return 'handled';
  }
  return false;
}

async function submitPrompt({ steer = false } = {}) {
  const message = el.promptInput.value.trim();
  if (!message && state.attachments.length === 0) return;

  const localCommandResult = !steer && message
    ? tryHandleLocalCommand(message, { hasAttachments: state.attachments.length > 0 })
    : false;

  if (localCommandResult) {
    if (localCommandResult === 'handled') {
      el.promptInput.value = '';
      autoResizeTextarea();
      renderCommandSuggestions();
    }
    return;
  }

  let images = [];
  if (state.attachments.length) {
    try {
      images = await buildPromptImages();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to read images', 'error');
      return;
    }
  }

  const remoteSlashCommand = message ? findRemoteSlashCommand(message) : null;
  if (remoteSlashCommand) {
    const remoteCommandResult = sendRemoteSlashCommand(remoteSlashCommand, { images, steer });
    if (remoteCommandResult) {
      if (remoteCommandResult === 'handled') {
        el.promptInput.value = '';
        autoResizeTextarea();
        renderCommandSuggestions();
        clearAttachments();
      }
      return;
    }
  }

  const streaming = Boolean(state.status?.isStreaming || state.snapshotState?.isStreaming);
  sendRpc({
    type: 'prompt',
    message,
    ...(steer ? { streamingBehavior: 'steer' } : streaming ? { streamingBehavior: 'followUp' } : {}),
    ...(images.length ? { images } : {}),
  });

  state.messages.push({
    id: `local-user-${Date.now()}`,
    kind: 'user',
    meta: 'just now',
    text: message || '(image prompt)',
    imageCount: images.length,
  });
  renderMessages();
  el.promptInput.value = '';
  autoResizeTextarea();
  renderCommandSuggestions();
  clearAttachments();
}

function sheetButtonActionKey(button) {
  return [
    button.getAttribute('data-sheet-action') || '',
    button.getAttribute('data-active-session-id') || '',
    button.getAttribute('data-session-path') || '',
    button.getAttribute('data-open-branch-entry') || '',
    button.getAttribute('data-fork-entry') || '',
    button.getAttribute('data-run-command') || '',
    button.getAttribute('data-run-local-command') || '',
  ].join('|');
}

function handleSheetButtonAction(button) {
  const action = button.getAttribute('data-sheet-action');
  if (action === 'refresh') return refreshAll(), true;
  if (action === 'new-session') return sendRpc({ type: 'new_session' }), true;
  if (action === 'compact') return sendRpc({ type: 'compact' }), true;
  if (action === 'stats') return sendRpc({ type: 'get_session_stats' }), true;
  if (action === 'models') return openSheet('models'), true;
  if (action === 'thinking') return openSheet('thinking'), true;
  if (action === 'commands') return openSheet('commands'), true;
  if (action === 'sessions') return openSheet('sessions'), true;
  if (action === 'spawn-active-session') {
    if (state.socket?.readyState !== WebSocket.OPEN) return showToast('Not connected to Pi.', 'error'), true;
    clearSnapshotView();
    renderHeader();
    renderMessages();
    showToast('Opening new active session…');
    state.socket.send(JSON.stringify({ kind: 'session-spawn' }));
    closeSheet();
    return true;
  }
  if (action === 'tree') return openSheet('tree'), true;

  const thinkingLevel = button.getAttribute('data-thinking-level');
  if (thinkingLevel) return sendRpc({ type: 'set_thinking_level', level: thinkingLevel }), true;

  const modelProvider = button.getAttribute('data-model-provider');
  const modelId = button.getAttribute('data-model-id');
  if (modelProvider && modelId) return sendRpc({ type: 'set_model', provider: modelProvider, modelId }), true;

  const runLocalCommand = button.getAttribute('data-run-local-command');
  if (runLocalCommand) {
    const definition = findLocalCommandDefinition(runLocalCommand);
    if (definition?.insertOnly) {
      if (runLocalCommand === 'cd') insertCdCommand();
      else {
        el.promptInput.value = `/${runLocalCommand} `;
        autoResizeTextarea();
        renderCommandSuggestions();
        el.promptInput.focus();
      }
      closeSheet();
      return true;
    }

    const result = tryHandleLocalCommand(`/${runLocalCommand}`, { hasAttachments: state.attachments.length > 0 });
    if (result === 'handled') {
      el.promptInput.value = '';
      autoResizeTextarea();
      renderCommandSuggestions();
    }
    return true;
  }

  const runCommand = button.getAttribute('data-run-command');
  if (runCommand) {
    el.promptInput.value = `${runCommand} `;
    autoResizeTextarea();
    renderCommandSuggestions();
    closeSheet();
    el.promptInput.focus();
    return true;
  }

  const activeSessionId = button.getAttribute('data-active-session-id');
  if (activeSessionId) {
    if (state.socket?.readyState !== WebSocket.OPEN) return showToast('Not connected to Pi.', 'error'), true;
    clearSnapshotView();
    renderHeader();
    renderMessages();
    state.socket.send(JSON.stringify({ kind: 'session-select', sessionId: activeSessionId }));
    closeSheet();
    return true;
  }

  const sessionPath = button.getAttribute('data-session-path');
  if (sessionPath) return sendRpc({ type: 'switch_session', sessionPath }), true;

  const openBranchEntry = button.getAttribute('data-open-branch-entry');
  if (openBranchEntry) return sendRpc({ type: 'phone_open_branch_path', entryId: openBranchEntry }), true;

  const forkEntry = button.getAttribute('data-fork-entry');
  if (forkEntry) return sendRpc({ type: 'fork', entryId: forkEntry }), true;

  return false;
}

el.promptInput.addEventListener('input', () => {
  autoResizeTextarea();
  renderCommandSuggestions();
});

el.promptInput.addEventListener('click', () => {
  renderCommandSuggestions();
});

el.promptInput.addEventListener('keyup', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
    renderCommandSuggestions();
  }
});

autoResizeTextarea();
renderCommandSuggestions();
renderAttachmentStrip();

el.refreshButton.addEventListener('click', refreshAll);
el.abortButton.addEventListener('click', () => sendRpc({ type: 'abort' }));
el.stopButton?.addEventListener('click', () => sendRpc({ type: 'abort' }));
el.actionsButton.addEventListener('click', () => openSheet('actions'));
el.insertCommandButton.addEventListener('click', () => openSheet('commands'));
el.cdCommandButton?.addEventListener('click', insertCdCommand);
el.sessionBrowserButton.addEventListener('click', () => openSheet('sessions'));
el.sessionSidebarButton.addEventListener('click', () => openSheet('active-sessions'));
el.treeBrowserButton.addEventListener('click', () => openSheet('tree'));
el.steerButton.addEventListener('click', () => submitPrompt({ steer: true }));
el.sendButton.addEventListener('click', () => submitPrompt());
el.sheetCloseButton.addEventListener('click', closeSheet);
el.attachImageButton.addEventListener('click', () => el.imageInput.click());
el.imageInput.addEventListener('change', (event) => {
  addAttachments(event.target.files);
  el.imageInput.value = '';
});

el.attachmentStrip.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-attachment]');
  if (!button) return;
  removeAttachment(button.getAttribute('data-remove-attachment'));
});

el.promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});

el.commandStrip.addEventListener('click', (event) => {
  const button = event.target.closest('[data-autocomplete-index]');
  if (!button) return;

  const index = Number(button.getAttribute('data-autocomplete-index'));
  if (!Number.isFinite(index) || index < 0) return;
  applyAutocompleteItem(state.autocompleteItems[index]);
});

el.sheetContent.addEventListener('change', (event) => {
  if (!(event.target instanceof HTMLSelectElement)) return;
  if (!event.target.hasAttribute('data-command-category-select')) return;
  state.commandSheetCategory = event.target.value;
  renderSheet();
});

el.sheetContent.addEventListener('pointerdown', (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  const shouldHandleEarly = button.hasAttribute('data-active-session-id') || button.getAttribute('data-sheet-action') === 'spawn-active-session';
  if (!shouldHandleEarly) return;

  event.preventDefault();
  const actionKey = sheetButtonActionKey(button);
  state.lastSheetPointerAction = actionKey;
  state.lastSheetPointerActionAt = Date.now();
  handleSheetButtonAction(button);
});

el.sheetContent.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  const actionKey = sheetButtonActionKey(button);
  if (state.lastSheetPointerAction === actionKey && Date.now() - state.lastSheetPointerActionAt < 800) {
    state.lastSheetPointerAction = '';
    state.lastSheetPointerActionAt = 0;
    return;
  }

  handleSheetButtonAction(button);
});

el.tokenSaveButton.addEventListener('click', () => {
  const nextToken = el.tokenInput.value.trim();
  if (!nextToken) {
    showToast('Enter the current /phone-start token.', 'error');
    el.tokenInput.focus();
    return;
  }

  state.token = nextToken;
  storeToken(state.token);
  closeTokenModal();
  connectSocket();
});

el.tokenInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    el.tokenSaveButton.click();
  }
});

document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement)) return;
  const itemId = details.getAttribute('data-tool-panel');
  if (!itemId) return;
  state.toolPanelOpen.set(itemId, details.open);
}, true);

window.addEventListener('beforeunload', () => {
  state.manuallyClosed = true;
  if (state.socket) state.socket.close();
  clearAttachments();
});

boot();
