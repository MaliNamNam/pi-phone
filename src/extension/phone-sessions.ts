import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

export function summarizeSessionEntry(entry: SessionEntry): {
  kind: string;
  preview: string;
  role?: string;
} {
  if (entry.type === "message") {
    const message: any = entry.message;
    if (message.role === "user") {
      const preview = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part: any) => (part.type === "text" ? part.text || "" : part.type === "image" ? "[image]" : ""))
              .join(" ")
          : "";
      return { kind: "message", role: "user", preview: preview || "(user message)" };
    }

    if (message.role === "assistant") {
      const preview = Array.isArray(message.content)
        ? message.content
            .map((part: any) => (part.type === "text" ? part.text || "" : part.type === "toolCall" ? `[tool:${part.name || "tool"}]` : ""))
            .join(" ")
        : "";
      return { kind: "message", role: "assistant", preview: preview || "(assistant message)" };
    }

    if (message.role === "toolResult") {
      const preview = Array.isArray(message.content)
        ? message.content.map((part: any) => (part.type === "text" ? part.text || "" : "")).join(" ")
        : "";
      return { kind: "tool", role: message.toolName || "tool", preview: preview || `(${message.toolName || "tool"} result)` };
    }

    if (message.role === "custom") {
      return {
        kind: "custom",
        role: message.customType || "custom",
        preview: typeof message.content === "string" ? message.content : "(custom message)",
      };
    }

    if (message.role === "branchSummary") {
      return { kind: "summary", role: "branchSummary", preview: message.summary || "(branch summary)" };
    }

    if (message.role === "compactionSummary") {
      return { kind: "summary", role: "compactionSummary", preview: message.summary || "(compaction summary)" };
    }

    return { kind: "message", role: message.role, preview: `(${message.role || "message"})` };
  }

  if (entry.type === "compaction") {
    return { kind: "compaction", preview: entry.summary || "(compaction)" };
  }
  if (entry.type === "branch_summary") {
    return { kind: "branch_summary", preview: entry.summary || "(branch summary)" };
  }
  if (entry.type === "session_info") {
    return { kind: "session_info", preview: entry.name || "(session info)" };
  }
  if (entry.type === "label") {
    return { kind: "label", preview: entry.label || "(label cleared)" };
  }
  if (entry.type === "model_change") {
    return { kind: "model_change", preview: `${entry.provider}/${entry.modelId}` };
  }
  if (entry.type === "thinking_level_change") {
    return { kind: "thinking_level_change", preview: entry.thinkingLevel || "(thinking change)" };
  }
  if (entry.type === "custom") {
    return { kind: "custom", preview: entry.customType || "(custom entry)" };
  }

  return { kind: entry.type, preview: `(${entry.type})` };
}

function flattenTreeNode(node: any, depth = 0, out: any[] = []): any[] {
  const summary = summarizeSessionEntry(node.entry as SessionEntry);
  out.push({
    id: node.entry.id,
    parentId: node.entry.parentId,
    type: node.entry.type,
    depth,
    timestamp: node.entry.timestamp,
    label: node.label,
    childCount: Array.isArray(node.children) ? node.children.length : 0,
    summary,
  });

  for (const childNode of node.children || []) {
    flattenTreeNode(childNode, depth + 1, out);
  }

  return out;
}

export async function listSessionsForCwd(cwd: string) {
  const sessions = await SessionManager.list(cwd);
  return sessions.map((session) => ({
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    parentSessionPath: session.parentSessionPath,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
}

export function getTreeStateFromSessionFile(sessionFile: string) {
  const sessionManager = SessionManager.open(sessionFile);
  const branch = sessionManager.getBranch();
  const currentPathIds = new Set(branch.map((entry) => entry.id));
  const roots = sessionManager.getTree();
  const nodes = roots.flatMap((root) => flattenTreeNode(root));

  return {
    sessionFile,
    currentLeafId: sessionManager.getLeafId(),
    currentPathIds: [...currentPathIds],
    nodes,
  };
}

export function createBranchSessionFromEntry(sessionFile: string, entryId: string) {
  const sessionManager = SessionManager.open(sessionFile);
  const nextPath = sessionManager.createBranchedSession(entryId);
  if (!nextPath) {
    throw new Error("Failed to create branch session.");
  }
  return nextPath;
}
