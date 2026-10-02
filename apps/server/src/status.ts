import { hostname } from "node:os";
import * as Effect from "effect/Effect";
import { decodeStatus } from "@versionstead/contracts/status";
import packageJson from "../package.json" with { type: "json" };

const startedAt = new Date().toISOString();

export const getStatus = Effect.sync(() =>
  decodeStatus({
    app: "Versionstead",
    appVersion: packageJson.version,
    protocolVersion: 1,
    startedAt,
    environment: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
    },
    capabilities: { inventory: false, updates: false, vulnerabilities: false, remoteAgents: false },
  }),
);
