import { X509Certificate } from "node:crypto";
import { createServer, request as httpsRequest, Agent } from "node:https";
import { connect } from "node:tls";
import { networkInterfaces } from "node:os";
import type { IncomingMessage } from "node:http";
import type { ActiveScan, Finding, MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { decodeMonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { normalizePeerOrigin, privatePeerAddress } from "@versionstead/contracts/application";
import { InputError, object } from "./projects.ts";

export { createPeerCertificate } from "./certificate.ts";

export const privateAddress = privatePeerAddress;

export function networkAddresses() {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((rows) =>
        (rows ?? [])
          .filter((row) => !row.internal && privateAddress(row.address))
          .map((row) => row.address),
      ),
    ),
  ];
}

export function peerOrigin(value: string) {
  try {
    return normalizePeerOrigin(value);
  } catch {
    throw new InputError("Use an HTTPS address on your LAN or Tailscale network.");
  }
}

/** A Node-generated P-256 PEM pair, or the password-protected PFX that earlier Windows builds created. */
export type PeerCertificate =
  | { key: string; cert: string; fingerprint: string }
  | { pfx: string; password: string; fingerprint: string };

/** Validates a stored certificate record before it reaches the TLS listener. */
export function peerCertificate(value: unknown): PeerCertificate {
  const data: Record<string, unknown> =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (typeof data.fingerprint === "string" && /^[a-f0-9]{64}$/.test(data.fingerprint)) {
    if (typeof data.key === "string" && typeof data.cert === "string")
      return { key: data.key, cert: data.cert, fingerprint: data.fingerprint };
    if (typeof data.pfx === "string" && typeof data.password === "string")
      return { pfx: data.pfx, password: data.password, fingerprint: data.fingerprint };
  }
  throw new InputError("The saved HTTPS certificate of this PC is invalid.");
}

/**
 * True once a PEM certificate's validity has ended, which paired PCs refuse; a certificate that cannot
 * be parsed throws.
 *
 * ponytail: a legacy PFX certificate cannot be dated here without a PKCS#12 reader, so it is never
 * reported expired; read its expiry too if hosts from earlier Windows builds are seen to expire.
 */
export function peerCertificateExpired(certificate: PeerCertificate) {
  return (
    "cert" in certificate &&
    new X509Certificate(certificate.cert).validToDate.getTime() <= Date.now()
  );
}

// The header a paired client declares its feature marker in; clients older than Wave 4 send none.
const featuresHeader = "x-versionstead-features";

/** A finding as clients older than Wave 4 read it: their original fields only. */
const legacyFinding = ({
  id,
  kind,
  subjectId,
  subjectLabel,
  name,
  packageName,
  installedVersion,
  availableVersion,
  severity,
  source,
  description,
  advisoryUrl,
  detectedAt,
  lastSeenAt,
}: Finding): Finding => ({
  id,
  kind,
  subjectId,
  subjectLabel,
  name,
  packageName,
  installedVersion,
  availableVersion,
  severity,
  source,
  description,
  advisoryUrl,
  detectedAt,
  lastSeenAt,
});

// The scan steps a client older than Wave 4 knows. It refuses any other, so a step added since reads
// to it as no active step: a new step must not reach it until a marker says that it can.
const olderScanSteps: ReadonlySet<ActiveScan["stage"]> = new Set([
  "inventory",
  "pc-updates",
  "project-inputs",
  "advisories",
  "advisory-details",
  "native-versions",
  "versions",
  "saving",
]);

/**
 * Evidence a paired client may read: local paths, commands, notification payloads, and the feature
 * marker never leave this PC. A client that declares no marker of v10 or later predates Wave 4 and
 * also gets only what its strict contract can read: update, advisory, and coverage findings with
 * their original fields, and live progress in which a scan step it does not know reads as no active
 * step. Everything else stays, including the rest of `scanProgress`.
 *
 * ponytail: one cut, at v10; when a later marker adds what v10 clients cannot decode (a new scan
 * step, say), cut there too.
 */
export function sharedEvidence(
  snapshot: MonitoringSnapshot,
  clientFeatures?: string,
): MonitoringSnapshot {
  // No receiving PC reads the feature marker, and a PC on an older build refuses a marker it does
  // not know, so the marker is never shared. Nor are the snooze and ignore rules: they hold the
  // owner's own reasons, and a receiving PC needs only each finding's `ruleId`. Nor is the resolved
  // history, which no receiving PC reads, the count of events waiting to notify, or the owner's
  // quiet hours and digest time, which say when they want silence.
  const {
    features: _marker,
    findingRules: _rules,
    resolvedFindings: _resolved,
    notificationsWaiting: _waiting,
    ...evidence
  } = snapshot;
  const { quietHours: _quiet, digestAt: _digest, ...settings } = snapshot.settings;
  // The declared value is request input: only an exact marker counts, anything else reads as none.
  const declared = /^settings-repositories-connections-v([1-9]\d{0,3})$/.exec(clientFeatures ?? "");
  const readsWave4 = declared !== null && Number(declared[1]) >= 10;
  const progress = snapshot.scanProgress;
  return decodeMonitoringSnapshot({
    ...evidence,
    settings,
    ...(readsWave4
      ? {}
      : {
          findings: snapshot.findings
            .filter(({ kind }) => kind === "update" || kind === "advisory" || kind === "coverage")
            .map(legacyFinding),
          ...(progress?.active && !olderScanSteps.has(progress.active.stage)
            ? { scanProgress: { ...progress, active: null } }
            : {}),
        }),
    inventory: {
      ...snapshot.inventory,
      managers: (snapshot.inventory.managers ?? []).map((m) => ({ ...m, root: null })),
    },
    projects: snapshot.projects.map((p) => ({
      ...p,
      actions: [],
      path: p.repository?.url ?? "Selected on remote PC",
      manifestPath: p.manifestPath ? "package.json" : null,
      lockfilePath: p.lockfilePath ? (p.lockfilePath.split(/[\\/]/).at(-1) ?? null) : null,
      dependencies: p.dependencies.map((dependency) => ({
        ...dependency,
        requested:
          dependency.origin === "registry" || dependency.origin === "workspace"
            ? dependency.requested
            : null,
      })),
    })),
    notifications: [],
    notificationSummary: null,
  });
}

async function body(request: IncomingMessage) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new InputError("Send application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      request.resume();
      throw new InputError("Pairing request is too large.");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new InputError("Invalid paired-PC request.");
  }
}

export async function startPeerServer(options: {
  address: string;
  port: number;
  certificate: PeerCertificate;
  snapshot: () => MonitoringSnapshot;
  pair: (code: string, label: string, deviceId: string) => { token: string; deviceId: string };
  authenticate: (token: string) => string | null;
  scan: () => void;
  revoke: (id: string) => void;
}) {
  if (
    !privateAddress(options.address) ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new InputError("Choose a local or Tailscale IPv4 address and a valid port.");
  const lastScan = new Map<string, number>();
  const server = createServer(
    {
      ...("pfx" in options.certificate
        ? {
            pfx: Buffer.from(options.certificate.pfx, "base64"),
            passphrase: options.certificate.password,
          }
        : { key: options.certificate.key, cert: options.certificate.cert }),
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
    },
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status).end(JSON.stringify(value));
      };
      if (
        request.headers.origin ||
        request.headers["sec-fetch-site"] ||
        request.headers.host !== `${options.address}:${request.socket.localPort}`
      ) {
        reply({ error: "Forbidden" }, 403);
        return;
      }
      try {
        if (request.url === "/pair" && request.method === "POST") {
          const data = await body(request);
          if (
            typeof data.code !== "string" ||
            typeof data.label !== "string" ||
            typeof data.deviceId !== "string" ||
            data.label.length > 100 ||
            Array.from(data.label).some((char) => char.charCodeAt(0) < 32) ||
            !/^[a-f0-9-]{36}$/.test(data.deviceId)
          )
            throw new InputError("Invalid pairing identity.");
          reply(options.pair(data.code, data.label, data.deviceId));
          return;
        }
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const client = options.authenticate(token);
        if (!client) {
          reply({ error: "This pairing is missing or revoked." }, 401);
          return;
        }
        if (request.url === "/evidence" && request.method === "GET") {
          const nonce = request.headers["x-versionstead-nonce"];
          if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce))
            throw new InputError("Invalid evidence nonce.");
          const declared = request.headers[featuresHeader];
          reply({
            nonce,
            snapshot: sharedEvidence(
              options.snapshot(),
              typeof declared === "string" ? declared : undefined,
            ),
          });
          return;
        }
        if (request.url === "/scan" && request.method === "POST") {
          await body(request);
          if ((lastScan.get(client) ?? 0) + 10000 > Date.now()) {
            reply({ error: "A scan was requested recently." }, 429);
            return;
          }
          lastScan.set(client, Date.now());
          options.scan();
          reply({ accepted: true }, 202);
          return;
        }
        if (request.url === "/revoke" && request.method === "POST") {
          await body(request);
          options.revoke(client);
          reply({ accepted: true });
          return;
        }
        reply({ error: "Not found" }, 404);
      } catch {
        reply(
          { error: "The paired-PC request was rejected. Check the invitation and try again." },
          400,
        );
      }
    },
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new InputError("The paired-PC host did not start.");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

export async function peerRequest(
  origin: string,
  fingerprint: string,
  path: "/pair" | "/evidence" | "/scan" | "/revoke",
  options: {
    token?: string;
    body?: unknown;
    nonce?: string;
    /** The client's feature marker; the host shapes its evidence by it. */
    features?: string;
    signal?: AbortSignal;
    tunnelPort?: number;
  } = {},
): Promise<unknown> {
  const url = new URL(path, peerOrigin(origin));
  if (
    options.tunnelPort !== undefined &&
    (!Number.isInteger(options.tunnelPort) ||
      options.tunnelPort < 1024 ||
      options.tunnelPort > 65535)
  )
    throw new InputError("Invalid SSH tunnel port.");
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw new InputError("Invalid paired-PC certificate fingerprint.");
  const agent = new Agent({ keepAlive: false });
  const signal = AbortSignal.any([
    AbortSignal.timeout(12000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  // Headers and credentials are not written until the certificate pin is verified.
  agent.createConnection = (_tlsOptions, callback) => {
    const socket = connect({
      host: options.tunnelPort ? "127.0.0.1" : url.hostname,
      port: options.tunnelPort ?? Number(url.port || 443),
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    let settled = false;
    const complete = (error: Error | null) => {
      if (settled) return;
      settled = true;
      callback?.(error, socket);
    };
    const abort = () => socket.destroy(new Error("Paired-PC request stopped."));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", abort));
    socket.setTimeout(12000, () => socket.destroy(new Error("TLS timeout")));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const actual = certificate.fingerprint256?.replaceAll(":", "").toLowerCase();
      if (
        actual !== fingerprint ||
        Date.parse(certificate.valid_to) < Date.now() ||
        Date.parse(certificate.valid_from) > Date.now()
      ) {
        socket.destroy();
        complete(new Error("Certificate pin mismatch or expiry."));
      } else complete(null);
    });
    socket.once("error", (error) => complete(error));
    return undefined as unknown as ReturnType<Agent["createConnection"]>;
  };
  try {
    return await new Promise((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          agent,
          method: options.body === undefined ? "GET" : "POST",
          timeout: 12000,
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...(options.nonce ? { "X-Versionstead-Nonce": options.nonce } : {}),
            ...(options.features ? { [featuresHeader]: options.features } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) {
              response.destroy();
              reject(new InputError("Paired-PC evidence exceeds its supported size."));
            } else chunks.push(Buffer.from(chunk));
          });
          response.on("error", reject);
          response.on("end", () => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new InputError(
                  // The listener's per-client scan cooldown; the PC itself is reachable and paired.
                  response.statusCode === 429
                    ? "This PC was asked to scan recently. Try again in a minute."
                    : "The paired PC rejected access or is unavailable.",
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new InputError("The paired PC returned malformed evidence."));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("Timeout")));
      req.on("error", () =>
        reject(
          new InputError(
            "Could not reach the paired PC or verify its certificate. Check its network route, firewall, and pairing.",
          ),
        ),
      );
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  } finally {
    agent.destroy();
  }
}
