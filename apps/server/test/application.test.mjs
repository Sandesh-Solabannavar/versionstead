import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as Schema from "effect/Schema";
import { MonitoringSnapshot } from "@versionstead/contracts/monitoring";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { ApplicationService } from "../dist/application.js";
import { startServer } from "../dist/server.js";
import {
  listRepositories,
  providerAccount,
  inspectRepository,
} from "../dist/adapters/repositories.js";
import {
  createPeerCertificate,
  peerRequest,
  peerOrigin,
  sharedEvidence,
} from "../dist/adapters/paired-computers.js";
import {
  decodeApplicationSnapshot,
  decodeComputerSnapshot,
} from "@versionstead/contracts/application";
import { runTool, toolExecutable, inspectGit } from "../dist/adapters/development-tools.js";

const sha = "a".repeat(40);
const files = {
  "package.json": JSON.stringify({
    name: "read-only-fixture",
    scripts: { install: "never-execute" },
    dependencies: { example: "^1.0.0" },
  }),
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { example: "^1.0.0" } },
      "node_modules/example": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
      },
    },
  }),
};
const response = (value) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function providerFixture() {
  const requests = [];
  let failFiles = false;
  let failAuth = false;
  let holdAuth = null;
  let release = null;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url: url.href, headers: init.headers });
    assert(["api.github.com", "gitlab.com"].includes(url.hostname));
    assert.equal(init.redirect, "error");
    const kind = url.hostname === "api.github.com" ? "github" : "gitlab";
    if (url.pathname.endsWith("/user")) {
      if (holdAuth && kind === "github") await holdAuth;
      if (failAuth) return new Response("denied", { status: 401 });
      return response(
        kind === "github" ? { login: "fixture-owner" } : { username: "fixture-owner" },
      );
    }
    if (url.pathname.endsWith("/user/repos"))
      return response(
        [1, 2].map((id) => ({
          id,
          full_name: `fixture/repo-${id}`,
          default_branch: "main",
          private: true,
        })),
      );
    if (url.pathname === "/api/v4/projects")
      return response([
        {
          id: 1,
          path_with_namespace: "fixture/repo-1",
          default_branch: "main",
          visibility: "private",
        },
      ]);
    if (url.pathname.endsWith("/releases/latest"))
      return release ? response(release) : new Response("", { status: 404 });
    if (url.pathname.includes("/commits/"))
      return response(kind === "github" ? { sha } : { id: sha });
    if (url.pathname.includes("/contents/") || url.pathname.includes("/repository/files/")) {
      assert.equal(
        url.searchParams.get("ref"),
        sha,
        "Every file must be read at the resolved immutable commit",
      );
      if (failFiles) return new Response("denied", { status: 403 });
      const name = decodeURIComponent(
        url.pathname.split(kind === "github" ? "/contents/" : "/repository/files/")[1],
      );
      const content = files[name];
      if (!content) return new Response("", { status: 404 });
      return kind === "github"
        ? new Response(content)
        : response({
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
            file_path: name,
            commit_id: sha,
          });
    }
    throw new Error(`Unexpected fixture route: ${url.pathname}`);
  };
  return {
    fetcher,
    requests,
    failAuth: (value) => {
      failAuth = value;
    },
    holdAuth: (value) => {
      holdAuth = value;
    },
    fail: () => {
      failFiles = true;
    },
    setRelease: (value) => {
      release = value;
    },
  };
}
const project = (provider = "github") => ({
  id: randomUUID(),
  name: "fixture/repo-1",
  path: `https://${provider}.com/fixture/repo-1`,
  mode: "maintained",
  packageManager: "unknown",
  manifestPath: null,
  lockfilePath: null,
  evidence: {
    status: "not-scanned",
    lastAttempt: null,
    lastSuccess: null,
    coverage: [],
    errors: [],
  },
  dependencies: [],
  createdAt: new Date().toISOString(),
  repository: {
    provider,
    repositoryId: "1",
    name: "fixture/repo-1",
    ref: "feature/test",
    commit: null,
    url: `https://${provider}.com/fixture/repo-1`,
  },
});
const temporaryPaths = new WeakMap();
async function cleanupTemporary(t) {
  for (const path of temporaryPaths.get(t) ?? []) {
    assert(path.startsWith(join(tmpdir(), "versionstead-application-")));
    await rm(path, { recursive: true, force: true });
  }
}
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "versionstead-application-"));
  temporaryPaths.set(t, [...(temporaryPaths.get(t) ?? []), path]);
  return path;
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for application state.");
}
async function freePort() {
  const server = createHttpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("GitHub and GitLab use the shared read-only parser with immutable commit provenance", async () => {
  for (const kind of ["github", "gitlab"]) {
    const fixture = providerFixture();
    assert.equal(await providerAccount(kind, "read-token", fixture.fetcher), "fixture-owner");
    const list = await listRepositories(kind, "read-token", fixture.fetcher);
    assert.equal(list[0].id, "1");
    const inputs = await inspectRepository(project(kind), "read-token", fixture.fetcher);
    assert.equal(inputs.repositoryCommit, sha);
    assert.equal(inputs.dependencies[0].resolved, "1.0.0");
    assert.equal(inputs.dependencies[0].name, "example");
    assert.equal(inputs.errors.length, 0);
    assert.match(inputs.coverage[0], /read-only.*commit/);
    assert(
      fixture.requests.every(
        (r) => r.headers[kind === "github" ? "Authorization" : "PRIVATE-TOKEN"],
      ),
    );
    fixture.fail();
    await assert.rejects(
      inspectRepository(project(kind), "read-token", fixture.fetcher),
      /read permission/,
    );
    await assert.rejects(
      inspectRepository(
        { ...project(kind), repository: { ...project(kind).repository, name: "../../untrusted" } },
        "read-token",
        fixture.fetcher,
      ),
      /identity/,
    );
  }
});

test("repository discovery reads every page and does not silently truncate accessible repositories", async () => {
  let pages = 0;
  const fetcher = async (input) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get("page"));
    pages++;
    return response(
      Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => ({
        id: (page - 1) * 100 + i + 1,
        full_name: `fixture/repo-${(page - 1) * 100 + i + 1}`,
        default_branch: "main",
        private: false,
      })),
    );
  };
  assert.equal((await listRepositories("github", "token", fetcher)).length, 102);
  assert.equal(pages, 2);
});

test("application settings routes require local authentication and validate mutations", async (t) => {
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const fixture = providerFixture();
  const app = await ApplicationService.create(core, fixture.fetcher);
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({
    port: 0,
    monitoring: core,
    authToken: token,
    application: app,
  });
  t.after(async () => {
    await server.close();
    await core.close();
    await cleanupTemporary(t);
  });
  const call = (path, body, headers = {}) =>
    fetch(server.origin + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await call("/api/application", undefined, { Authorization: "" })).status, 401);
  assert.equal((await call("/api/application/computers/refresh", { id: "bad-id" })).status, 400);
  assert.equal(
    (await call("/api/application/providers/connect", { kind: "bitbucket", token: "invalid" }))
      .status,
    400,
  );
  assert.equal(
    (await call("/api/application", undefined, { Origin: "https://attacker.invalid" })).status,
    403,
  );
  const state = decodeApplicationSnapshot(await (await call("/api/application")).json());
  const status = await call("/api/status");
  assert.equal(status.status, 200);
  assert.equal((await status.json()).capabilities.remoteAgents, true);
  assert.equal(state.preferences.automaticRepositoryScans, true);
  assert(!JSON.stringify(state).includes("secrets"));
  const result = await fetch(server.origin + "/api/application/preferences", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ automaticRepositoryScans: false }),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).preferences.automaticRepositoryScans, false);
  assert.equal((await app.checkUpdate()).update.status, "unpublished");
  fixture.setRelease({
    tag_name: "v0.2.0",
    html_url: "https://github.com/Sandesh-Solabannavar/versionstead/releases/tag/v0.2.0",
    body: "Fixture release",
  });
  assert.equal((await app.checkUpdate()).update.status, "available");
  fixture.setRelease({ tag_name: "v0.2.0", html_url: "https://attacker.invalid/installer" });
  assert.equal((await app.checkUpdate()).update.status, "failed");
});

test(
  "connecting a provider where OS-backed credential storage is unsupported is a 400 that says why",
  { skip: process.platform === "win32" },
  async (t) => {
    const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
    core.changeSettings({ paused: true });
    const app = await ApplicationService.create(core, providerFixture().fetcher);
    const token = randomBytes(32).toString("base64url");
    const server = await startServer({
      port: 0,
      monitoring: core,
      authToken: token,
      application: app,
    });
    t.after(async () => {
      await server.close();
      await core.close();
      await cleanupTemporary(t);
    });
    const refused = await fetch(`${server.origin}/api/application/providers/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "github", token: "read-token" }),
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /supported on Windows only/);
  },
);

test(
  "selected repositories scan automatically; protected credentials and retained evidence survive restart",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dataDir = await temporary(t);
    let core = new MonitoringCoordinator({ dataDir, lookup: false });
    let app;
    const fixture = providerFixture();
    t.after(async () => {
      await app?.close();
      await core.close();
      await cleanupTemporary(t);
    });
    app = await ApplicationService.create(core, fixture.fetcher);
    const token = "fixture-secret-" + randomBytes(32).toString("base64url");
    await app.connectProvider("github", token);
    assert.equal(
      core.snapshot().projects.length,
      0,
      "Connecting must not scan or select any repository",
    );
    const added = await app.selectRepository("github", "1", undefined, "maintained");
    await waitFor(
      () =>
        core.snapshot().projects[0]?.repository.commit === sha &&
        core.snapshot().scanProgress.active === null,
    );
    assert.equal(core.snapshot().projects.length, 1);
    assert.equal(core.snapshot().projects[0].dependencies.length, 1);
    assert.equal(core.snapshot().projects[0].repository.ref, "main");
    assert.equal(core.snapshot().projects[0].evidence.status, "partial");
    assert(!JSON.stringify(app.snapshot()).includes(token));
    assert(!JSON.stringify(core.readApplication()).includes(token));
    assert(
      !Buffer.from(await readFile(join(dataDir, "monitoring.sqlite"))).includes(Buffer.from(token)),
      "Plaintext credentials must not be in SQLite",
    );
    await app.changePreferences({ automaticRepositoryScans: false });
    await app.selectRepository("github", "2", undefined, "watch");
    assert.equal(core.snapshot().projects[1].evidence.status, "not-scanned");
    const evidence = core.snapshot().projects[0];
    fixture.fail();
    core.requestScan({ target: "projects", projectId: added.id });
    await waitFor(() => core.snapshot().projects[0].evidence.status === "failed");
    assert.deepEqual(core.snapshot().projects[0].dependencies, evidence.dependencies);
    assert.equal(core.snapshot().projects[0].evidence.lastSuccess, evidence.evidence.lastSuccess);
    assert.equal(core.snapshot().projects[0].repository.commit, sha);
    await app.close();
    await core.close();
    core = new MonitoringCoordinator({ dataDir, lookup: false });
    app = await ApplicationService.create(core, fixture.fetcher);
    assert.equal(app.snapshot().providers[0].account, "fixture-owner");
    assert.equal((await app.repositories("github")).length, 2);
    assert.equal(app.snapshot().preferences.automaticRepositoryScans, false);
    app.changeProvider("github", false, true);
    assert.equal(core.readApplication().secrets.length, 0);
    assert.equal(core.snapshot().projects.length, 2);
  },
);

test(
  "source control refresh rechecks authentication, retains errors and pause state, and cannot undo disconnect",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dataDir = await temporary(t);
    const core = new MonitoringCoordinator({ dataDir, lookup: false });
    core.changeSettings({ paused: true });
    const fixture = providerFixture();
    const app = await ApplicationService.create(core, fixture.fetcher);
    t.after(async () => {
      await app.close();
      await core.close();
      await cleanupTemporary(t);
    });
    await app.connectProvider("github", "fixture-github-token");
    await app.connectProvider("gitlab", "fixture-gitlab-token");
    app.changeProvider("gitlab", false);
    fixture.requests.length = 0;
    await app.readSnapshot();
    assert.equal(
      fixture.requests.length,
      0,
      "Routine polling must not repeatedly probe provider authentication",
    );
    fixture.failAuth(true);
    const failed = await app.discover(true);
    assert.equal(
      fixture.requests.filter((r) => new URL(r.url).pathname.endsWith("/user")).length,
      2,
    );
    assert(failed.providers.every((p) => p.account === "fixture-owner" && p.error && p.checkedAt));
    assert.equal(failed.providers.find((p) => p.kind === "gitlab").enabled, false);
    assert.equal(core.snapshot().projects.length, 0);
    fixture.failAuth(false);
    const recovered = await app.discover(true);
    assert(recovered.providers.every((p) => p.error === null));
    assert.equal(recovered.providers.find((p) => p.kind === "gitlab").enabled, false);
    assert(
      fixture.requests.every((r) => new URL(r.url).pathname.endsWith("/user")),
      "Refresh must not discover or scan unselected repositories",
    );
    let release;
    fixture.holdAuth(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const before = fixture.requests.length;
    const pending = app.discover(true);
    await waitFor(() => fixture.requests.length > before);
    app.changeProvider("github", false, true);
    release();
    const state = await pending;
    assert.equal(state.providers.find((p) => p.kind === "github").account, null);
    assert.equal(state.providers.find((p) => p.kind === "github").enabled, false);
    assert.equal(core.readApplication().secrets.length, 1);
  },
);

test(
  "two HTTPS coordinators pair once, retain remote evidence offline, and revoke access",
  { skip: process.platform !== "win32" },
  async (t) => {
    const hostCore = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
    const clientCore = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
    hostCore.changeSettings({ paused: true });
    clientCore.changeSettings({ paused: true });
    let host = await ApplicationService.create(hostCore);
    let client = await ApplicationService.create(clientCore);
    t.after(async () => {
      await client.close();
      await host.close();
      await clientCore.close();
      await hostCore.close();
      await cleanupTemporary(t);
    });
    const folder = join(await temporary(t), "private-project");
    await mkdir(folder);
    await writeFile(join(folder, "package.json"), files["package.json"]);
    await writeFile(join(folder, "package-lock.json"), files["package-lock.json"]);
    await hostCore.addProject({ path: folder, mode: "maintained" });
    const port = await freePort();
    await host.changeSharing(true, "127.0.0.1", port);
    const invitation = host.createInvitation();
    const paired = await client.pairComputer(invitation.invitation);
    assert.equal(paired.computers.length, 1);
    const remote = paired.computers[0];
    const evidence = () => client.computerSnapshot(remote.id).snapshot;
    assert(!("snapshot" in remote), "The application read carries no remote snapshot");
    assert.equal(evidence().device.id, hostCore.snapshot().device.id);
    assert(!JSON.stringify(evidence()).includes(folder));
    assert.equal(host.snapshot().sharing.clients.length, 1);
    await assert.rejects(client.pairComputer(invitation.invitation), /already connected/);
    const decoded = JSON.parse(Buffer.from(invitation.invitation, "base64url").toString("utf8"));
    await assert.rejects(
      peerRequest(decoded.origin, decoded.fingerprint, "/pair", {
        body: { code: decoded.code, label: "Replay", deviceId: randomUUID() },
      }),
      /rejected access/,
    );
    await client.scanComputer(remote.id);
    await waitFor(
      () =>
        hostCore.snapshot().history.length >= 2 && hostCore.snapshot().scanProgress.active === null,
    );
    await client.refreshComputer(remote.id);
    const received = evidence();
    assert(received.projects[0].dependencies.length);
    await client.close();
    await host.close();
    host = await ApplicationService.create(hostCore);
    client = await ApplicationService.create(clientCore);
    assert.match(client.snapshot().computers[0].error, /not been checked/);
    await client.refreshComputer(remote.id);
    assert.equal(client.snapshot().computers[0].error, null);
    assert.deepEqual(evidence(), received);
    await host.changeSharing(false);
    await client.refreshComputer(remote.id);
    assert.deepEqual(evidence(), received);
    assert.match(client.snapshot().computers[0].error, /retained/);
    await host.changeSharing(true, "127.0.0.1", port);
    await client.refreshComputer(remote.id);
    assert.equal(client.snapshot().computers[0].error, null);
    const old = host.snapshot().sharing.clients[0];
    host.revokeClient(old.id);
    await client.refreshComputer(remote.id);
    assert.match(client.snapshot().computers[0].error, /revoked/);
    assert.deepEqual(evidence(), received);
    await client.removeComputer(remote.id);
    assert.equal(client.snapshot().computers.length, 0);
    assert(
      !clientCore.readApplication().secrets.some((secret) => secret.key.startsWith("computer:")),
    );
  },
);

test(
  "certificate pins are checked before sending credentials and peer endpoints reject browser/admin access",
  { skip: process.platform !== "win32" },
  async (t) => {
    const certificate = await createPeerCertificate();
    let requests = 0;
    const server = createHttpsServer(
      { pfx: Buffer.from(certificate.pfx, "base64"), passphrase: certificate.password },
      (req, res) => {
        requests++;
        res.end("{}");
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `https://127.0.0.1:${server.address().port}`;
    await assert.rejects(
      peerRequest(origin, "b".repeat(64), "/evidence", {
        token: randomBytes(32).toString("base64url"),
        nonce: randomBytes(32).toString("base64url"),
      }),
      /verify its certificate/,
    );
    assert.equal(
      requests,
      0,
      "The wrong certificate must never receive HTTP headers or credentials",
    );
    assert.throws(() => peerOrigin("https://example.com:4389"));
    assert.throws(() => peerOrigin("http://192.168.1.2:4389"));
    assert.throws(() => peerOrigin("https://127.0.0.1:4389/admin"));
    const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
    core.changeSettings({ paused: true });
    const app = await ApplicationService.create(core);
    t.after(async () => {
      await app.close();
      await core.close();
      await cleanupTemporary(t);
    });
    await app.changeSharing(true, "127.0.0.1", await freePort());
    const state = app.snapshot();
    const get = (path, headers = {}) =>
      new Promise((resolve, reject) => {
        httpsRequest(
          `https://127.0.0.1:${state.sharing.port}${path}`,
          { rejectUnauthorized: false, headers },
          (reply) => {
            reply.resume();
            resolve(reply.statusCode);
          },
        )
          .on("error", reject)
          .end();
      });
    assert.equal(await get("/evidence"), 401);
    assert.equal(await get("/api/application", { Origin: "https://attacker.invalid" }), 403);
    assert.equal(await get("/api/shutdown"), 401);
    assert.equal(sharedEvidence(core.snapshot()).notifications.length, 0);
    const local = core.snapshot();
    const input = await inspectRepository(project(), "fixture-token", providerFixture().fetcher);
    const dependency = {
      ...input.dependencies[0],
      origin: "git",
      requested: "git+https://owner:fixture-secret@example.invalid/repository",
    };
    local.projects = [
      {
        ...project(),
        repository: undefined,
        path: "C:/private/project",
        manifestPath: "C:/private/project/package.json",
        lockfilePath: "C:/private/project/package-lock.json",
        dependencies: [dependency],
      },
    ];
    const shared = sharedEvidence(local);
    assert(!JSON.stringify(shared).includes("C:/private"));
    assert(!JSON.stringify(shared).includes("fixture-secret"));
    assert.equal(shared.projects[0].dependencies[0].origin, "git");
  },
);

test("shared evidence leaves out the feature marker, so a PC on the previous build still decodes it", async (t) => {
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  t.after(async () => {
    await core.close();
    await cleanupTemporary(t);
  });
  // The receiving side of the previous build (marker v7) accepted only the markers it knew.
  const previousBuild = Schema.decodeUnknownSync(
    Schema.Struct({
      ...MonitoringSnapshot.fields,
      features: Schema.optional(
        Schema.Literals(
          [1, 2, 3, 4, 5, 6, 7].map((version) => `settings-repositories-connections-v${version}`),
        ),
      ),
    }),
  );
  const local = core.snapshot();
  assert.equal(local.features, "settings-repositories-connections-v8");
  assert.throws(() => previousBuild(local), "The marker alone would make that PC refuse it");
  const shared = sharedEvidence(local);
  assert(!("features" in shared), "No receiving PC reads a remote's marker");
  // Evidence crosses the network as JSON.
  assert.doesNotThrow(() => previousBuild(JSON.parse(JSON.stringify(shared))));
});

function seedApplication(core, { computers = [], automaticAppUpdateChecks = false } = {}) {
  core.readApplication(); // Creates the table the first write needs.
  core.writeApplication({
    preferences: { gitEnabled: false, automaticRepositoryScans: false, automaticAppUpdateChecks },
    providers: ["github", "gitlab"].map((kind) => ({
      kind,
      enabled: false,
      account: null,
      checkedAt: null,
      error: null,
    })),
    computers,
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
  });
}
const pairedComputer = (label) => ({
  id: randomUUID(),
  label,
  origin: "https://127.0.0.1:4389",
  fingerprint: "a".repeat(64),
  deviceId: randomUUID(),
  checkedAt: null,
  error: null,
  snapshot: null,
  enabled: true,
});

test("a PC removed or disabled while a poll awaits another never rejects the poll", async (t) => {
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const [first, removed, disabled, last] = ["first", "removed", "disabled", "last"].map(
    pairedComputer,
  );
  seedApplication(core, { computers: [first, removed, disabled, last] });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  const refreshed = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const refresh = app.refreshComputer.bind(app);
  app.refreshComputer = async (id) => {
    refreshed.push(id);
    if (id === first.id) {
      await held;
      throw new Error("unexpected refresh failure");
    }
    return refresh(id);
  };
  t.mock.timers.tick(30000);
  const polling = app.polling;
  assert.deepEqual(refreshed, [first.id], "The poll is awaiting the first PC");
  await app.removeComputer(removed.id);
  await app.changeComputer(disabled.id, false);
  release();
  await polling;
  assert.deepEqual(
    refreshed,
    [first.id, last.id],
    "Removed and disabled PCs are skipped, and one failing PC does not stop the next",
  );
  const computers = app.snapshot().computers;
  assert.deepEqual(
    computers.map((c) => [c.label, c.enabled]),
    [
      ["first", true],
      ["disabled", false],
      ["last", true],
    ],
  );
  assert.match(
    computers.find((c) => c.id === last.id).error,
    /unreachable/,
    "refreshComputer still records per-PC failures for the UI",
  );
});

test("a failing app update check never rejects the poll", async (t) => {
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  seedApplication(core, { automaticAppUpdateChecks: true });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  let checks = 0;
  app.checkUpdate = async () => {
    checks++;
    throw new Error("unexpected update failure");
  };
  t.mock.timers.tick(30000);
  await app.polling;
  assert.equal(checks, 1);
});

// A paired PC whose evidence comes from a second coordinator through an injected peer, so a refresh
// needs neither HTTPS nor protected credentials and runs on every platform.
async function pairedApplication(t) {
  const remote = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  remote.changeSettings({ paused: true });
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const computer = { ...pairedComputer("remote"), deviceId: remote.device.id };
  seedApplication(core, { computers: [computer] });
  const peer = { offline: false };
  const opened = [];
  t.after(async () => {
    for (const app of opened) await app.close();
    await core.close();
    await remote.close();
    await cleanupTemporary(t);
  });
  const open = async () => {
    const app = await ApplicationService.create(
      core,
      undefined,
      async (_origin, _fingerprint, path, options = {}) => {
        assert.equal(path, "/evidence");
        if (peer.offline) throw new Error("offline");
        return { nonce: options.nonce, snapshot: sharedEvidence(remote.snapshot()) };
      },
    );
    // Pairing stores this token protected; the injected peer only needs the service to find one.
    app.plainSecrets.set(`computer:${computer.id}`, "fixture-token");
    opened.push(app);
    return app;
  };
  return { core, remote, computer, peer, open, app: await open() };
}

test("a refresh that brings the evidence already held is not saved, and a changed one is", async (t) => {
  const { app, core, remote, computer } = await pairedApplication(t);
  const writes = t.mock.method(core, "writeApplication");
  const saved = () => core.readApplication().computers[0];

  await app.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 1, "The first evidence is a durable change");
  const first = app.snapshot().computers[0];
  assert.match(first.snapshotDigest, /^[a-f0-9]{64}$/);
  assert(!("snapshot" in first), "The record the interface polls does not copy the evidence");
  assert.equal(saved().snapshot.device.id, remote.device.id);
  assert.equal(saved().checkedAt, first.checkedAt);

  await delay(20);
  await app.refreshComputer(computer.id);
  await app.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 1, "Identical evidence leaves the saved state alone");
  const unchanged = app.snapshot().computers[0];
  assert.equal(unchanged.snapshotDigest, first.snapshotDigest);
  assert(unchanged.checkedAt > first.checkedAt, "The time of the check still advances in memory");
  assert.equal(saved().checkedAt, first.checkedAt, "It is saved only along with a durable change");

  remote.changeSettings({ pcIntervalMinutes: 17 });
  await app.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 2, "Changed evidence is saved");
  assert.equal(saved().snapshot.settings.pcIntervalMinutes, 17);
  const changed = app.snapshot().computers[0];
  assert.notEqual(changed.snapshotDigest, first.snapshotDigest);
  assert.equal(saved().checkedAt, changed.checkedAt, "A save carries the latest check time");
  assert.equal(app.computerSnapshot(computer.id).snapshot.settings.pcIntervalMinutes, 17);
});

test("a failure that repeats is saved once, and so is the recovery that follows it", async (t) => {
  const { app, core, computer, peer } = await pairedApplication(t);
  await app.refreshComputer(computer.id);
  const received = app.computerSnapshot(computer.id);
  const writes = t.mock.method(core, "writeApplication");
  peer.offline = true;
  for (let attempt = 0; attempt < 3; attempt++) await app.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 1, "Only the first failure changes what is saved");
  assert.match(core.readApplication().computers[0].error, /unreachable.*retained/);
  const failed = app.computerSnapshot(computer.id);
  assert.deepEqual(failed.snapshot, received.snapshot, "Evidence is retained through the outage");
  assert.equal(failed.checkedAt, received.checkedAt, "so is the time it was received");
  assert.deepEqual(
    core.readApplication().computers[0].snapshot,
    JSON.parse(JSON.stringify(received.snapshot)),
    "and the saved copy is untouched by the failure",
  );
  peer.offline = false;
  await app.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 2, "Recovery clears the saved error");
  assert.equal(core.readApplication().computers[0].error, null);
  await app.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 2);
});

test("pausing a paired PC is saved and survives a restart", async (t) => {
  const { app, core, computer, open } = await pairedApplication(t);
  await app.changeComputer(computer.id, false);
  assert.equal(core.readApplication().computers[0].enabled, false);
  await app.close();
  const reopened = await open();
  assert.equal(reopened.snapshot().computers[0].enabled, false);
  await reopened.changeComputer(computer.id, true);
  assert.equal(core.readApplication().computers[0].enabled, true);
});

test("the evidence digest is the same after a restart, so only the cleared error is saved", async (t) => {
  const { app, core, computer, open } = await pairedApplication(t);
  await app.refreshComputer(computer.id);
  const before = app.snapshot().computers[0].snapshotDigest;
  await app.close();
  const reopened = await open();
  assert.equal(reopened.snapshot().computers[0].snapshotDigest, before);
  assert.match(reopened.snapshot().computers[0].error, /not been checked/);
  const writes = t.mock.method(core, "writeApplication");
  await reopened.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 1, "The error that restart set is cleared and saved");
  assert.equal(core.readApplication().computers[0].error, null);
  await reopened.refreshComputer(computer.id);
  assert.equal(writes.mock.callCount(), 1, "Evidence unchanged by the restart is not rewritten");
});

test("the polled application read carries no remote snapshot; the snapshot route returns one PC's evidence", async (t) => {
  const { app, core, remote, computer, peer } = await pairedApplication(t);
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({
    port: 0,
    monitoring: core,
    authToken: token,
    application: app,
  });
  t.after(() => server.close());
  const call = (path, init = {}, authorization = `Bearer ${token}`) =>
    fetch(server.origin + path, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: authorization },
    });
  const route = `/api/application/computers/${computer.id}/snapshot`;

  const empty = await call(route);
  assert.equal(empty.status, 200);
  const none = decodeComputerSnapshot(await empty.json());
  assert.deepEqual(
    [none.snapshotDigest, none.checkedAt, none.snapshot],
    [null, null, null],
    "A PC that has sent nothing has no evidence, digest, or check time",
  );
  assert.match(none.error, /not been checked/);

  await app.refreshComputer(computer.id);
  const polled = await (await call("/api/application")).text();
  assert(!polled.includes('"snapshot"'), "The polled read must not carry the remote snapshot");
  const listed = decodeApplicationSnapshot(JSON.parse(polled)).computers[0];
  assert.match(listed.snapshotDigest, /^[a-f0-9]{64}$/);
  const evidence = decodeComputerSnapshot(await (await call(route)).json());
  assert.equal(evidence.snapshot.device.id, remote.device.id);
  assert.equal(evidence.snapshotDigest, listed.snapshotDigest);
  assert.equal(evidence.checkedAt, listed.checkedAt);
  assert.equal(evidence.error, null);

  peer.offline = true;
  await app.refreshComputer(computer.id);
  const retained = decodeComputerSnapshot(await (await call(route)).json());
  assert.match(retained.error, /unreachable/);
  assert.equal(retained.snapshotDigest, evidence.snapshotDigest);
  assert.equal(retained.checkedAt, evidence.checkedAt, "Retained evidence keeps its age");
  assert.deepEqual(retained.snapshot, evidence.snapshot);

  assert.equal((await call(route, {}, "")).status, 401);
  assert.equal((await call(route, {}, `Bearer ${"x".repeat(43)}`)).status, 401);
  assert.equal((await call("/api/application/computers/not-an-id/snapshot")).status, 400);
  assert.equal((await call(`/api/application/computers/${randomUUID()}/snapshot`)).status, 404);
  assert.equal((await call(route, { method: "POST", body: "{}" })).status, 404);
});

test("tool discovery runs at startup and when asked, never because the interface polls", async (t) => {
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  // Startup probed the tools already, so the first read needs no discovery of its own.
  if (await toolExecutable("git"))
    assert.equal((await app.readSnapshot()).tools.git.available, true);
  const discover = t.mock.method(app, "discover");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (let poll = 0; poll < 5; poll++) {
    await app.readSnapshot();
    t.mock.timers.tick(61_000);
  }
  assert.equal(discover.mock.callCount(), 0, "Polling must not probe the tools again");
  await app.discover();
  assert.equal(discover.mock.callCount(), 1, "An explicit refresh still does");
});

test("a tool discovery that finishes after a later one never replaces its result", async (t) => {
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const answers = [];
  const tools = () => new Promise((resolve) => answers.push(resolve));
  const app = await ApplicationService.create(core, undefined, undefined, tools);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  const found = (version) => {
    const tool = { available: true, version };
    return { git: tool, github: tool, gitlab: tool, tailscale: tool, ssh: tool };
  };
  // answers[0] is the startup probe.
  const first = app.discover();
  const second = app.discover();
  answers[2](found("second"));
  assert.equal((await second).tools.git.version, "second");
  answers[1](found("first"));
  assert.equal((await first).tools.git.version, "second", "The older discovery finished last");
  answers[0](found("startup"));
  assert.equal((await app.readSnapshot()).tools.git.version, "second");
  // An older discovery that finishes first still applies until the later one arrives.
  const third = app.discover();
  const fourth = app.discover();
  answers[3](found("third"));
  assert.equal((await third).tools.git.version, "third");
  answers[4](found("fourth"));
  assert.equal((await fourth).tools.git.version, "fourth");
});

test("Git context never executes clean/process filters or inherited project overrides", async (t) => {
  if (!(await toolExecutable("git"))) return t.skip("Git is unavailable on this host.");
  const folder = await temporary(t);
  t.after(() => cleanupTemporary(t));
  await runTool("git", ["-c", "init.templateDir=", "init", folder]);
  const args = ["-c", "core.hooksPath=", "-C", folder];
  await writeFile(join(folder, ".gitattributes"), "tracked filter=fixture\n");
  await writeFile(join(folder, "tracked"), "original\n");
  await runTool("git", [...args, "add", "--", ".gitattributes", "tracked"]);
  await runTool("git", [
    ...args,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture",
  ]);
  const command = "node -e \"require('fs').writeFileSync('filter-ran','unsafe')\"";
  await runTool("git", [...args, "config", "filter.fixture.clean", command]);
  await runTool("git", [...args, "config", "filter.fixture.process", command]);
  await runTool("git", [...args, "config", "filter.fixture.required", "true"]);
  await writeFile(join(folder, "tracked"), "changed\n");
  const before = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = join(folder, "untrusted-override");
  try {
    const result = await inspectGit(folder);
    assert(result);
    assert.match(result.commit, /^[a-f0-9]{40}$/);
    assert.equal(result.dirty, true);
    await assert.rejects(readFile(join(folder, "filter-ran")), { code: "ENOENT" });
  } finally {
    if (before === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = before;
  }
});

async function commitFixture(folder) {
  const args = ["-c", "core.hooksPath=", "-C", folder];
  await runTool("git", ["-c", "init.templateDir=", "init", "--quiet", folder]);
  await runTool("git", [...args, "add", "--all"]);
  await runTool("git", [
    ...args,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  ]);
  return args;
}

test("Git status beyond the output bound reports a dirty tree instead of losing the context", async (t) => {
  if (!(await toolExecutable("git"))) return t.skip("Git is unavailable on this host.");
  const folder = await temporary(t);
  t.after(() => cleanupTemporary(t));
  // Each deleted tracked file is one porcelain line; together they pass runTool's 64 KiB bound.
  const names = Array.from(
    { length: 700 },
    (_, index) => `${String(index).padStart(4, "0")}-${"n".repeat(100)}`,
  );
  await Promise.all(names.map((name) => writeFile(join(folder, name), "x")));
  const args = await commitFixture(folder);
  await Promise.all(names.map((name) => rm(join(folder, name))));
  await assert.rejects(
    runTool("git", [...args, "status", "--porcelain", "--untracked-files=no"]),
    /could not complete/,
    "The fixture must exceed the output bound",
  );
  const result = await inspectGit(folder);
  assert(result);
  assert.match(result.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(result.dirty, true);
});

test("a failed Git inspection keeps the recorded Git context; turning Git context off still clears it", async (t) => {
  if (!(await toolExecutable("git"))) return t.skip("Git is unavailable on this host.");
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  const folder = await temporary(t);
  await writeFile(join(folder, "package.json"), files["package.json"]);
  await writeFile(join(folder, "package-lock.json"), files["package-lock.json"]);
  await commitFixture(folder);
  const added = await core.addProject({ path: folder, mode: "maintained" });
  const scanGit = async () => {
    const previous = core.snapshot().history[0]?.id;
    core.requestScan({ target: "projects", projectId: added.id });
    await waitFor(() => {
      const latest = core.snapshot().history[0];
      return latest?.id !== previous && latest?.status !== "scanning";
    });
    return core.snapshot().projects[0].git;
  };
  const retained = "Git context could not be refreshed; the last recorded context is shown.";
  const coverage = () => core.snapshot().projects[0].evidence.coverage;
  const recorded = await scanGit();
  assert.match(recorded.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(coverage().includes(retained), false, "A fresh context is current");
  // Without its repository directory, git can no longer inspect the folder.
  await rename(join(folder, ".git"), join(folder, ".git-away"));
  assert.deepEqual(await scanGit(), recorded);
  assert.ok(coverage().includes(retained), "Retained Git context must not read as current");
  await app.changePreferences({ gitEnabled: false });
  assert.equal(await scanGit(), undefined);
  assert.equal(coverage().includes(retained), false);
});

test("Git discovery follows the Git context preference: located but not run while it is off", async (t) => {
  if (!(await toolExecutable("git"))) return t.skip("Git is unavailable on this host.");
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  assert.match((await app.discover()).tools.git.version, /^git version/);
  await app.changePreferences({ gitEnabled: false });
  assert.deepEqual((await app.discover()).tools.git, { available: true, version: null });
  await app.changePreferences({ gitEnabled: true });
  assert.match((await app.discover()).tools.git.version, /^git version/);
});

test("changing the Git context preference refreshes the Git status, and no other preference does", async (t) => {
  if (!(await toolExecutable("git"))) return t.skip("Git is unavailable on this host.");
  const core = new MonitoringCoordinator({ dataDir: await temporary(t), lookup: false });
  core.changeSettings({ paused: true });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    await cleanupTemporary(t);
  });
  assert.match((await app.readSnapshot()).tools.git.version, /^git version/);
  // The version shown depends on whether Git may run, and polling no longer rediscovers it.
  const off = await app.changePreferences({ gitEnabled: false });
  assert.deepEqual(off.tools.git, { available: true, version: null });
  const on = await app.changePreferences({ gitEnabled: true });
  assert.match(on.tools.git.version, /^git version/);
  const discover = t.mock.method(app, "discover");
  await app.changePreferences({ automaticRepositoryScans: false });
  await app.changePreferences({ gitEnabled: true });
  assert.equal(
    discover.mock.callCount(),
    0,
    "Only a change of the Git preference probes the tools",
  );
});
