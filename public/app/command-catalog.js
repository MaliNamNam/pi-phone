import { COMMAND_CATEGORY_ORDER, LOCAL_COMMAND_DEFINITIONS } from "./constants.js";
import { state } from "./state.js";

function compareCommandNames(left, right) {
  return String(left?.name || "").localeCompare(String(right?.name || ""));
}

export function sortCommandCategories(categories = []) {
  return [...categories].sort((left, right) => {
    const leftIndex = COMMAND_CATEGORY_ORDER.indexOf(left);
    const rightIndex = COMMAND_CATEGORY_ORDER.indexOf(right);
    const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

    if (normalizedLeftIndex !== normalizedRightIndex) return normalizedLeftIndex - normalizedRightIndex;
    return String(left || "").localeCompare(String(right || ""));
  });
}

export function localCommandCatalog() {
  return LOCAL_COMMAND_DEFINITIONS.map((command) => ({
    name: command.name,
    description: command.description,
    source: "local",
    insertOnly: Boolean(command.insertOnly),
  }));
}

export function visibleCommandCatalog() {
  const localCommands = localCommandCatalog();
  const localNames = new Set(localCommands.map((command) => command.name));
  return [
    ...localCommands,
    ...state.commands.filter((command) => !localNames.has(command.name)),
  ];
}

export function findLocalCommandDefinition(name) {
  return LOCAL_COMMAND_DEFINITIONS.find((command) => command.name === name) || null;
}

export function groupedCommands() {
  const groups = new Map();
  const merged = visibleCommandCatalog();

  for (const command of merged) {
    const key = command.source || "command";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(command);
  }

  for (const commands of groups.values()) {
    commands.sort(compareCommandNames);
  }

  return new Map(sortCommandCategories([...groups.keys()]).map((category) => [category, groups.get(category) || []]));
}

export function commandCategoryLabel(category = "") {
  if (!category) return "Commands";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function selectedCommandCategory(categories = []) {
  if (!categories.length) {
    state.commandSheetCategory = "";
    return "";
  }

  if (categories.includes(state.commandSheetCategory)) {
    return state.commandSheetCategory;
  }

  state.commandSheetCategory = categories[0];
  return state.commandSheetCategory;
}
