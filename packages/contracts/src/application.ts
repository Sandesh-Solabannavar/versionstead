import * as Schema from "effect/Schema";
import { MonitoringSnapshot } from "./monitoring.ts";

const NullableString = Schema.NullOr(Schema.String);
export const ProviderKind = Schema.Literals(["github", "gitlab"]);
export type ProviderKind = typeof ProviderKind.Type;
export const ApplicationPreferences = Schema.Struct({
  gitEnabled: Schema.Boolean,
  automaticRepositoryScans: Schema.Boolean,
  automaticAppUpdateChecks: Schema.Boolean,
});
export type ApplicationPreferences = typeof ApplicationPreferences.Type;
export const ToolStatus = Schema.Struct({ available: Schema.Boolean, version: NullableString });
export const Repository = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
});
export type Repository = typeof Repository.Type;
export const ProviderConnection = Schema.Struct({
  kind: ProviderKind,
  enabled: Schema.Boolean,
  account: NullableString,
  checkedAt: NullableString,
  error: NullableString,
});
export type ProviderConnection = typeof ProviderConnection.Type;
export const SshTarget = Schema.Struct({
  host: Schema.String,
  username: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
});
export type SshTarget = typeof SshTarget.Type;
export const SshHostList = Schema.Struct({
  available: Schema.Boolean,
  hosts: Schema.Array(SshTarget),
  error: NullableString,
});
export const decodeSshHostList = Schema.decodeUnknownSync(SshHostList);
export const ConnectedComputer = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  origin: Schema.String,
  fingerprint: Schema.String,
  deviceId: Schema.String,
  checkedAt: NullableString,
  error: NullableString,
  snapshot: Schema.NullOr(MonitoringSnapshot),
  enabled: Schema.optional(Schema.Boolean),
  ssh: Schema.optional(SshTarget),
});
export type ConnectedComputer = typeof ConnectedComputer.Type;
export const PairedClient = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  deviceId: Schema.String,
  createdAt: Schema.String,
});
export const Sharing = Schema.Struct({
  enabled: Schema.Boolean,
  address: Schema.String,
  port: Schema.Number,
  fingerprint: NullableString,
  error: NullableString,
  clients: Schema.Array(PairedClient),
});
export const AppUpdate = Schema.Struct({
  status: Schema.Literals(["idle", "checking", "current", "available", "unpublished", "failed"]),
  currentVersion: Schema.String,
  latestVersion: NullableString,
  releaseUrl: NullableString,
  notes: NullableString,
  checkedAt: NullableString,
  error: NullableString,
});
export type AppUpdate = typeof AppUpdate.Type;
export const ApplicationSnapshot = Schema.Struct({
  localOrigin: Schema.optional(NullableString),
  preferences: ApplicationPreferences,
  providers: Schema.Array(ProviderConnection),
  tools: Schema.Struct({
    git: ToolStatus,
    github: ToolStatus,
    gitlab: ToolStatus,
    tailscale: ToolStatus,
    ssh: Schema.optional(ToolStatus),
  }),
  networkAddresses: Schema.Array(Schema.String),
  credentialStorageAvailable: Schema.Boolean,
  sharing: Sharing,
  computers: Schema.Array(ConnectedComputer),
  update: AppUpdate,
});
export type ApplicationSnapshot = typeof ApplicationSnapshot.Type;
export const decodeApplicationSnapshot = Schema.decodeUnknownSync(ApplicationSnapshot);
export const decodeRepositoryList = Schema.decodeUnknownSync(Schema.Array(Repository));
export const ConnectProvider = Schema.Struct({
  kind: ProviderKind,
  token: Schema.optional(Schema.String),
  useCli: Schema.optional(Schema.Boolean),
});
export const ChangeProvider = Schema.Struct({
  kind: ProviderKind,
  enabled: Schema.Boolean,
  disconnect: Schema.optional(Schema.Boolean),
});
export const SelectRepository = Schema.Struct({
  kind: ProviderKind,
  repositoryId: Schema.String,
  ref: Schema.optional(Schema.String),
  mode: Schema.Literals(["maintained", "watch"]),
});
export const ChangeApplicationPreferences = Schema.Struct({
  gitEnabled: Schema.optional(Schema.Boolean),
  automaticRepositoryScans: Schema.optional(Schema.Boolean),
  automaticAppUpdateChecks: Schema.optional(Schema.Boolean),
});
export const ChangeSharing = Schema.Struct({
  enabled: Schema.Boolean,
  address: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
});
export const PairComputer = Schema.Struct({
  invitation: Schema.String,
  ssh: Schema.optional(SshTarget),
});
export const ChangeComputer = Schema.Struct({ id: Schema.String, enabled: Schema.Boolean });
export const Invitation = Schema.Struct({ invitation: Schema.String, expiresAt: Schema.String });
export const decodeInvitation = Schema.decodeUnknownSync(Invitation);
export const ComputerAction = Schema.Struct({ id: Schema.String });
export const RemoteEvidence = Schema.Struct({ nonce: Schema.String, snapshot: MonitoringSnapshot });
export const decodeRemoteEvidence = Schema.decodeUnknownSync(RemoteEvidence);

const PairingIdentity = Schema.Struct({
  version: Schema.Literal(1),
  origin: Schema.String,
  fingerprint: Schema.String,
  deviceId: Schema.String,
  label: Schema.String,
  code: Schema.String,
});

/** Shared by the native host and renderer. The opaque code includes the certificate pin. */
export function parsePairingInvitation(value: string) {
  try {
    if (value.length > 4096) throw new Error();
    let code = value.trim();
    let host: string | null = null;
    if (code.startsWith("https://")) {
      const url = new URL(code);
      if (url.pathname !== "/" || url.search || !url.hash.startsWith("#pair=")) throw new Error();
      host = url.origin;
      code = url.hash.slice(6);
    }
    if (code.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error();
    const binary = atob(code.replaceAll("-", "+").replaceAll("_", "/"));
    const data = Schema.decodeUnknownSync(PairingIdentity)(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        ),
      ),
    );
    const origin = normalizePeerOrigin(data.origin);
    if (
      (host && host !== origin) ||
      !/^[a-f0-9]{64}$/.test(data.fingerprint) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.deviceId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.code) ||
      !data.label ||
      data.label.length > 100 ||
      Array.from(data.label).some((c) => c.charCodeAt(0) < 32)
    )
      throw new Error();
    return {
      identity: { ...data, origin },
      host: origin,
      pairingCode: code,
      url: `${origin}/#pair=${code}`,
    };
  } catch {
    throw new Error("Paste a valid Versionstead pairing link or code from the other PC.");
  }
}

export function privatePeerAddress(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255))
    return false;
  const [a, b] = parts.map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 100 && b! >= 64 && b! <= 127)
  );
}

export function normalizePeerOrigin(value: string) {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    url.protocol !== "https:" ||
    !privatePeerAddress(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTPS address on your LAN or Tailscale network.");
  return url.origin;
}

export function remotePairingFields(host: string, pairingCode: string) {
  const parsed = parsePairingInvitation(pairingCode);
  if (normalizePeerOrigin(host.trim()) !== parsed.host)
    throw new Error("The host does not match this pairing code. Paste a new link from that PC.");
  return parsed.url;
}
