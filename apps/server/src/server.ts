import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeStatus } from "@versionstead/contracts/status";
import {
  AddProject,
  AcknowledgeNotificationSummary,
  ChangeProject,
  ChangeSettings,
  ChangeGlobalToolSources,
  RequestScan,
  decodeMonitoringSnapshot,
  decodeMonitoringSettings,
  decodeProject,
} from "@versionstead/contracts/monitoring";
import { InputError, type MonitoringCoordinator } from "./monitoring.ts";
import { getStatus } from "./status.ts";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Send application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 32 * 1024) {
      request.resume();
      throw new HttpError(413, "Request is too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
function sameToken(value: string | undefined, expected: string | undefined): boolean {
  if (!value || !expected || value.length > 128) return false;
  const candidate = Buffer.from(value);
  const token = Buffer.from(expected);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}
function authenticate(request: IncomingMessage, token: string | undefined): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") && sameToken(authorization.slice(7), token)) return true;
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("versionstead_session="))
    ?.slice("versionstead_session=".length);
  return sameToken(cookie, token);
}
function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, body: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(body);
  } catch {
    throw new HttpError(400, "Invalid request fields");
  }
}

export async function startServer(
  options: {
    port?: number;
    webRoot?: string;
    monitoring?: MonitoringCoordinator;
    authToken?: string;
    devOrigin?: string;
    onShutdown?: () => void;
  } = {},
) {
  if (options.monitoring && !/^[A-Za-z0-9_-]{43}$/.test(options.authToken ?? "")) {
    throw new Error("Monitoring requires a private local capability");
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const origin = new URL(`http://127.0.0.1:${request.socket.localPort}`).origin;
    const requestOrigin = request.headers.origin;
    if (
      request.headers.host !== new URL(origin).host ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      (requestOrigin && requestOrigin !== origin && requestOrigin !== options.devOrigin)
    ) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(value));
    };
    try {
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url ?? "/", origin).pathname);
      } catch {
        throw new HttpError(400, "Invalid path");
      }
      if (path === "/api/status") {
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpError(405, "Method not allowed");
        const status = await Effect.runPromise(getStatus);
        json(
          options.monitoring
            ? decodeStatus({
                ...status,
                capabilities: {
                  inventory: true,
                  updates: true,
                  vulnerabilities: true,
                  remoteAgents: false,
                },
              })
            : status,
        );
        return;
      }
      if (path.startsWith("/api/") && options.monitoring) {
        const coordinator = options.monitoring;
        if (path === "/api/session" && request.method === "POST") {
          const body = decode(Schema.Struct({ token: Schema.String }), await readJson(request));
          if (!sameToken(body.token, options.authToken))
            throw new HttpError(401, "Access code is invalid");
          response.setHeader(
            "Set-Cookie",
            `versionstead_session=${options.authToken}; HttpOnly; SameSite=Strict; Path=/`,
          );
          json({ accepted: true });
          return;
        }
        if (!authenticate(request, options.authToken))
          throw new HttpError(401, "Enter the owner access code to connect");
        if (path === "/api/monitoring" && (request.method === "GET" || request.method === "HEAD")) {
          json(decodeMonitoringSnapshot(coordinator.snapshot()));
          return;
        }
        if (path === "/api/projects" && request.method === "POST") {
          const body = decode(AddProject, await readJson(request));
          if (body.path.length > 4096 || body.path.includes("\0"))
            throw new HttpError(400, "Invalid project path");
          json(decodeProject(await coordinator.addProject(body)), 201);
          return;
        }
        const projectId = /^\/api\/projects\/([a-zA-Z0-9-]{1,100})$/.exec(path)?.[1];
        if (projectId && request.method === "PATCH") {
          json(
            decodeProject(
              coordinator.changeProject(projectId, decode(ChangeProject, await readJson(request))),
            ),
          );
          return;
        }
        if (projectId && request.method === "DELETE") {
          coordinator.removeProject(projectId);
          json({ accepted: true });
          return;
        }
        if (path === "/api/scans" && request.method === "POST") {
          const body = decode(RequestScan, await readJson(request));
          coordinator.requestScan({
            target: body.target,
            ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          });
          json({ accepted: true }, 202);
          return;
        }
        if (path === "/api/settings" && request.method === "PATCH") {
          const body = decode(ChangeSettings, await readJson(request));
          json(
            decodeMonitoringSettings(
              coordinator.changeSettings({
                ...(body.paused === undefined ? {} : { paused: body.paused }),
                ...(body.pcIntervalMinutes === undefined
                  ? {}
                  : { pcIntervalMinutes: body.pcIntervalMinutes }),
                ...(body.projectIntervalMinutes === undefined
                  ? {}
                  : { projectIntervalMinutes: body.projectIntervalMinutes }),
                ...(body.notifyNewFindings === undefined
                  ? {}
                  : { notifyNewFindings: body.notifyNewFindings }),
              }),
            ),
          );
          return;
        }
        if (path === "/api/global-tools/sources" && request.method === "POST") {
          const body = decode(ChangeGlobalToolSources, await readJson(request));
          json(decodeMonitoringSnapshot(await coordinator.changeGlobalToolSources(body.sources)));
          return;
        }
        if (path === "/api/notifications/summary/ack" && request.method === "POST") {
          const body = decode(AcknowledgeNotificationSummary, await readJson(request));
          if (!/^[a-zA-Z0-9-]{1,100}$/.test(body.summaryId))
            throw new HttpError(400, "Invalid notification summary identity");
          coordinator.acknowledgeNotificationSummary(body.summaryId);
          json({ accepted: true });
          return;
        }
        const notificationId = /^\/api\/notifications\/([a-zA-Z0-9-]{1,100})\/ack$/.exec(path)?.[1];
        if (notificationId && request.method === "POST") {
          decode(Schema.Struct({}), await readJson(request));
          coordinator.acknowledgeNotification(notificationId);
          json({ accepted: true });
          return;
        }
        if (path === "/api/shutdown" && request.method === "POST" && options.onShutdown) {
          decode(Schema.Struct({}), await readJson(request));
          json({ accepted: true });
          setImmediate(options.onShutdown);
          return;
        }
        throw new HttpError(404, "API route not found");
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "Method not allowed");
      const file = ["/", "/pc", "/projects", "/service", "/coverage", "/about"].includes(path)
        ? "index.html"
        : /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
          ? path.slice(1)
          : undefined;
      if (!options.webRoot || !file) throw new HttpError(404, "Not found");
      const content = await readFile(join(options.webRoot, file));
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) json({ error: error.message }, error.status);
      else if (error instanceof InputError) json({ error: error.message }, 400);
      else if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        json({ error: "Build the web app with pnpm build first." }, 404);
      else
        json(
          { error: "The local operation could not complete. Check scan evidence and retry." },
          500,
        );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4318, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return {
    origin: new URL(`http://127.0.0.1:${address.port}`).origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
