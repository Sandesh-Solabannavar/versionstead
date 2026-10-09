import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** Sent with every coordinator response, and with the built web files that the desktop serves itself. */
export const responseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
} as const;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * The built web app's file for a request path: index.html for each app route, or a flat file name
 * under /assets/. Any other path, or no web root, is null; a file that cannot be read rejects.
 */
export async function readWebFile(webRoot: string | undefined, path: string) {
  const file =
    ["/", "/pc", "/projects", "/service", "/coverage", "/about"].includes(path) ||
    /^\/settings\/(general|project|appearance|keybindings|source-control|connections)$/.test(
      path,
    ) ||
    /^\/computers\/[a-f0-9-]{36}$/.test(path)
      ? "index.html"
      : /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
        ? path.slice(1)
        : undefined;
  if (!webRoot || !file) return null;
  return {
    content: await readFile(join(webRoot, file)),
    contentType: contentTypes[extname(file)] ?? "application/octet-stream",
  };
}
