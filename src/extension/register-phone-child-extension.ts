import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const INLINE_MESSAGE_TYPE = "phone-inline-user-message";
const INLINE_IMAGE_TOKEN_PATTERN = /⟦img\d+⟧|\{img\d*\}/g;

function isInlineImageTokenPrompt(text: string): boolean {
  INLINE_IMAGE_TOKEN_PATTERN.lastIndex = 0;
  return INLINE_IMAGE_TOKEN_PATTERN.test(text);
}

function buildInlineContent(text: string, images: ImageContent[]) {
  INLINE_IMAGE_TOKEN_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(INLINE_IMAGE_TOKEN_PATTERN)];
  if (matches.length === 0 || images.length === 0) {
    return { content: text ? [{ type: "text", text } satisfies TextContent] : [], matchedCount: 0 };
  }

  const content: (TextContent | ImageContent)[] = [];
  let lastIndex = 0;
  let imageIndex = 0;

  for (const match of matches) {
    const token = match[0] || "";
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (imageIndex >= images.length) break;

    const before = text.slice(lastIndex, index);
    if (before) {
      content.push({ type: "text", text: before });
    }

    const image = images[imageIndex];
    if (image?.type === "image" && image.data && image.mimeType) {
      content.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      });
      imageIndex += 1;
    } else {
      content.push({ type: "text", text: token });
    }

    lastIndex = index + token.length;
  }

  const after = text.slice(lastIndex);
  if (after) {
    content.push({ type: "text", text: after });
  }

  while (imageIndex < images.length) {
    const image = images[imageIndex];
    if (image?.type === "image" && image.data && image.mimeType) {
      content.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      });
    }
    imageIndex += 1;
  }

  return { content, matchedCount: Math.min(matches.length, images.length) };
}

function flattenText(content: (TextContent | ImageContent)[]): string {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export default function registerPhoneChildExtension(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "rpc" || !Array.isArray(event.images) || event.images.length === 0) {
      return { action: "continue" };
    }

    if (!isInlineImageTokenPrompt(event.text || "")) {
      return { action: "continue" };
    }

    const { content, matchedCount } = buildInlineContent(event.text || "", event.images as ImageContent[]);
    if (matchedCount === 0) {
      return { action: "continue" };
    }

    const trimmed = (event.text || "").trimStart();
    const looksLikeSlashCommand = trimmed.startsWith("/");
    if (!ctx.isIdle() || looksLikeSlashCommand) {
      return {
        action: "transform",
        text: flattenText(content),
        images: content.filter((part): part is ImageContent => part.type === "image"),
      };
    }

    pi.sendMessage(
      {
        customType: INLINE_MESSAGE_TYPE,
        content,
        display: true,
      },
      { triggerTurn: true },
    );

    return { action: "handled" };
  });
}
