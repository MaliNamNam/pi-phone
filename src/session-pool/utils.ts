export function contentToPreviewText(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: any) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image") return "[image]";
      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shortId(value: unknown): string {
  return String(value || "").trim().slice(0, 8);
}
