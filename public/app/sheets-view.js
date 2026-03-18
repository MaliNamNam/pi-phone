import { THINKING_LEVELS } from "./constants.js";
import { commandCategoryLabel, groupedCommands, selectedCommandCategory, sortCommandCategories } from "./command-catalog.js";
import { escapeHtml, formatDateTime } from "./formatters.js";
import { el, state } from "./state.js";

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
      <div class="stat-chip"><span>Cost</span><strong>${escapeHtml(state.stats.cost != null ? `$${Number(state.stats.cost).toFixed(4)}` : "—")}</strong></div>
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
            ${escapeHtml(level)}${state.snapshotState?.thinkingLevel === level ? " · current" : ""}
          </button>
        `).join("")}
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
              <div class="label">${escapeHtml(`${model.provider}/${model.id}`)}${state.snapshotState?.model?.id === model.id && state.snapshotState?.model?.provider === model.provider ? " · current" : ""}</div>
            </button>
          `).join("")
          : '<div class="label">Loading available models…</div>'}
      </div>
    </section>
  `;
}

function renderCommandsSheet() {
  const groups = groupedCommands();
  const categories = sortCommandCategories([...new Set([...groups.keys()])]);
  const activeCategory = selectedCommandCategory(categories);
  const commands = groups.get(activeCategory) || [];
  const emptyLabel = activeCategory ? `${commandCategoryLabel(activeCategory).toLowerCase()} commands` : "commands";

  return `
    <section class="sheet-section">
      <h3>Commands, skills, prompts</h3>
      <label class="sheet-filter">
        <span class="label">Category</span>
        <select class="sheet-select" data-command-category-select aria-label="Command category">
          ${categories.map((category) => `
            <option value="${escapeHtml(category)}" ${category === activeCategory ? "selected" : ""}>${escapeHtml(commandCategoryLabel(category))}</option>
          `).join("")}
        </select>
      </label>
      <div class="sheet-list">
        ${commands.length ? commands.map((command) => `
          <button
            class="secondary"
            ${command.source === "local"
              ? `data-run-local-command="${escapeHtml(command.name)}"`
              : `data-run-command="/${escapeHtml(command.name)}"`}
          >
            <div><strong>${escapeHtml(`/${command.name}`)}</strong></div>
            <div class="label">${escapeHtml(command.description || "No description")}</div>
          </button>
        `).join("") : `<div class="label">No ${escapeHtml(emptyLabel)} available.</div>`}
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
        `).join("") : '<div class="label">No sessions found yet for this cwd.</div>'}
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
            session.id === state.activeSessionId ? "current" : "",
            session.isStreaming ? "live" : "",
            session.hasPendingUiRequest ? "needs input" : "",
            session.model?.name || "",
            Number.isFinite(session.messageCount) ? `${session.messageCount} messages` : "",
            session.secondaryLabel || "",
          ].filter(Boolean).join(" · ");

          const preview = session.lastUserPreview || session.firstUserPreview || "";

          return `
            <button class="secondary" data-active-session-id="${escapeHtml(session.id)}">
              <div><strong>${escapeHtml(session.label || "Session")}</strong></div>
              ${statusBits ? `<div class="label">${escapeHtml(statusBits)}</div>` : ""}
              ${preview ? `<div class="label">${escapeHtml(preview)}</div>` : ""}
            </button>
          `;
        }).join("") : '<div class="label">No active sessions yet. Start one with “New active session”.</div>'}
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
      <div class="label mono">${escapeHtml(state.tree.sessionFile || "")}</div>
      <div class="sheet-list">
        ${state.tree.nodes.map((node) => {
          const isCurrent = state.tree.currentLeafId === node.id;
          const onPath = state.tree.currentPathIds.includes(node.id);
          return `
            <div class="sheet-section" style="margin-left:${Math.min(node.depth * 12, 72)}px">
              <div><strong>${escapeHtml(node.summary.kind)}</strong>${node.summary.role ? ` <span class="label">${escapeHtml(node.summary.role)}</span>` : ""}${node.label ? ` <span class="label">#${escapeHtml(node.label)}</span>` : ""}${isCurrent ? ' <span class="label">current</span>' : onPath ? ' <span class="label">path</span>' : ''}</div>
              <div class="label">${escapeHtml(formatDateTime(node.timestamp))}</div>
              <div>${escapeHtml(node.summary.preview || "(empty)")}</div>
              <div class="button-row compact">
                <button class="secondary" data-open-branch-entry="${escapeHtml(node.id)}">Open path</button>
                ${node.summary.role === "user" ? `<button class="secondary" data-fork-entry="${escapeHtml(node.id)}">Fork here</button>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

export function renderSheet() {
  if (el.sheetModal.classList.contains("hidden")) return;

  const titles = {
    actions: "Actions",
    commands: "Commands",
    models: "Models",
    thinking: "Thinking",
    sessions: "Sessions",
    "active-sessions": "Active sessions",
    tree: "Tree",
  };
  const nextTitle = titles[state.sheetMode] || "Actions";
  if (el.sheetTitle.textContent !== nextTitle) {
    el.sheetTitle.textContent = nextTitle;
  }

  const sections = {
    actions: renderActionsSheet() + renderThinkingSheet() + renderModelsSheet(),
    commands: renderCommandsSheet(),
    models: renderModelsSheet() + renderThinkingSheet(),
    thinking: renderThinkingSheet() + renderModelsSheet(),
    sessions: renderSessionsSheet(),
    "active-sessions": renderActiveSessionsSheet(),
    tree: renderTreeSheet(),
  };

  const nextHtml = sections[state.sheetMode] || sections.actions;
  if (el.sheetContent.innerHTML !== nextHtml) {
    el.sheetContent.innerHTML = nextHtml;
  }
}
