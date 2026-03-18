import { AUTOCOMPLETE_DELIMITERS } from "./constants.js";
import { el, state } from "./state.js";
import { escapeAttribute, escapeHtml } from "./formatters.js";
import { autoResizeTextarea, scheduleComposerLayoutSync } from "./ui.js";

export function clearAutocompleteSuggestions() {
  if (state.autocompleteRemoteTimer) {
    clearTimeout(state.autocompleteRemoteTimer);
    state.autocompleteRemoteTimer = null;
  }
  state.autocompleteContext = null;
  state.autocompleteItems = [];
  el.commandStrip.classList.add("hidden");
  el.commandStrip.innerHTML = "";
  scheduleComposerLayoutSync();
}

export function renderAutocompleteItems(items = []) {
  state.autocompleteItems = items;

  if (!items.length) {
    el.commandStrip.classList.add("hidden");
    el.commandStrip.innerHTML = "";
    scheduleComposerLayoutSync();
    return;
  }

  el.commandStrip.innerHTML = items.map((item, index) => `
    <button class="command-chip secondary" data-autocomplete-index="${index}" title="${escapeAttribute(item.title || item.description || item.label || "")}">
      <span>${escapeHtml(item.label || "")}</span>
      <span class="source">${escapeHtml(item.badge || "")}</span>
    </button>
  `).join("");
  el.commandStrip.classList.remove("hidden");
  scheduleComposerLayoutSync();
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

export function detectMentionAutocompleteContext(text, cursor) {
  const scanLimit = Math.min(cursor, text.length);
  let tokenStart = scanLimit;
  while (tokenStart > 0 && !AUTOCOMPLETE_DELIMITERS.has(text[tokenStart - 1])) {
    tokenStart -= 1;
  }

  if (text[tokenStart] !== "@") return null;
  if (!delimiterBeforeIndex(text, tokenStart)) return null;

  const bounds = findTokenBounds(text, tokenStart, cursor);
  return {
    type: "path",
    mode: "mention",
    query: text.slice(tokenStart + 1, cursor),
    replaceStart: bounds.start,
    replaceEnd: bounds.end,
  };
}

export function detectCdAutocompleteContext(text, cursor) {
  const leadingWhitespace = text.match(/^\s*/)?.[0] || "";
  const trimmed = text.slice(leadingWhitespace.length);
  if (!trimmed.startsWith("/cd")) return null;

  const afterCommand = trimmed.slice(3);
  if (afterCommand && !/^\s/.test(afterCommand)) return null;

  const commandStart = leadingWhitespace.length;
  const argsStart = commandStart + 3 + (afterCommand.match(/^\s*/) || [""])[0].length;
  if (cursor < argsStart) return null;

  return {
    type: "path",
    mode: "cd",
    query: text.slice(argsStart, cursor),
    replaceStart: argsStart,
    replaceEnd: text.length,
  };
}

export function detectSlashCommandAutocompleteContext(text, cursor) {
  const leadingWhitespace = text.match(/^\s*/)?.[0] || "";
  const trimmedBeforeCursor = text.slice(leadingWhitespace.length, cursor);
  if (!trimmedBeforeCursor.startsWith("/")) return null;
  if (/\s/.test(trimmedBeforeCursor.slice(1))) return null;

  return {
    type: "slash-command",
    query: trimmedBeforeCursor.slice(1),
  };
}

export function replacePromptRange(start, end, nextText) {
  const value = el.promptInput.value;
  el.promptInput.value = `${value.slice(0, start)}${nextText}${value.slice(end)}`;
  const nextCursor = start + nextText.length;
  el.promptInput.focus();
  el.promptInput.setSelectionRange(nextCursor, nextCursor);
  autoResizeTextarea();
}

export function insertTextAtCursor(text) {
  const start = el.promptInput.selectionStart ?? el.promptInput.value.length;
  const end = el.promptInput.selectionEnd ?? start;
  replacePromptRange(start, end, text);
}

export function insertCdCommand() {
  const value = el.promptInput.value;
  if (!value.trim()) {
    el.promptInput.value = "/cd ";
    el.promptInput.focus();
    el.promptInput.setSelectionRange(4, 4);
    autoResizeTextarea();
    return;
  }

  insertTextAtCursor("/cd ");
}
