import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import semver from "semver";
import {
  ApplicationPreferences,
  ChangeApplicationPreferences,
  ProviderConnection,
  ConnectedComputer,
  Sharing,
  type ApplicationSnapshot,
  type ComputerSnapshot,
  type ProviderKind,
  type Repository,
  type AppUpdate,
  decodeRemoteEvidence,
  parsePairingInvitation,
  type SshTarget,
} from "@versionstead/contracts/application";
import {
  decodeAcceptedResponse,
  MonitoringSnapshot,
  type Project,
} from "@versionstead/contracts/monitoring";
import type { MonitoringCoordinator } from "./monitoring.ts";
import { InputError, inspectProject, object } from "./adapters/projects.ts";
import { discoverTools, inspectGit, runTool } from "./adapters/development-tools.ts";
import { providerAccount, listRepositories, inspectRepository } from "./adapters/repositories.ts";
import {
  createPeerCertificate,
  networkAddresses,
  peerCertificate,
  peerOrigin,
  peerRequest,
  privateAddress,
  startPeerServer,
  type PeerCertificate,
} from "./adapters/paired-computers.ts";
import { discoverSshHosts, startSshTunnel, validateSshTarget } from "./adapters/ssh-connections.ts";
import { readSource } from "./adapters/source-http.ts";
import type { CredentialOptions } from "./adapters/keychain.ts";
import {
  CredentialStorageUnavailable,
  credentialStorageIssue,
  discardSecret,
  protectSecret,
  unprotectSecret,
} from "./runtime.ts";

// A saved paired PC is its connection record with the evidence it last sent. The polled application
// read leaves the evidence out, so the contract's record has the evidence's digest instead.
const { snapshotDigest: _wireOnly, ...computerFields } = ConnectedComputer.fields;
const StoredComputer = Schema.Struct({
  ...computerFields,
  snapshot: Schema.NullOr(MonitoringSnapshot),
});
const StoredApplication = Schema.Struct({
  preferences: ApplicationPreferences,
  providers: Schema.Array(ProviderConnection),
  computers: Schema.Array(StoredComputer),
  sharing: Sharing,
  secrets: Schema.Array(Schema.Struct({ key: Schema.String, encrypted: Schema.String })),
  clientHashes: Schema.Array(Schema.Struct({ id: Schema.String, hash: Schema.String })),
});
type Stored = typeof StoredApplication.Type;
// The digest is computed when evidence arrives or is loaded and is never saved.
type Computer = Stored["computers"][number] & { snapshotDigest: string | null };
type State = Omit<{ -readonly [K in keyof Stored]: Stored[K] }, "computers"> & {
  computers: Computer[];
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const evidenceDigest = (snapshot: MonitoringSnapshot) => hash(JSON.stringify(snapshot));
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const now = () => new Date().toISOString();
const restartFailure =
  "The paired-PC host could not restart. Check its address, certificate, and network access.";

export class ApplicationService {
  private state: State;
  private readonly plainSecrets = new Map<string, string>();
  private readonly repositoryLists = new Map<ProviderKind, readonly Repository[]>();
  private readonly coordinator: MonitoringCoordinator;
  private readonly fetcher: typeof fetch;
  private tools: ApplicationSnapshot["tools"] = {
    git: { available: false, version: null },
    github: { available: false, version: null },
    gitlab: { available: false, version: null },
    tailscale: { available: false, version: null },
  };
  private update: AppUpdate;
  private localOrigin: string | null = null;
  private peerServer: Awaited<ReturnType<typeof startPeerServer>> | null = null;
  private readonly tunnels = new Map<string, Promise<Awaited<ReturnType<typeof startSshTunnel>>>>();
  private invitation: { code: string; expires: number; attempts: number } | null = null;
  private readonly shutdown = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling: Promise<void> | null = null;
  private nextUpdate = 0;
  private readonly peer: typeof peerRequest;
  private readonly probeTools: typeof discoverTools;
  // What the last write contained, as save() compares it; see there.
  private saved: string | null = null;
  // The probe of the installed tools that runs when the service starts; reads wait for it.
  private readonly startup: Promise<unknown>;
  // Discoveries started, and the latest one whose result is applied; see discover().
  private discoveries = 0;
  private discovered = 0;
  private readonly credentials: CredentialOptions;
  // The last credential-storage check. Success holds for this process; a failure is checked again
  // after a minute or on an explicit refresh, so a keyring unlocked after start-up is picked up.
  private storage: { issue: string | null; at: number } | null = null;
  private storageCheck: Promise<string | null> | null = null;
  private sharingWork: Promise<unknown> = Promise.resolve();

  private constructor(
    coordinator: MonitoringCoordinator,
    fetcher: typeof fetch,
    peer: typeof peerRequest,
    tools: typeof discoverTools,
    version: string,
    credentials: CredentialOptions,
  ) {
    this.credentials = credentials;
    // DPAPI needs no probe, so Windows hosts behave as before.
    if ((credentials.platform ?? process.platform) === "win32")
      this.storage = { issue: null, at: Date.now() };
    this.coordinator = coordinator;
    this.fetcher = fetcher;
    this.peer = peer;
    this.probeTools = tools;
    const saved = coordinator.readApplication();
    const stored: Stored = saved
      ? Schema.decodeUnknownSync(StoredApplication)(saved)
      : {
          preferences: {
            gitEnabled: true,
            automaticRepositoryScans: true,
            automaticAppUpdateChecks: false,
          },
          providers: ["github", "gitlab"].map((kind) => ({
            kind: kind as ProviderKind,
            enabled: false,
            account: null,
            checkedAt: null,
            error: null,
          })),
          computers: [],
          sharing: {
            enabled: false,
            address: "",
            port: 4389,
            fingerprint: null,
            error: null,
            clients: [],
          },
          secrets: [],
          clientHashes: [],
        };
    this.state = {
      ...stored,
      computers: stored.computers.map((computer) => ({
        ...computer,
        snapshotDigest: computer.snapshot && evidenceDigest(computer.snapshot),
      })),
    };
    if (
      this.state.computers.length > 8 ||
      this.state.sharing.clients.length > 16 ||
      this.state.providers.length !== 2 ||
      new Set(this.state.providers.map((p) => p.kind)).size !== 2 ||
      this.state.secrets.length > 20
    )
      throw new Error("Invalid connection storage.");
    this.update = {
      status: "idle",
      currentVersion: version,
      latestVersion: null,
      releaseUrl: null,
      notes: null,
      checkedAt: null,
      error: null,
    };
    this.state.computers = this.state.computers.map((computer) => ({
      ...computer,
      error:
        "Connection has not been checked since monitoring started. Last received evidence is retained.",
    }));
    coordinator.configureProjectInspection(
      (p, signal) => this.inspect(p, signal),
      (p) =>
        !p.repository ||
        (this.state.preferences.automaticRepositoryScans &&
          this.provider(p.repository.provider).enabled),
    );
    this.save();
    this.timer = setInterval(() => {
      this.polling ??= this.poll().finally(() => {
        this.polling = null;
      });
    }, 30000);
    this.timer.unref();
    // The tools are probed now, and afterwards only when the owner asks (or changes the Git preference
    // that decides what is reported of Git), never because the interface polls. A failed probe reads
    // as unavailable; no rejection may escape this promise, which nothing observes until a read.
    this.startup = this.discover().catch(() => {});
  }

  static async create(
    coordinator: MonitoringCoordinator,
    fetcher: typeof fetch = fetch,
    peer: typeof peerRequest = peerRequest,
    tools: typeof discoverTools = discoverTools,
    credentials: CredentialOptions = {},
  ) {
    const metadata = object(
      JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
    );
    if (typeof metadata.version !== "string" || !semver.valid(metadata.version))
      throw new Error("Invalid application version.");
    const app = new ApplicationService(
      coordinator,
      fetcher,
      peer,
      tools,
      metadata.version,
      credentials,
    );
    if (app.state.sharing.enabled)
      await app.serializeSharing(async () => {
        try {
          await app.enableSharing(app.state.sharing.address, app.state.sharing.port);
        } catch (error) {
          app.state.sharing = {
            ...app.state.sharing,
            error: app.sharingFailure(error, restartFailure),
          };
          app.save();
        }
      });
    return app;
  }
  // The single write path. Received evidence counts by its digest and a computer's checkedAt not at
  // all, so a refresh that changes neither the evidence nor the connection error is not written. Its
  // check time stays in memory and is saved with the next change.
  // ponytail: after a restart retained evidence can show an older check time than the last contact,
  // never a newer one; save the time on a timer if that matters. One row also holds every received
  // snapshot, so a changed snapshot rewrites all of them (up to 8 x 16 MiB); give each PC its own row
  // if that measurably matters.
  private save() {
    const durable = JSON.stringify({
      ...this.state,
      computers: this.state.computers.map(
        ({ snapshot: _evidence, checkedAt: _at, ...rest }) => rest,
      ),
    });
    if (durable === this.saved) return;
    this.coordinator.writeApplication({
      ...this.state,
      computers: this.state.computers.map(({ snapshotDigest: _digest, ...stored }) => stored),
    });
    this.saved = durable;
  }
  private provider(kind: ProviderKind) {
    return this.state.providers.find((p) => p.kind === kind)!;
  }
  private updateProvider(
    kind: ProviderKind,
    patch: Partial<ApplicationSnapshot["providers"][number]>,
  ) {
    this.state.providers = this.state.providers.map((p) =>
      p.kind === kind ? { ...p, ...patch } : p,
    );
  }
  /** Null when protected credentials can be stored here; otherwise what is missing and how to get it. */
  async checkCredentialStorage(force = false): Promise<string | null> {
    const known = this.storage;
    if (known && (known.issue === null || (!force && Date.now() - known.at < 60_000)))
      return known.issue;
    this.storageCheck ??= credentialStorageIssue(this.credentials)
      .catch(() => "Protected credential storage could not be checked on this monitoring host.")
      .then((issue) => {
        this.storage = { issue, at: Date.now() };
        return issue;
      })
      .finally(() => {
        this.storageCheck = null;
      });
    return this.storageCheck;
  }
  private async requireCredentialStorage() {
    const issue = await this.checkCredentialStorage();
    if (issue) throw new CredentialStorageUnavailable(issue);
  }
  // The held success above is not checked again, so a store that the credential layer finds missing
  // or locked later (a keyring locked at logout) is recorded here as the latest check.
  private storageFailed(error: unknown) {
    if (error instanceof CredentialStorageUnavailable)
      this.storage = { issue: error.message, at: Date.now() };
    return error;
  }
  private sharingFailure(error: unknown, fallback: string) {
    return error instanceof CredentialStorageUnavailable ? error.message : fallback;
  }
  /** Sharing changes and listener retries run one at a time, so a retry never undoes a switch-off. */
  private serializeSharing<T>(work: () => Promise<T>): Promise<T> {
    const next = this.sharingWork.then(work, work);
    this.sharingWork = next.catch(() => {});
    return next;
  }
  private async secret(key: string) {
    if (this.plainSecrets.has(key)) return this.plainSecrets.get(key)!;
    const entry = this.state.secrets.find((s) => s.key === key);
    if (!entry) throw new InputError("Reconnect this source to restore its protected credentials.");
    await this.requireCredentialStorage();
    try {
      const value = await unprotectSecret(entry.encrypted, this.credentials);
      this.plainSecrets.set(key, value);
      return value;
    } catch (error) {
      if (error instanceof CredentialStorageUnavailable) throw this.storageFailed(error);
      throw new InputError("The saved credential could not be unlocked on this monitoring host.");
    }
  }
  private async storeSecret(key: string, value: string) {
    await this.requireCredentialStorage();
    const encrypted = await protectSecret(value, {
      ...this.credentials,
      namespace: this.coordinator.device.id,
    }).catch((error: unknown) => {
      throw this.storageFailed(error);
    });
    const previous = this.state.secrets.find((s) => s.key === key)?.encrypted;
    this.state.secrets = [...this.state.secrets.filter((s) => s.key !== key), { key, encrypted }];
    this.plainSecrets.set(key, value);
    // Saved first: a crash in between leaves an unused keychain item, never a record without one.
    this.save();
    if (previous)
      await discardSecret(previous, this.credentials).catch((error: unknown) =>
        this.storageFailed(error),
      );
  }
  private async forgetSecret(key: string) {
    const entry = this.state.secrets.find((s) => s.key === key);
    this.state.secrets = this.state.secrets.filter((s) => s.key !== key);
    this.plainSecrets.delete(key);
    // ponytail: an item that cannot be deleted now (a locked keychain) stays behind and the docs say to
    // revoke the token at the provider; retry the deletion if leftover items ever matter.
    if (entry)
      await discardSecret(entry.encrypted, this.credentials).catch((error: unknown) =>
        this.storageFailed(error),
      );
  }
  snapshot(): ApplicationSnapshot {
    return structuredClone({
      localOrigin: this.localOrigin,
      preferences: this.state.preferences,
      providers: this.state.providers,
      tools: this.tools,
      networkAddresses: networkAddresses(),
      credentialStorageAvailable: this.storage?.issue === null,
      credentialStorageIssue: this.storage
        ? this.storage.issue
        : "Checking protected credential storage on this monitoring host.",
      sharing: {
        ...this.state.sharing,
        error:
          this.state.sharing.enabled && !this.peerServer
            ? (this.state.sharing.error ?? "The sharing listener is unavailable.")
            : this.state.sharing.error,
      },
      // The evidence is read per PC, through computerSnapshot(), not with every poll of this record.
      computers: this.state.computers.map(({ snapshot: _evidence, ...computer }) => computer),
      update: this.update,
    });
  }
  /** One paired PC's received evidence, or null when that PC is not connected. */
  computerSnapshot(id: string): ComputerSnapshot | null {
    const computer = this.state.computers.find((candidate) => candidate.id === id);
    return computer
      ? {
          snapshotDigest: computer.snapshotDigest,
          checkedAt: computer.checkedAt,
          error: computer.error,
          snapshot: computer.snapshot,
        }
      : null;
  }
  setLocalOrigin(origin: string) {
    this.localOrigin = origin;
  }
  async discover(refreshAuthentication = false) {
    if (refreshAuthentication) await this.checkCredentialStorage(true);
    // Overlapping discoveries (startup, Refresh, a Git switch) finish in any order; a result never
    // replaces one from a discovery that started later.
    const discovery = ++this.discoveries;
    const tools = await this.probeTools(this.state.preferences.gitEnabled);
    if (discovery > this.discovered) {
      this.tools = tools;
      this.discovered = discovery;
    }
    if (refreshAuthentication) {
      await Promise.all(
        this.state.providers.map(async (provider) => {
          if (!provider.account) return;
          const key = `provider:${provider.kind}`;
          const credential = this.state.secrets.find((entry) => entry.key === key)?.encrypted;
          let account = provider.account;
          let error: string | null = null;
          try {
            account = await providerAccount(
              provider.kind,
              await this.secret(key),
              this.fetcher,
              this.shutdown.signal,
            );
          } catch {
            error =
              "Provider authentication could not be verified. Check the connection, token permissions, and provider availability, or reconnect.";
          }
          if (
            this.shutdown.signal.aborted ||
            this.provider(provider.kind).account !== provider.account ||
            this.state.secrets.find((entry) => entry.key === key)?.encrypted !== credential
          )
            return;
          this.updateProvider(provider.kind, { account, checkedAt: now(), error });
        }),
      );
      this.save();
    }
    return this.snapshot();
  }
  async readSnapshot() {
    // The first read waits for the check; later reads refresh a failing one in the background.
    if (!this.storage) await this.checkCredentialStorage();
    else void this.checkCredentialStorage();
    await this.startup;
    return this.snapshot();
  }
  async changePreferences(patch: typeof ChangeApplicationPreferences.Type) {
    const { gitEnabled } = this.state.preferences;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    this.state.preferences = Schema.decodeUnknownSync(ApplicationPreferences)({
      ...this.state.preferences,
      ...defined,
    });
    this.save();
    // Whether Git may run decides what is reported of it, and polling no longer refreshes that.
    return this.state.preferences.gitEnabled === gitEnabled ? this.snapshot() : this.discover();
  }
  async connectProvider(kind: ProviderKind, token?: string, useCli = false) {
    if (useCli) {
      if (this.coordinator.mode !== "interactive")
        throw new InputError(
          "The background host cannot read your signed-in CLI credentials. Connect with a read-only token instead.",
        );
      token = await runTool(kind === "github" ? "gh" : "glab", [
        "auth",
        "token",
        "--hostname",
        kind === "github" ? "github.com" : "gitlab.com",
      ]);
    }
    if (!token || token.length > 4096 || /[^\x21-\x7e]/.test(token))
      throw new InputError("Enter a valid read-only provider token.");
    const account = await providerAccount(kind, token, this.fetcher);
    await this.storeSecret(`provider:${kind}`, token);
    this.updateProvider(kind, { account, enabled: true, checkedAt: now(), error: null });
    this.repositoryLists.delete(kind);
    this.save();
    return this.snapshot();
  }
  async changeProvider(kind: ProviderKind, enabled: boolean, disconnect = false) {
    const provider = this.provider(kind);
    if (disconnect) {
      const forgetting = this.forgetSecret(`provider:${kind}`);
      this.repositoryLists.delete(kind);
      this.updateProvider(kind, { account: null, enabled: false, error: null });
      this.save();
      await forgetting;
    } else {
      if (enabled && !provider.account)
        throw new InputError("Connect the provider before enabling repository scans.");
      this.updateProvider(kind, { enabled });
      this.save();
    }
    return this.snapshot();
  }
  async repositories(kind: ProviderKind) {
    if (!this.provider(kind).enabled)
      throw new InputError("Connect and enable this provider first.");
    try {
      const repositories = await listRepositories(
        kind,
        await this.secret(`provider:${kind}`),
        this.fetcher,
        this.shutdown.signal,
      );
      this.repositoryLists.set(kind, repositories);
      this.updateProvider(kind, { checkedAt: now(), error: null });
      this.save();
      return repositories;
    } catch {
      this.updateProvider(kind, {
        error:
          "Repository discovery failed. Check read permissions, authentication, and the provider rate limit.",
      });
      this.save();
      throw new InputError(this.provider(kind).error!);
    }
  }
  async selectRepository(
    kind: ProviderKind,
    repositoryId: string,
    ref: string | undefined,
    mode: "maintained" | "watch",
  ) {
    const repos = this.repositoryLists.get(kind) ?? (await this.repositories(kind));
    const repo = repos.find((r) => r.id === repositoryId);
    if (!repo || !this.provider(kind).enabled)
      throw new InputError("Choose a repository from this connected provider.");
    const branch = ref?.trim() || repo.defaultBranch;
    if (branch.length > 200 || Array.from(branch).some((char) => char.charCodeAt(0) < 32))
      throw new InputError("Invalid branch or ref.");
    return this.coordinator.addRepository(
      {
        provider: kind,
        repositoryId: repo.id,
        name: repo.name,
        ref: branch,
        commit: null,
        url: repo.url,
      },
      mode,
      this.state.preferences.automaticRepositoryScans,
    );
  }
  private async inspect(project: Project, signal?: AbortSignal) {
    if (project.repository) {
      const provider = this.provider(project.repository.provider);
      if (!provider.enabled || !provider.account)
        throw new InputError(
          "This repository provider is disconnected or paused; previous evidence is retained.",
        );
      return inspectRepository(
        project,
        await this.secret(`provider:${provider.kind}`),
        this.fetcher,
        signal,
      );
    }
    const result = await inspectProject(project.path, signal);
    // A failed inspection keeps the last recorded context, and says so; only turning Git context off
    // clears it.
    if (this.state.preferences.gitEnabled) {
      const git = await inspectGit(project.path, signal);
      if (!git && project.git)
        result.coverage.push(
          "Git context could not be refreshed; the last recorded context is shown.",
        );
      result.git = git ?? project.git;
    }
    return result;
  }
  async checkUpdate() {
    if (this.update.status === "checking") return this.snapshot();
    this.update = { ...this.update, status: "checking", error: null };
    try {
      const text = await readSource(
        "https://api.github.com/repos/Sandesh-Solabannavar/versionstead/releases/latest",
        {
          fetcher: this.fetcher,
          missing: true,
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
          signal: this.shutdown.signal,
          limit: 1024 * 1024,
        },
      );
      if (text === null)
        this.update = {
          ...this.update,
          status: "unpublished",
          checkedAt: now(),
          latestVersion: null,
          releaseUrl: null,
          notes: null,
        };
      else {
        const release = object(JSON.parse(text));
        const version =
          typeof release.tag_name === "string"
            ? semver.valid(release.tag_name.replace(/^v/, ""))
            : null;
        if (
          !version ||
          semver.prerelease(version) ||
          release.draft === true ||
          release.prerelease === true ||
          typeof release.html_url !== "string" ||
          !release.html_url.startsWith(
            "https://github.com/Sandesh-Solabannavar/versionstead/releases/tag/",
          )
        )
          throw new Error();
        this.update = {
          ...this.update,
          status: semver.gt(version, this.update.currentVersion) ? "available" : "current",
          latestVersion: version,
          releaseUrl: release.html_url,
          notes: typeof release.body === "string" ? release.body.slice(0, 20000) : null,
          checkedAt: now(),
        };
      }
    } catch {
      this.update = {
        ...this.update,
        status: "failed",
        checkedAt: now(),
        error:
          "Release information could not be verified. Check the network or GitHub rate limit and retry.",
      };
    }
    this.nextUpdate = Date.now() + 86400000;
    return this.snapshot();
  }
  async changeSharing(enabled: boolean, address?: string, port?: number) {
    return this.serializeSharing(async () => {
      if (this.peerServer) {
        await this.peerServer.close();
        this.peerServer = null;
      }
      this.invitation = null;
      if (!enabled) {
        this.state.sharing = { ...this.state.sharing, enabled: false, error: null };
        this.save();
        return this.snapshot();
      }
      try {
        await this.enableSharing(
          address ?? this.state.sharing.address,
          port ?? this.state.sharing.port,
        );
      } catch (error) {
        this.state.sharing = {
          ...this.state.sharing,
          enabled: false,
          error: this.sharingFailure(
            error,
            "Could not start HTTPS sharing. Choose an address assigned to this PC and an unused port.",
          ),
        };
        this.save();
        throw new InputError(this.state.sharing.error!);
      }
      return this.snapshot();
    });
  }
  private async enableSharing(address: string, port: number) {
    if (
      !privateAddress(address) ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      (!networkAddresses().includes(address) && !address.startsWith("127."))
    )
      throw new InputError(
        "Choose this PC's LAN or Tailscale address and a port between 1024 and 65535.",
      );
    let certificate: PeerCertificate;
    if (this.state.secrets.some((s) => s.key === "certificate"))
      certificate = peerCertificate(JSON.parse(await this.secret("certificate")));
    else {
      certificate = createPeerCertificate(address);
      await this.storeSecret("certificate", JSON.stringify(certificate));
    }
    this.peerServer = await startPeerServer({
      address,
      port,
      certificate,
      snapshot: () => this.coordinator.snapshot(),
      pair: (code, label, deviceId) => this.acceptPair(code, label, deviceId),
      authenticate: (token) => this.authenticateClient(token),
      scan: () => this.coordinator.requestScan({ target: "all" }),
      revoke: (id) => this.revokeClient(id),
    });
    this.state.sharing = {
      ...this.state.sharing,
      enabled: true,
      address,
      port: this.peerServer.port,
      fingerprint: certificate.fingerprint,
      error: null,
    };
    this.save();
  }
  createInvitation() {
    if (!this.peerServer || !this.state.sharing.fingerprint)
      throw new InputError("Enable HTTPS sharing on this PC first.");
    const code = randomBytes(32).toString("base64url");
    const expires = Date.now() + 5 * 60000;
    this.invitation = { code, expires, attempts: 0 };
    const device = this.coordinator.device;
    return {
      invitation: Buffer.from(
        JSON.stringify({
          version: 1,
          origin: `https://${this.state.sharing.address}:${this.state.sharing.port}`,
          fingerprint: this.state.sharing.fingerprint,
          deviceId: device.id,
          label: device.label,
          code,
        }),
      ).toString("base64url"),
      expiresAt: new Date(expires).toISOString(),
    };
  }
  private acceptPair(code: string, label: string, deviceId: string) {
    const invite = this.invitation;
    if (
      !invite ||
      invite.expires < Date.now() ||
      ++invite.attempts > 8 ||
      !/^[A-Za-z0-9_-]{43}$/.test(code) ||
      !equal(hash(code), hash(invite.code)) ||
      deviceId === this.coordinator.device.id
    )
      throw new InputError("The pairing invitation is invalid, expired, or already used.");
    if (this.state.sharing.clients.length >= 16)
      throw new InputError("Revoke an existing client before pairing another PC.");
    this.invitation = null;
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.state.sharing = {
      ...this.state.sharing,
      clients: [...this.state.sharing.clients, { id, label, deviceId, createdAt: now() }],
    };
    this.state.clientHashes = [...this.state.clientHashes, { id, hash: hash(token) }];
    this.save();
    return { token, deviceId: this.coordinator.device.id };
  }
  private authenticateClient(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.state.clientHashes.find((c) => equal(c.hash, hash(token)))?.id ?? null;
  }
  revokeClient(id: string) {
    this.state.clientHashes = this.state.clientHashes.filter((c) => c.id !== id);
    this.state.sharing = {
      ...this.state.sharing,
      clients: this.state.sharing.clients.filter((c) => c.id !== id),
    };
    this.save();
  }
  async sshHosts() {
    if (this.coordinator.mode !== "interactive")
      return {
        available: false,
        hosts: [],
        error:
          "SSH uses the monitoring host's keys and agent. Use Remote link over LAN or Tailscale for unattended monitoring.",
      };
    return discoverSshHosts();
  }
  private async transport(computer: { id: string; origin: string; ssh?: SshTarget | undefined }) {
    if (!computer.ssh) return {};
    if (this.coordinator.mode !== "interactive")
      throw new InputError(
        "SSH requires the owner-session monitoring host. Use a LAN or Tailscale Remote link for unattended access.",
      );
    let pending = this.tunnels.get(computer.id);
    if (pending && !(await pending).alive()) {
      this.tunnels.delete(computer.id);
      pending = undefined;
    }
    if (!pending) {
      pending = startSshTunnel(computer.ssh, computer.origin, this.shutdown.signal);
      this.tunnels.set(computer.id, pending);
      void pending.catch(() => {
        if (this.tunnels.get(computer.id) === pending) this.tunnels.delete(computer.id);
      });
    }
    return { tunnelPort: (await pending).port };
  }
  private async closeTunnel(id: string) {
    const pending = this.tunnels.get(id);
    this.tunnels.delete(id);
    if (pending)
      await pending.then(
        (t) => t.close(),
        () => {},
      );
  }
  async changeComputer(id: string, enabled: boolean) {
    if (!this.state.computers.some((c) => c.id === id))
      throw new InputError("This PC is no longer connected.");
    this.state.computers = this.state.computers.map((c) => (c.id === id ? { ...c, enabled } : c));
    this.save();
    if (!enabled) await this.closeTunnel(id);
    else await this.refreshComputer(id);
    return this.snapshot();
  }
  async pairComputer(invitation: string, ssh?: SshTarget) {
    let data;
    try {
      data = parsePairingInvitation(invitation).identity;
    } catch {
      throw new InputError("Paste a valid Versionstead pairing link or code from the other PC.");
    }
    if (ssh) validateSshTarget(ssh);
    if (data.deviceId === this.coordinator.device.id)
      throw new InputError("This invitation belongs to this PC. Create it on the other PC.");
    if (this.state.computers.some((c) => c.deviceId === data.deviceId))
      throw new InputError("This PC is already connected.");
    if (this.state.computers.length >= 8)
      throw new InputError("A maximum of eight connected computers is supported.");
    const origin = peerOrigin(data.origin);
    const local = this.coordinator.device;
    const id = randomUUID();
    // Verify OS-backed storage before consuming the remote one-time invitation.
    await this.requireCredentialStorage();
    let response;
    try {
      response = object(
        await this.peer(origin, data.fingerprint, "/pair", {
          ...(await this.transport({ id, origin, ...(ssh ? { ssh } : {}) })),
          body: { code: data.code, label: local.label, deviceId: local.id },
          signal: this.shutdown.signal,
        }),
      );
      if (
        response.deviceId !== data.deviceId ||
        typeof response.token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(response.token)
      )
        throw new InputError("The paired PC returned an unexpected identity.");
      await this.storeSecret(`computer:${id}`, response.token);
      this.state.computers = [
        ...this.state.computers,
        {
          id,
          enabled: true,
          ...(ssh ? { ssh } : {}),
          label: data.label,
          origin,
          fingerprint: data.fingerprint,
          deviceId: data.deviceId,
          checkedAt: null,
          error: null,
          snapshot: null,
          snapshotDigest: null,
        },
      ];
      this.save();
    } catch (error) {
      await this.closeTunnel(id);
      throw error;
    }
    await this.refreshComputer(id);
    return this.snapshot();
  }
  async refreshComputer(id: string) {
    const computer = this.state.computers.find((candidate) => candidate.id === id);
    if (!computer) throw new InputError("This PC is no longer connected.");
    if (computer.enabled === false)
      throw new InputError("Enable this environment before refreshing or scanning it.");
    try {
      const nonce = randomBytes(32).toString("base64url");
      const evidence = decodeRemoteEvidence(
        await this.peer(computer.origin, computer.fingerprint, "/evidence", {
          ...(await this.transport(computer)),
          token: await this.secret(`computer:${id}`),
          nonce,
          signal: this.shutdown.signal,
        }),
      );
      if (evidence.nonce !== nonce || evidence.snapshot.device.id !== computer.deviceId)
        throw new Error();
      // Evidence the digest says is unchanged keeps the snapshot already held.
      const snapshotDigest = evidenceDigest(evidence.snapshot);
      this.state.computers = this.state.computers.map((c) =>
        c.id === id && c.enabled !== false
          ? {
              ...c,
              ...(snapshotDigest === c.snapshotDigest
                ? {}
                : { snapshot: evidence.snapshot, snapshotDigest }),
              checkedAt: now(),
              error: null,
            }
          : c,
      );
    } catch (error) {
      const message =
        error instanceof CredentialStorageUnavailable
          ? `${error.message} Last received evidence is retained.`
          : "This PC is unreachable, its certificate changed, or pairing was revoked. Last received evidence is retained.";
      this.state.computers = this.state.computers.map((c) =>
        c.id === id && c.enabled !== false ? { ...c, error: message } : c,
      );
    }
    if (!this.shutdown.signal.aborted) this.save();
    return this.snapshot();
  }
  async scanComputer(id: string) {
    const c = this.state.computers.find((computer) => computer.id === id);
    if (!c) throw new InputError("This PC is no longer connected.");
    if (c.enabled === false) throw new InputError("Enable this environment before scanning it.");
    decodeAcceptedResponse(
      await this.peer(c.origin, c.fingerprint, "/scan", {
        ...(await this.transport(c)),
        token: await this.secret(`computer:${id}`),
        body: {},
        signal: this.shutdown.signal,
      }),
    );
    return this.refreshComputer(id);
  }
  async removeComputer(id: string) {
    const c = this.state.computers.find((computer) => computer.id === id);
    if (!c) throw new InputError("This PC is no longer connected.");
    try {
      await this.peer(c.origin, c.fingerprint, "/revoke", {
        ...(await this.transport(c)),
        token: await this.secret(`computer:${id}`),
        body: {},
        signal: this.shutdown.signal,
      });
    } catch {
      /* Revoke the client on the host PC if it is currently unreachable. */
    }
    await this.closeTunnel(id);
    const forgetting = this.forgetSecret(`computer:${id}`);
    this.state.computers = this.state.computers.filter((computer) => computer.id !== id);
    this.save();
    await forgetting;
    return this.snapshot();
  }
  // Never rejects: the timer chain has no handler, and one PC must not stop the others.
  private async poll() {
    if (this.shutdown.signal.aborted) return;
    // A PC can be removed or disabled while an earlier one is awaited, so look each up again.
    for (const id of this.state.computers.map((c) => c.id)) {
      if (this.shutdown.signal.aborted) break;
      const computer = this.state.computers.find((c) => c.id === id);
      if (!computer || computer.enabled === false) continue;
      // refreshComputer records its failures on the PC record; nothing else needs surfacing here.
      await this.refreshComputer(id).catch(() => {});
    }
    if (this.state.preferences.automaticAppUpdateChecks && Date.now() > this.nextUpdate)
      await this.checkUpdate().catch(() => {});
    // A listener that could not start (for example, a keyring still locked at boot) is retried here.
    await this.serializeSharing(async () => {
      if (!this.state.sharing.enabled || this.peerServer || this.shutdown.signal.aborted) return;
      try {
        await this.enableSharing(this.state.sharing.address, this.state.sharing.port);
      } catch (error) {
        const message = this.sharingFailure(error, restartFailure);
        if (message !== this.state.sharing.error) {
          this.state.sharing = { ...this.state.sharing, error: message };
          this.save();
        }
      }
    }).catch(() => {});
  }
  async close() {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    clearInterval(this.timer);
    await this.polling;
    await this.sharingWork;
    await Promise.all([...this.tunnels.keys()].map((id) => this.closeTunnel(id)));
    if (this.peerServer) await this.peerServer.close();
  }
}
