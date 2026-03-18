import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const publicDir = resolve(__dirname, "../../public");

export const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export function sanitizePublicPath(pathname: string): string | null {
  const normalized = normalize(pathname).replace(/^\/+/, "");
  const filePath = resolve(publicDir, normalized === "" ? "index.html" : normalized);
  if (!filePath.startsWith(publicDir)) return null;
  return filePath;
}

export function publicFilePath(relativePath: string): string {
  return join(publicDir, relativePath);
}
