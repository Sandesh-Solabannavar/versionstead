import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { MonitoringStorage } from "../dist/storage.js";
import {
  inspectProject,
  inspectProjectFiles,
  InputError,
  isNetworkShare,
  readSelectedFile,
  selectDirectory,
} from "../dist/adapters/projects.js";
import { identity } from "../dist/adapters/projects.js";
import { createSourceCache, lookupDependencies } from "../dist/adapters/lookups.js";
import { ApplicationService } from "../dist/application.js";
import { inspectRepository } from "../dist/adapters/repositories.js";

async function temporary(t) {
  const path = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-monitoring-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function npmFixture(root, extra = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { install: "node -e \"require('node:fs').writeFileSync('executed','unsafe')\"" },
      dependencies: { alias: "npm:public-example@^1.0.0" },
      ...extra,
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } },
        "node_modules/alias": {
          name: "public-example",
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/public-example/-/public-example-1.0.0.tgz",
        },
        "node_modules/transitive": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/transitive/-/transitive-2.0.0.tgz",
        },
      },
    }),
  );
}

async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a scan.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function scan(coordinator, projectId) {
  const previous = coordinator.snapshot().history[0]?.id;
  coordinator.requestScan({ target: "projects", projectId });
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest?.id !== previous && latest?.status !== "scanning";
  });
}

// A global tool from the public npm registry with a newer release: This PC asks deps.dev about it.
const publicTool = {
  id: "global-tool",
  name: "public-example",
  packageId: "public-example",
  version: "1.0.0",
  manager: "npm",
  rootId: "npm-root",
  origin: "registry",
  source: "npm",
  scope: "user",
  channel: "stable",
  updateStatus: "available",
  availableVersion: "2.0.0",
};

test("npm aliases and transitive identities are preserved without executing repository scripts", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  assert.equal(inputs.packageManager, "npm");
  assert.equal(inputs.dependencies.length, 2);
  const alias = inputs.dependencies.find((d) => d.name === "alias");
  assert.equal(alias.packageName, "public-example");
  assert.equal(alias.requested, "npm:public-example@^1.0.0");
  assert.equal(alias.resolved, "1.0.0");
  assert.equal(alias.role, "production");
  assert.equal(inputs.dependencies.find((d) => d.name === "transitive").role, "transitive");
  await assert.rejects(readFile(join(root, "executed")), { code: "ENOENT" });
  const firstFingerprint = inputs.inputFingerprint;
  assert.match(firstFingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await inspectProject(root)).inputFingerprint, firstFingerprint);
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  lock.lockfileVersion = 2;
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  const changedLock = await inspectProject(root);
  assert.notEqual(changedLock.inputFingerprint, firstFingerprint);
  assert.equal(changedLock.errors.length, 0);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { alias: "npm:different-public-name@^2.0.0" } }),
  );
  const changedManifest = await inspectProject(root);
  assert.notEqual(changedManifest.inputFingerprint, changedLock.inputFingerprint);
  assert.equal(
    changedManifest.dependencies.find((d) => d.name === "alias").packageName,
    "public-example",
    "The lockfile's actual alias identity must survive a changed manifest target.",
  );
  assert.ok(changedManifest.errors.some((e) => e.includes("alias target")));
  assert.ok(changedManifest.errors.some((e) => e.includes("manifest range")));
});

test("pnpm v9 workspace importers, npm aliases, peer identities and unsupported workspace origins", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { alias: "npm:public-example@^1.0.0", local: "workspace:*" } }),
  );
  await writeFile(
    join(root, "apps", "web", "package.json"),
    JSON.stringify({ devDependencies: { tool: "^2.0.0" } }),
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alias: {specifier: 'npm:public-example@^1.0.0', version: 'public-example@1.0.0(peer@3.0.0)'}
      local: {specifier: 'workspace:*', version: 'link:apps/web'}
  apps/web:
    devDependencies:
      tool: {specifier: '^2.0.0', version: '2.0.0'}
packages:
  public-example@1.0.0: {resolution: {integrity: sha512-example}}
  tool@2.0.0: {resolution: {integrity: sha512-example}}
  peer@3.0.0: {resolution: {integrity: sha512-example}}
snapshots:
  public-example@1.0.0(peer@3.0.0): {dependencies: {peer: 3.0.0}}
  tool@2.0.0: {}
  peer@3.0.0: {}
`,
  );
  const inputs = await inspectProject(root);
  assert.equal(inputs.packageManager, "pnpm");
  assert.equal(inputs.dependencies.find((d) => d.name === "alias").packageName, "public-example");
  assert.equal(inputs.dependencies.find((d) => d.name === "local").origin, "workspace");
  assert.equal(inputs.dependencies.find((d) => d.name === "tool").importer, "apps/web");
  assert.equal(inputs.dependencies.find((d) => d.name === "tool").role, "development");
  assert.equal(inputs.dependencies.find((d) => d.name === "peer").role, "transitive");
  assert.equal(inputs.dependencies.filter((d) => d.name === "public-example").length, 0);
  assert.ok(inputs.coverage.some((e) => e.includes("internal workspace/local")));
});

test("a pnpm workspace is marked even when its packages declare no dependencies", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "packages", "empty"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }),
  );
  await writeFile(
    join(root, "packages", "empty", "package.json"),
    JSON.stringify({ name: "empty" }),
  );
  const lockfile = (others) => `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      typescript: {specifier: '^5.0.0', version: '5.0.4'}
${others}packages:
  typescript@5.0.4: {resolution: {integrity: sha512-example}}
snapshots:
  typescript@5.0.4: {}
`;
  await writeFile(join(root, "pnpm-lock.yaml"), lockfile("  packages/empty: {}\n"));
  const workspace = await inspectProject(root);
  assert.equal(workspace.pnpmWorkspace, true);
  assert.ok(
    workspace.dependencies.every((d) => d.importer === "."),
    "no dependency record names another workspace package",
  );
  await writeFile(join(root, "pnpm-lock.yaml"), lockfile(""));
  assert.equal((await inspectProject(root)).pnpmWorkspace, false);
});

// Records each worker thread started during a test: its messages and whether it has exited. A worker
// that is not terminated always delivers its result before it exits.
function watchWorkers(t, onStart = () => {}) {
  const workers = [];
  const started = (worker) => {
    const record = { worker, messages: 0, exited: false };
    record.exit = new Promise((resolve) =>
      worker.once("exit", () => {
        record.exited = true;
        resolve();
      }),
    );
    worker.on("message", () => (record.messages += 1));
    workers.push(record);
    onStart(record);
  };
  process.on("worker", started);
  t.after(() => process.off("worker", started));
  return workers;
}

test("pnpm lockfiles parse on a worker thread, leaving the coordinator's event loop free", async (t) => {
  const files = {
    "package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  };
  const read = async (name) => files[name] ?? null;
  const workers = watchWorkers(t);
  let settled = false;
  const inspection = inspectProjectFiles(read).finally(() => (settled = true));
  // Every read resolves at once, so a parse on this thread would settle before the next turn.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal((await inspection).packageManager, "pnpm");
  assert.equal(workers.length, 1);
  // Duplicate keys (at any depth, and equal by value like yaml's own check), malformed YAML, and nesting
  // the worker can post but this thread cannot receive (the depth varies by platform) are malformed.
  for (const lockfile of [
    "lockfileVersion: '9.0'\nimporters: {}\nimporters: {}\n",
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  .: {}\n",
    "lockfileVersion: '9.0'\nimporters: {1: {}, 0x1: {}}\n",
    "lockfileVersion: [\n",
    ...Array.from({ length: 7 }, (_, i) => "[".repeat(2000 + 250 * i) + "]".repeat(2000 + 250 * i)),
  ]) {
    files["pnpm-lock.yaml"] = lockfile;
    await assert.rejects(
      inspectProjectFiles(read),
      (e) =>
        e instanceof InputError &&
        e.status === "failed" &&
        e.message === "The pnpm lockfile is malformed.",
    );
  }
  // YAML features pnpm never writes are unsupported rather than malformed.
  for (const lockfile of [
    "lockfileVersion: &version '9.0'\nimporters: {}\n",
    "lockfileVersion: '9.0'\nimporters: &shared {}\n",
    "lockfileVersion: '9.0'\nimporters: &shared {}\nsnapshots: *shared\n",
    "lockfileVersion: '9.0'\nimporters: {}\n? [0]\n: 1\n",
    "lockfileVersion: '9.0'\nimporters: {}\n? {a: 1}\n: 1\n",
  ]) {
    files["pnpm-lock.yaml"] = lockfile;
    await assert.rejects(
      inspectProjectFiles(read),
      (e) =>
        e instanceof InputError &&
        e.status === "unsupported" &&
        e.message ===
          "The pnpm lockfile uses YAML features pnpm does not write (anchors, aliases or collection keys).",
    );
  }
});

test("large crafted lockfiles reach their verdicts", async () => {
  // Each shape takes yaml seconds to minutes through its default paths, which rescan earlier input.
  const keys = Array.from({ length: 40000 }, (_, i) => `  pkg-${i}@1.0.0: {}`).join("\n");
  const files = {
    "package.json": "{}",
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters: {}\nsnapshots:\n${keys}\n`,
  };
  const read = async (name) => files[name] ?? null;
  // 40,000 unique keys parse, and the package limit then rejects the lockfile.
  await assert.rejects(
    inspectProjectFiles(read),
    (e) =>
      e instanceof InputError && e.status === "unsupported" && /10,000 packages/.test(e.message),
  );
  files["pnpm-lock.yaml"] += "  pkg-0@1.0.0: {}\n";
  await assert.rejects(inspectProjectFiles(read), /pnpm lockfile is malformed/);
  // 10,000 anchors followed by 10,000 collection keys.
  const anchors = Array.from({ length: 10000 }, (_, i) => `  - &a${i} x`).join("\n");
  const collectionKeys = Array.from({ length: 10000 }, (_, i) => `? [${i}]\n: 1`).join("\n");
  files["pnpm-lock.yaml"] =
    `lockfileVersion: '9.0'\nimporters:\n  .: {}\na:\n${anchors}\n${collectionKeys}\n`;
  await assert.rejects(inspectProjectFiles(read), /YAML features pnpm does not write/);
});

test("a lockfile parse that outlasts its deadline is terminated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const files = {
    "package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  };
  // The deadline elapses as soon as the worker starts.
  const workers = watchWorkers(t, () => t.mock.timers.tick(30_000));
  await assert.rejects(
    inspectProjectFiles(async (name) => files[name] ?? null),
    (e) => e instanceof InputError && e.message === "The pnpm lockfile took too long to parse.",
  );
  assert.equal(workers.length, 1);
  await workers[0].exit;
  assert.equal(workers[0].messages, 0);
});

test("a lockfile worker that runs out of memory reports an input error", async (t) => {
  const files = {
    "package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  };
  // Node reports a worker over its heap cap with this error and stops it; the 1 GiB cap is too large to
  // reach in a test.
  const workers = watchWorkers(t, ({ worker }) => {
    const error = new Error(
      "Worker terminated due to reaching memory limit: JS heap out of memory",
    );
    worker.emit("error", Object.assign(error, { code: "ERR_WORKER_OUT_OF_MEMORY" }));
    void worker.terminate();
  });
  await assert.rejects(
    inspectProjectFiles(async (name) => files[name] ?? null),
    (e) =>
      e instanceof InputError &&
      e.message === "The pnpm lockfile needs more memory to parse than the scanner allows.",
  );
  await workers[0].exit;
});

test("aborting an inspection rejects at once and terminates its lockfile worker", async (t) => {
  const files = {
    "package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  };
  const read = async (name) => files[name] ?? null;
  const stopped = (e) =>
    e instanceof InputError &&
    e.message === "The scan stopped before the pnpm lockfile was parsed.";
  let controller;
  const workers = watchWorkers(t, () => controller?.abort());
  // An already aborted scan starts no worker.
  await assert.rejects(inspectProjectFiles(read, AbortSignal.abort()), stopped);
  assert.equal(workers.length, 0);
  // Aborting as the parse starts rejects before the worker has stopped, and the worker is terminated:
  // it exits without delivering its result.
  controller = new AbortController();
  await assert.rejects(inspectProjectFiles(read, controller.signal), stopped);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].exited, false);
  await workers[0].exit;
  assert.equal(workers[0].messages, 0);
});

test("removing a project or stopping the coordinator terminates its lockfile parse", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  let onWorker = () => {};
  const workers = watchWorkers(t, () => onWorker());
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  coordinator.changeSettings({ paused: true });
  const pnpmProject = async (name) => {
    const path = join(root, name);
    await mkdir(path);
    await writeFile(join(path, "package.json"), "{}");
    await writeFile(join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    return coordinator.addProject({ path, mode: "watch" });
  };
  const attempt = (history, project) => history.find((a) => a.targetId === project.id);

  const removed = await pnpmProject("removed");
  onWorker = () => coordinator.removeProject(removed.id);
  coordinator.requestScan({ target: "projects", projectId: removed.id });
  await waitFor(() => workers.length === 1);
  await workers[0].exit;
  assert.equal(workers[0].messages, 0);
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  assert.deepEqual(attempt(coordinator.snapshot().history, removed).errors, [
    "The project was removed during this scan.",
  ]);

  const stopping = await pnpmProject("stopping");
  let closing;
  onWorker = () => (closing = coordinator.close());
  coordinator.requestScan({ target: "projects", projectId: stopping.id });
  await waitFor(() => closing);
  await closing;
  await workers[1].exit;
  assert.equal(workers[1].messages, 0);
  const storage = new MonitoringStorage(dataDir);
  const stored = attempt(storage.read().snapshot.history, stopping);
  storage.close();
  assert.equal(stored.status, "failed");
  assert.deepEqual(stored.errors, ["The scan stopped before the pnpm lockfile was parsed."]);
});

test("application and repository scans pass their signal to the lockfile parse", async (t) => {
  let coordinator;
  let app;
  t.after(async () => {
    await app?.close();
    await coordinator?.close();
  });
  const root = await temporary(t);
  let onWorker = () => {};
  const workers = watchWorkers(t, () => onWorker());
  const files = {
    "package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  };
  // Local checkouts scan through ApplicationService's inspection.
  coordinator = new MonitoringCoordinator({ dataDir: join(root, "state"), lookup: false });
  coordinator.changeSettings({ paused: true });
  app = await ApplicationService.create(coordinator);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  for (const [name, content] of Object.entries(files))
    await writeFile(join(checkout, name), content);
  const local = await coordinator.addProject({ path: checkout, mode: "watch" });
  onWorker = () => coordinator.removeProject(local.id);
  coordinator.requestScan({ target: "projects", projectId: local.id });
  await waitFor(() => workers.length === 1);
  await workers[0].exit;
  assert.equal(workers[0].messages, 0);

  // Provider repositories scan through inspectRepository.
  const fetcher = async (input) => {
    const path = new URL(input).pathname;
    if (path === "/repos/fixture/repo/commits/main") return Response.json({ sha: "a".repeat(40) });
    const content = files[decodeURIComponent(path.split("/contents/")[1] ?? "")];
    return content ? new Response(content) : new Response("", { status: 404 });
  };
  const repository = { provider: "github", repositoryId: "1", name: "fixture/repo", ref: "main" };
  const controller = new AbortController();
  onWorker = () => controller.abort();
  await assert.rejects(
    inspectRepository({ repository }, "token", fetcher, controller.signal),
    (e) =>
      e instanceof InputError &&
      e.message === "The scan stopped before the pnpm lockfile was parsed.",
  );
  await workers[1].exit;
  assert.equal(workers[1].messages, 0);
});

test("missing, malformed and unsupported inputs never produce complete coverage", async (t) => {
  const root = await temporary(t);
  await assert.rejects(
    inspectProject(root),
    (e) => e instanceof InputError && e.status === "unsupported",
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
  await assert.rejects(inspectProject(root), /No supported lockfile/);
  await writeFile(join(root, "package-lock.json"), "{broken}");
  await assert.rejects(inspectProject(root), /malformed/);
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 1 }));
  await assert.rejects(inspectProject(root), (e) => e.status === "unsupported");
  await rm(join(root, "package-lock.json"));
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters: {.: {}}\npackages: []\n",
  );
  await assert.rejects(inspectProject(root));
});

test("selected roots reject files, workspace traversal and escaping lockfile symlinks", async (t) => {
  const root = await temporary(t);
  const outside = await temporary(t);
  await npmFixture(root);
  await assert.rejects(selectDirectory(join(root, "package.json")), /directory/);
  // An npm "../x" key is a file: link target that is noted, not read (see the linked-dependency test);
  // an escaping package location and a pnpm importer path remain fatal.
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "../escape/node_modules/x": {} } }),
  );
  await assert.rejects(inspectProject(root), /escapes/);
  await rm(join(root, "package-lock.json"));
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters:\n  ../escape: {}\n",
  );
  await assert.rejects(inspectProject(root), /escapes/);
  await rm(join(root, "pnpm-lock.yaml"));
  await writeFile(join(outside, "lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  try {
    await symlink(join(outside, "lock.json"), join(root, "package-lock.json"), "file");
  } catch (error) {
    if (error.code === "EPERM") {
      t.diagnostic(
        "File symlink creation requires Windows privilege; traversal rejection remains verified.",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(inspectProject(root), /symlink escapes/);
});

test("npm file: links outside the selected project are noted once and never read as workspaces", async (t) => {
  const base = await temporary(t);
  const root = join(base, "app");
  await mkdir(root);
  await mkdir(join(base, "shared"));
  await writeFile(join(base, "shared", "package.json"), "{ never read");
  // Shaped like `npm install ../shared`: the target is a "../" key and node_modules/<name> is the link.
  const files = {
    "package.json": JSON.stringify({ name: "app", dependencies: { shared: "file:../shared" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "app", dependencies: { shared: "file:../shared" } },
        "../shared": { version: "1.0.0" },
        "/linked/elsewhere": { version: "1.0.0" },
        "node_modules/shared": { resolved: "../shared", link: true },
      },
    }),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  const reads = [];
  const inMemory = await inspectProjectFiles(async (name) => {
    reads.push(name);
    return files[name] ?? null;
  });
  assert.deepEqual(
    reads.filter((name) => name.includes("..") || name.startsWith("/")),
    [],
    "A link target outside the project is not a workspace importer to read",
  );
  const note = "A linked dependency outside the selected project was not inspected.";
  for (const inputs of [inMemory, await inspectProject(root)]) {
    assert.deepEqual(inputs.errors, []);
    assert.equal(inputs.coverage.filter((line) => line === note).length, 1);
    assert.match(inputs.coverage.join("\n"), /\b1 selected workspace importer/);
    assert.equal(inputs.dependencies.find((d) => d.name === "shared").origin, "workspace");
  }
});

test("selected files are read into buffers sized by the file, still bounded by the limit", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "small.json"), '{"a":1}');
  await writeFile(join(root, "exact.txt"), "12345");
  await writeFile(join(root, "large.txt"), "123456");
  // The limit only caps the buffer: one that could never be allocated is harmless for a small file.
  assert.equal(await readSelectedFile(root, "small.json", Number.MAX_SAFE_INTEGER), '{"a":1}');
  assert.equal(await readSelectedFile(root, "exact.txt", 5), "12345");
  await assert.rejects(readSelectedFile(root, "large.txt", 5), /supported size/);
  assert.equal(await readSelectedFile(root, "missing.txt", 5), null);
  // A file that grew after it was measured fails instead of being returned truncated.
  const handle = await open(join(root, "large.txt"));
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const measure = prototype.stat;
  t.mock.method(prototype, "stat", async function (...args) {
    return Object.assign(await measure.apply(this, args), { size: 3 });
  });
  await assert.rejects(readSelectedFile(root, "large.txt", 100), /supported size/);
});

test("network shares are recognized by path form, which also covers a mapped drive's resolved target", async () => {
  for (const path of [
    "\\\\server\\share\\project",
    "//server/share/project",
    "\\\\?\\UNC\\server\\share",
  ])
    assert.equal(isNetworkShare(path), true, path);
  for (const path of ["C:\\work\\project", "D:/work/project", "/home/owner/project", "\\relative"])
    assert.equal(isNetworkShare(path), false, path);
  await assert.rejects(selectDirectory("//server/share/project"), /Network shares/);
});

test("public lookups use real alias identity, compatible SemVer and OSV; private inputs remain unqueried", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url.endsWith("/querybatch")) {
      const queries = JSON.parse(options.body).queries;
      return Response.json({
        results: queries.map((query) =>
          query.package.name === "public-example" ? { vulns: [{ id: "GHSA-example" }] } : {},
        ),
      });
    }
    if (url.includes("/vulns/"))
      return Response.json({
        id: "GHSA-example",
        summary: "Fixture advisory",
        database_specific: { severity: "HIGH" },
        affected: [
          {
            package: { ecosystem: "npm", name: "public-example" },
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] }],
          },
        ],
      });
    return Response.json({
      name: "public-example",
      "dist-tags": { latest: "2.0.0" },
      versions: { "1.0.0": {}, "1.5.0": {}, "1.7.0-beta.1": {}, "2.0.0": {} },
    });
  };
  const lookedUp = await lookupDependencies(inputs.dependencies, fetcher);
  const alias = lookedUp.dependencies.find((d) => d.name === "alias");
  assert.equal(alias.availableVersion, "1.5.0");
  assert.equal(alias.latestVersion, "2.0.0");
  assert.equal(alias.versionStatus, "checked");
  assert.equal(alias.advisoryStatus, "checked");
  assert.deepEqual(alias.advisoryIds, ["GHSA-example"]);
  assert.equal(lookedUp.advisories.get(alias.id)[0].fixed, "1.5.0");
  assert.equal(lookedUp.advisories.get(alias.id)[0].severity, "high");
  assert.ok(requests.every((r) => !r.url.endsWith("/alias")));
  await writeFile(
    join(root, ".npmrc"),
    "registry=https://private.example.invalid\n//private.example.invalid/:_authToken=never-log-me\n",
  );
  const privateInputs = await inspectProject(root);
  assert.ok(privateInputs.dependencies.every((d) => d.origin === "unknown"));
  let queried = false;
  await lookupDependencies(privateInputs.dependencies, async () => {
    queried = true;
    throw new Error();
  });
  assert.equal(queried, false);
});

test("offline and paginated OSV responses stay failed instead of reassuring clean results", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  const offline = await lookupDependencies(inputs.dependencies, async () => {
    throw new Error("offline");
  });
  assert.ok(offline.dependencies.every((d) => d.advisoryStatus === "failed"));
  assert.equal(offline.dependencies.find((d) => d.name === "alias").versionStatus, "failed");
  assert.equal(
    offline.dependencies.find((d) => d.name === "transitive").versionStatus,
    "unsupported",
  );
  assert.ok(offline.errors.length);
  const paginated = await lookupDependencies(inputs.dependencies, async (url) =>
    url.endsWith("/querybatch")
      ? Response.json({ results: [{ next_page_token: "more" }, {}] })
      : Response.json({}),
  );
  assert.ok(paginated.dependencies.every((d) => d.advisoryStatus === "failed"));
});

test("successfully current direct dependencies differ from failed checks and every eligible name is attempted", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const inputs = await inspectProject(root);
  const current = await lookupDependencies(inputs.dependencies, async (url) =>
    url.endsWith("/querybatch")
      ? Response.json({ results: [{}, {}] })
      : Response.json({
          name: "public-example",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": {} },
        }),
  );
  const checked = current.dependencies.find((d) => d.name === "alias");
  assert.equal(checked.versionStatus, "checked");
  assert.equal(checked.availableVersion, null);
  assert.equal(checked.latestVersion, null);
  assert.equal(inputs.dependencies.find((d) => d.name === "alias").versionStatus, "not-checked");
  const direct = inputs.dependencies.find((d) => d.name === "alias");
  const additional = {
    ...direct,
    id: "another-id",
    name: "another-name",
    packageName: "another-name",
  };
  const failed = await lookupDependencies([...inputs.dependencies, additional], async () => {
    throw new Error("offline");
  });
  assert.equal(failed.dependencies.find((d) => d.name === "alias").versionStatus, "failed");
  assert.equal(failed.dependencies.find((d) => d.name === "another-name").versionStatus, "failed");
});

test("lookup progress measures actual batches and attempts while failed names leave other checks running", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 121 }, (_, index) => ({
    ...base,
    id: `progress-${index}`,
    name: `progress-${index}`,
    packageName: `progress-${index}`,
    role: index < 3 ? "production" : "transitive",
  }));
  const progress = [];
  const results = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch")) {
        const queries = JSON.parse(options.body).queries;
        return Response.json({
          results: queries.map((query) =>
            query.package.name === "progress-0" ? { vulns: [{ id: "GHSA-progress" }] } : {},
          ),
        });
      }
      if (url.includes("/vulns/")) throw new Error("Detail source unavailable");
      if (url.endsWith("/progress-1")) throw new Error("Registry unavailable");
      return Response.json({
        name: decodeURIComponent(new URL(url).pathname.slice(1)),
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": {} },
      });
    },
    undefined,
    (value) => progress.push(value),
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === "advisories"),
    [0, 100, 121].map((completed) => ({ stage: "advisories", completed, total: 121 })),
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === "advisory-details"),
    [0, 1].map((completed) => ({ stage: "advisory-details", completed, total: 1 })),
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === "versions"),
    [0, 1, 2, 3].map((completed) => ({ stage: "versions", completed, total: 3 })),
  );
  assert.equal(results.dependencies[1].versionStatus, "failed");
  assert.equal(results.dependencies[2].versionStatus, "checked");
  assert.equal(results.advisories.get("progress-0")[0].detailsUnavailable, true);
});

test("a failed OSV batch remains unverified while later batches collect advisory evidence", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 121 }, (_, index) => ({
    ...base,
    id: `osv-batch-${index}`,
    name: `osv-batch-${index}`,
    packageName: `osv-batch-${index}`,
    requested: "^1.0.0",
    role: index === 120 ? "production" : "transitive",
  }));
  const batches = [];
  const progress = [];
  const result = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch")) {
        const queries = JSON.parse(options.body).queries;
        batches.push(queries.length);
        // The first batch and its one retry are unavailable.
        if (batches.length <= 2) return new Response("OSV unavailable", { status: 503 });
        return Response.json({
          results: queries.map((query) =>
            query.package.name === "osv-batch-120" ? { vulns: [{ id: "GHSA-late-batch" }] } : {},
          ),
        });
      }
      if (url.includes("/vulns/"))
        return Response.json({
          id: "GHSA-late-batch",
          summary: "Advisory in the later batch",
          database_specific: { severity: "HIGH" },
        });
      return Response.json({
        name: "osv-batch-120",
        "dist-tags": { latest: "1.5.0" },
        versions: { "1.0.0": {}, "1.5.0": {} },
      });
    },
    undefined,
    (value) => progress.push(value),
    undefined,
    createSourceCache(async () => {}),
  );
  assert.deepEqual(batches, [100, 100, 21]);
  for (let index = 0; index < result.dependencies.length; index++)
    assert.equal(result.dependencies[index].advisoryStatus, index < 100 ? "failed" : "checked");
  assert.deepEqual(result.dependencies[120].advisoryIds, ["GHSA-late-batch"]);
  assert.equal(result.advisories.get("osv-batch-120")[0].severity, "high");
  assert.equal(result.dependencies[120].versionStatus, "checked");
  assert.ok(result.errors.some((error) => /Known-advisory lookup failed/.test(error)));
  assert.ok(
    result.coverage.includes("OSV npm version queries: 21/121 resolved dependency records"),
  );
  assert.deepEqual(
    progress.filter((value) => value.stage === "advisories"),
    [0, 100, 121].map((completed) => ({ stage: "advisories", completed, total: 121 })),
  );
});

test("project lookups check every unique direct name beyond 100 with bounded concurrency and isolated failures", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 105 }, (_, index) => ({
    ...base,
    id: `complete-${index}`,
    name: `complete-${index}`,
    packageName: `complete-${index}`,
    requested: "^1.0.0",
    role: ["production", "development", "optional"][index % 3],
  }));
  dependencies.push(
    {
      ...dependencies[104],
      id: "alias-last",
      name: "alias-last",
      requested: "npm:complete-104@^1.0.0",
      importer: "packages/alias",
    },
    {
      ...dependencies[104],
      id: "second-importer",
      requested: "^2.0.0",
      importer: "packages/other",
    },
    { ...base, id: "transitive-only", packageName: "transitive-only", role: "transitive" },
    { ...base, id: "private-only", packageName: "private-only", origin: "unknown" },
  );
  const requests = [];
  const progress = [];
  let active = 0;
  let maximum = 0;
  let failedResponseCanceled = false;
  const startedAt = Date.now();
  let scanClock = startedAt;
  t.mock.method(Date, "now", () => scanClock);
  const result = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch"))
        return Response.json({ results: JSON.parse(options.body).queries.map(() => ({})) });
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      requests.push(name);
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        scanClock += 1000;
        if (name === "complete-0")
          return new Response(
            new ReadableStream({
              cancel() {
                failedResponseCanceled = true;
              },
            }),
            { status: 503 },
          );
        return Response.json({
          name: name === "complete-2" ? "another-package" : name,
          "dist-tags": { latest: "2.0.0" },
          versions: { "1.0.0": {}, "1.5.0": {}, "2.0.0": {} },
        });
      } finally {
        active--;
      }
    },
    undefined,
    (value) => progress.push(value),
    undefined,
    createSourceCache(async () => {}),
  );
  assert.equal(requests.length, 106, "Every name once, and the unavailable one retried once");
  assert.equal(requests.filter((name) => name === "complete-0").length, 2);
  assert.equal(
    failedResponseCanceled,
    true,
    "An unavailable response must release its unread body",
  );
  assert.ok(
    scanClock - startedAt > 90000,
    "A fixed 90-second scan ceiling must not skip later names",
  );
  assert.equal(
    new Set(requests).size,
    105,
    "Aliases and importers share canonical metadata requests",
  );
  assert.ok(
    maximum > 1 && maximum <= 4,
    `Registry concurrency must be bounded at four, got ${maximum}`,
  );
  assert.ok(!requests.includes("alias-last"));
  assert.ok(!requests.includes("transitive-only"));
  assert.ok(!requests.includes("private-only"));
  for (const dependency of result.dependencies) {
    if (["private-only", "transitive-only"].includes(dependency.id)) {
      assert.equal(dependency.versionStatus, "unsupported");
      continue;
    }
    const failed = ["complete-0", "complete-2"].includes(dependency.packageName);
    assert.equal(dependency.versionStatus, failed ? "failed" : "checked");
    assert.equal(result.versionChecked.has(dependency.id), !failed);
  }
  assert.equal(result.dependencies.find((d) => d.id === "complete-104").availableVersion, "1.5.0");
  assert.equal(result.dependencies.find((d) => d.id === "alias-last").availableVersion, "1.5.0");
  assert.equal(
    result.dependencies.find((d) => d.id === "second-importer").availableVersion,
    "2.0.0",
  );
  assert.deepEqual(
    progress.filter((value) => value.stage === "versions"),
    Array.from({ length: 106 }, (_, completed) => ({ stage: "versions", completed, total: 105 })),
  );
  assert.ok(result.errors.some((error) => /version lookup failed/.test(error)));
  assert.ok(!result.errors.some((error) => /limited to/.test(error)));
});

test("all advisory details beyond 50 are attempted with bounded concurrency and unavailable IDs retained", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const dependencies = (await inspectProject(root)).dependencies;
  const ids = Array.from({ length: 55 }, (_, index) => `GHSA-detail-${index}`);
  const requests = [];
  const progress = [];
  let active = 0;
  let maximum = 0;
  const result = await lookupDependencies(
    dependencies,
    async (url, options) => {
      if (url.endsWith("/querybatch"))
        return Response.json({
          results: JSON.parse(options.body).queries.map((query) =>
            query.package.name === "public-example" ? { vulns: ids.map((id) => ({ id })) } : {},
          ),
        });
      if (url.includes("/vulns/")) {
        const id = new URL(url).pathname.split("/").at(-1);
        requests.push(id);
        maximum = Math.max(maximum, ++active);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (id === "GHSA-detail-3") throw new Error("Advisory source unavailable");
          return Response.json({
            id,
            summary: "Known advisory " + id,
            database_specific: { severity: "HIGH" },
            affected: [
              {
                package: { ecosystem: "npm", name: "public-example" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] }],
              },
            ],
          });
        } finally {
          active--;
        }
      }
      return Response.json({
        name: "public-example",
        "dist-tags": { latest: "1.5.0" },
        versions: { "1.0.0": {}, "1.5.0": {} },
      });
    },
    undefined,
    (value) => progress.push(value),
    undefined,
    createSourceCache(async () => {}),
  );
  assert.deepEqual(
    [...requests].sort(),
    [...ids, "GHSA-detail-3"].sort(),
    "Every id once, and the unavailable one retried once",
  );
  assert.ok(
    maximum > 1 && maximum <= 4,
    `Advisory detail concurrency must be bounded at four, got ${maximum}`,
  );
  const advisory = result.advisories.get(dependencies.find((d) => d.name === "alias").id);
  assert.equal(advisory.length, 55);
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-54").fixed, "1.5.0");
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-54").severity, "high");
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-3").detailsUnavailable, true);
  assert.equal(advisory.find((item) => item.id === "GHSA-detail-3").severity, "unknown");
  assert.deepEqual(
    progress.filter((value) => value.stage === "advisory-details"),
    Array.from({ length: 56 }, (_, completed) => ({
      stage: "advisory-details",
      completed,
      total: 55,
    })),
  );
  assert.ok(result.errors.some((error) => /advisory details are unavailable/.test(error)));
  assert.ok(!result.errors.some((error) => /limited to/.test(error)));
});

test("cancelling project lookup stops launching further registry batches", async (t) => {
  const root = await temporary(t);
  await npmFixture(root);
  const base = (await inspectProject(root)).dependencies.find((d) => d.name === "alias");
  const dependencies = Array.from({ length: 12 }, (_, index) => ({
    ...base,
    id: `cancel-${index}`,
    name: `cancel-${index}`,
    packageName: `cancel-${index}`,
  }));
  const controller = new AbortController();
  const requests = [];
  let launchedAfterAbort = 0;
  await assert.rejects(
    lookupDependencies(
      dependencies,
      async (url, options) => {
        if (url.endsWith("/querybatch"))
          return Response.json({ results: JSON.parse(options.body).queries.map(() => ({})) });
        if (controller.signal.aborted) launchedAfterAbort++;
        requests.push(url);
        if (requests.length === 1) queueMicrotask(() => controller.abort());
        return new Promise((_, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else
            options.signal.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
        });
      },
      controller.signal,
    ),
    /scan stopped|scan cancelled/i,
  );
  assert.ok(requests.length > 0 && requests.length <= 4);
  assert.equal(launchedAfterAbort, 0);
});

test("durable attempts preserve successful evidence on failure and restart; new findings notify once", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const lookup = async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: d.name === "alias" ? "1.5.0" : null,
      advisoryStatus: "checked",
    })),
    advisories: new Map(),
    coverage: ["Injected public-source evidence"],
    errors: [],
  });
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  const first = coordinator.snapshot();
  assert.equal(first.projects[0].evidence.status, "complete");
  assert.match(first.projects[0].inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.history[0].inputFingerprint, first.projects[0].inputFingerprint);
  assert.equal(first.notifications.length, 1);
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 1);
  const lastSuccess = coordinator.snapshot().projects[0].evidence.lastSuccess;
  coordinator.acknowledgeNotification(first.notifications[0].id);
  await writeFile(join(projectRoot, "package-lock.json"), "broken");
  await scan(coordinator, project.id);
  const failed = coordinator.snapshot();
  assert.equal(failed.projects[0].evidence.status, "failed");
  assert.equal(failed.projects[0].evidence.lastSuccess, lastSuccess);
  assert.equal(failed.projects[0].dependencies.length, first.projects[0].dependencies.length);
  assert.ok(failed.findings.some((f) => f.kind === "update"));
  assert.notEqual(failed.projects[0].evidence.lastAttempt, failed.projects[0].evidence.lastSuccess);
  await coordinator.close();
  const storage = new MonitoringStorage(join(root, "state"));
  const interrupted = storage.read();
  interrupted.snapshot.projects[0].evidence.status = "scanning";
  interrupted.snapshot.history[0].status = "scanning";
  interrupted.snapshot.history[0].finishedAt = null;
  storage.write(interrupted);
  storage.close();
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  const restarted = coordinator.snapshot();
  assert.equal(restarted.settings.paused, true);
  assert.equal(restarted.projects[0].evidence.status, "failed");
  assert.match(restarted.projects[0].evidence.errors[0], /stopped before/);
  assert.equal(restarted.projects[0].dependencies.length, first.projects[0].dependencies.length);
  assert.ok(restarted.notifications[0].deliveredAt);
  await npmFixture(projectRoot);
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 1);
});

test("single scan queue coalesces repeated requests and paused schedules catch up only once", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  let release;
  let lookups = 0;
  const lookup = async (dependencies) => {
    lookups++;
    await new Promise((resolve) => {
      release = resolve;
    });
    return { dependencies, advisories: new Map(), coverage: [], errors: [] };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
    inventoryLookup: async () => ({
      installations: [],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    }),
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "watch" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(coordinator.snapshot().history.length, 0);
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => lookups === 1);
  for (let i = 0; i < 10; i++)
    coordinator.requestScan({ target: "projects", projectId: project.id });
  release();
  await waitFor(() => lookups === 2);
  release();
  await waitFor(() => coordinator.snapshot().projects[0].evidence.status !== "scanning");
  assert.equal(
    coordinator.snapshot().history.filter((a) => a.targetId === project.id).length,
    2,
    "Repeated manual requests coalesce into one rescan after the active scan",
  );
  assert.throws(() => coordinator.changeSettings({ projectIntervalMinutes: 1 }));
  assert.throws(() => coordinator.changeSettings({ pcIntervalMinutes: Number.NaN }));
  assert.equal(coordinator.snapshot().runtime.nextScanAt, null);
  coordinator.changeSettings({ paused: false });
  coordinator.requestScan({ target: "pc" });
  await waitFor(() =>
    coordinator.snapshot().history.some((a) => a.kind === "pc" && a.status !== "scanning"),
  );
  assert.equal(coordinator.snapshot().history.filter((a) => a.targetId === project.id).length, 2);
  assert.ok(coordinator.snapshot().runtime.nextScanAt);
});

test("first-use PC evidence stays empty until a manual scan starts its normal schedule", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const inventoryLookup = async (_platform, _mode, _signal, progress) => {
    progress?.({ stage: "inventory", completed: null, total: null });
    return {
      installations: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
      checkedRoots: [],
      managers: [],
    };
  };
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  coordinator.changeSettings({ pcIntervalMinutes: 5 });
  assert.equal(coordinator.snapshot().runtime.nextScanAt, null);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(coordinator.snapshot().inventory.evidence.status, "not-scanned");
  assert.equal(coordinator.snapshot().history.length, 0);
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const legacyUnscanned = storage.read();
  legacyUnscanned.due.pc = Date.now() - 60000;
  storage.write(legacyUnscanned);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  assert.equal(
    coordinator.snapshot().runtime.nextScanAt,
    null,
    "Legacy unscanned automatic due times must also preserve the first-use prompt",
  );
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => coordinator.snapshot().history[0]?.status === "complete");
  assert.equal(coordinator.snapshot().inventory.updateEvidence.status, "complete");
  assert.ok(Date.parse(coordinator.snapshot().runtime.nextScanAt) > Date.now());
});

test("global tool findings preserve failed roots and distinguish npm/Bun installations", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const checkedAt = "2026-10-02T08:00:00.000Z";
  const source = (manager) => ({
    manager,
    status: "detected",
    version: manager === "npm" ? "11.6.0" : "1.3.0",
    root: join(root, manager, "node_modules"),
    registry: "public",
    blockedScopes: [],
    checkedAt,
    error: null,
  });
  const managers = [source("npm"), source("bun")];
  const rootId = (manager) => identity("global-root", manager, source(manager).root);
  const installation = (
    manager,
    version = "1.0.0",
    availableVersion = "2.0.0",
    alias = "public-example",
  ) => ({
    id: identity("global-tool", manager, source(manager).root, alias, version),
    name: alias,
    packageId: "public-example",
    version,
    manager,
    rootId: rootId(manager),
    origin: "registry",
    source: manager,
    scope: "user",
    channel: "stable",
    availableVersion,
    updateStatus: availableVersion ? "available" : "current",
    updateCheckedAt: checkedAt,
  });
  let result = {
    installations: [installation("npm"), installation("bun")],
    coverage: ["Top-level npm/Bun global roots and public npm stable releases"],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
    checkedRoots: managers.map((m) => rootId(m.manager)),
    managers,
  };
  const passedSources = [];
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    mode: "background",
    inventoryLookup: async (_platform, _mode, _signal, _progress, sources) => {
      passedSources.push(structuredClone(sources));
      return result;
    },
  });
  coordinator.changeSettings({ paused: true });
  const pcScan = async () => {
    const previous = coordinator.snapshot().history[0]?.id;
    coordinator.requestScan({ target: "pc" });
    await waitFor(() => {
      const latest = coordinator.snapshot().history[0];
      return latest?.id !== previous && latest?.status !== "scanning";
    });
  };
  await pcScan();
  assert.equal(coordinator.snapshot().inventory.installations.length, 2);
  assert.equal(
    coordinator.snapshot().inventory.updateEvidence.status,
    "complete",
    "Background collection of captured owner roots must not force partial coverage",
  );
  assert.deepEqual(coordinator.snapshot().inventory.managers, managers);
  assert.deepEqual(passedSources[0], []);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  assert.equal(
    coordinator.snapshot().notificationSummary.updateCount,
    2,
    "Identical tools in npm and Bun are separate actual installations",
  );
  assert.equal(coordinator.snapshot().notificationSummary.pcCount, 1);
  const bunFinding = coordinator.snapshot().findings.find((f) => f.source === "bun");
  result = {
    ...result,
    installations: [installation("npm", "1.0.0", null)],
    inventoryChecks: "partial",
    updateChecks: "partial",
    checkedRoots: [rootId("npm")],
    errors: ["The captured Bun global root is inaccessible."],
    managers: [
      source("npm"),
      { ...source("bun"), status: "unavailable", error: "Global root is inaccessible." },
    ],
  };
  await pcScan();
  const partial = coordinator.snapshot();
  const retained = partial.inventory.installations.find((i) => i.manager === "bun");
  assert.equal(retained.updateStatus, "unknown");
  assert.equal(retained.availableVersion, "2.0.0");
  assert.equal(retained.updateCheckedAt, checkedAt);
  assert.equal(partial.findings.filter((f) => f.kind === "update").length, 1);
  assert.equal(
    partial.findings.find((f) => f.id === bunFinding.id).lastSeenAt,
    bunFinding.lastSeenAt,
    "Failed root refresh must not make previous registry evidence look fresh",
  );
  assert.equal(partial.notifications.length, 1, "The freshly resolved npm event must be pruned");
  assert.deepEqual(passedSources[1], managers);
  const updateSuccess = partial.inventory.updateEvidence.lastSuccess;
  const inventorySuccess = partial.inventory.evidence.lastSuccess;
  result = {
    ...result,
    installations: [],
    inventoryChecks: "failed",
    updateChecks: "failed",
    checkedRoots: [],
    errors: ["Global tool roots could not be inspected."],
  };
  await pcScan();
  const failed = coordinator.snapshot();
  assert.equal(failed.inventory.evidence.status, "failed");
  assert.equal(failed.inventory.evidence.lastSuccess, inventorySuccess);
  assert.equal(failed.inventory.updateEvidence.status, "failed");
  assert.equal(failed.inventory.updateEvidence.lastSuccess, updateSuccess);
  assert.equal(
    failed.notifications.length,
    1,
    "Failed refresh must not create another notification",
  );
  assert.equal(failed.findings.filter((f) => f.kind === "update").length, 1);
  result = {
    ...result,
    installations: [installation("bun", "2.0.0", null)],
    inventoryChecks: "partial",
    updateChecks: "partial",
    checkedRoots: [rootId("bun")],
    errors: ["The npm global root is inaccessible."],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().findings.filter((f) => f.kind === "update").length,
    0,
    "A fresh observed installed version replaces stale evidence in a partial scan",
  );
  assert.equal(coordinator.snapshot().notifications.length, 0);
  result = {
    ...result,
    installations: [],
    checkedRoots: [rootId("bun")],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    1,
    "An empty covered Bun root removes its observations; unread npm observations remain",
  );
  result = {
    ...result,
    installations: [installation("npm")],
    managers,
    checkedRoots: [rootId("npm")],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  await pcScan();
  const replacement = { ...source("npm"), root: join(root, "replacement-npm", "node_modules") };
  const changedSources = [replacement, source("bun")];
  await coordinator.changeGlobalToolSources(changedSources);
  result = {
    ...result,
    installations: [],
    managers: changedSources,
    checkedRoots: [],
    inventoryChecks: "failed",
    updateChecks: "failed",
    errors: ["The replacement root is inaccessible."],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    1,
    "Changing captured sources must not erase evidence while the new root cannot be inspected",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 1);
  result = {
    ...result,
    checkedRoots: [identity("global-root", "npm", replacement.root)],
    inventoryChecks: "complete",
    updateChecks: "complete",
    errors: [],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    0,
    "A covered replacement root retires the old root even after source capture overwrote its descriptor",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 0);
  assert.equal(coordinator.snapshot().notifications.length, 0);
  result = {
    ...result,
    installations: [installation("bun")],
    managers,
    checkedRoots: [rootId("bun")],
  };
  await pcScan();
  result = {
    ...result,
    installations: [],
    checkedRoots: [],
    managers: [
      source("npm"),
      { ...source("bun"), status: "not-installed", root: null, version: null },
    ],
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().inventory.installations.length,
    0,
    "Confirmed manager removal retires its previous roots without a successful package enumeration",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 0);
  const aliases = [
    installation("npm", "1.0.0", "2.0.0", "first-alias"),
    installation("npm", "1.0.0", "2.0.0", "second-alias"),
  ];
  result = {
    ...result,
    installations: aliases,
    managers,
    checkedRoots: [rootId("npm")],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  };
  await pcScan();
  assert.equal(
    coordinator.snapshot().findings.filter((f) => f.kind === "update").length,
    2,
    "Aliases of one canonical package are different global installation locations",
  );
  result = {
    ...result,
    installations: [installation("npm", "1.0.0", null, "first-alias")],
    checkedRoots: [],
    errors: ["The second alias could not be read."],
    inventoryChecks: "partial",
    updateChecks: "partial",
  };
  await pcScan();
  const unreadAlias = coordinator
    .snapshot()
    .inventory.installations.find((i) => i.name === "second-alias");
  assert.ok(
    unreadAlias,
    "Failed alias evidence must remain visible after another alias is observed",
  );
  assert.equal(
    unreadAlias.availableVersion,
    "2.0.0",
    "Observing another alias of the same canonical package must not erase failed alias evidence",
  );
  assert.equal(unreadAlias.updateStatus, "unknown");
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 1);
  result = {
    ...result,
    installations: [
      {
        ...aliases[1],
        packageId: "different-public-example",
        updateStatus: "unknown",
        availableVersion: null,
        updateCheckedAt: null,
      },
    ],
  };
  await pcScan();
  const retargeted = coordinator
    .snapshot()
    .inventory.installations.filter((i) => i.name === "second-alias");
  assert.equal(
    retargeted.length,
    1,
    "A fresh alias location replaces its previous canonical identity",
  );
  assert.equal(
    retargeted[0].availableVersion,
    null,
    "Retargeting an alias to another package at the same version must not inherit the old upgrade candidate",
  );
  assert.equal(coordinator.snapshot().findings.filter((f) => f.kind === "update").length, 0);
  assert.equal(coordinator.snapshot().notifications.length, 0);
});

test("captured global roots persist and cannot be replaced during their active scan", async (t) => {
  let coordinator;
  let release;
  t.after(() => {
    release?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const sourceRoot = join(root, "npm", "node_modules");
  const otherRoot = join(root, "other-npm", "node_modules");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  const source = {
    manager: "npm",
    status: "detected",
    version: "11.6.0",
    root: sourceRoot,
    registry: "public",
    blockedScopes: [],
    checkedAt: new Date().toISOString(),
    error: null,
  };
  const missingBun = {
    manager: "bun",
    status: "not-installed",
    version: null,
    root: null,
    registry: "unknown",
    blockedScopes: [],
    checkedAt: source.checkedAt,
    error: null,
  };
  const sources = [source, missingBun];
  let entered = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inventoryLookup = async (_platform, _mode, _signal, _progress, capturedSources) => {
    entered = true;
    await gate;
    return {
      installations: [],
      managers: [...capturedSources],
      checkedRoots: [identity("global-root", "npm", sourceRoot)],
      coverage: ["Captured global root"],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    };
  };
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  const captured = await coordinator.changeGlobalToolSources(sources);
  assert.deepEqual(captured.inventory.managers, sources);
  assert.equal(captured.inventory.evidence.status, "not-scanned");
  const unavailable = {
    ...source,
    status: "unavailable",
    root: null,
    version: null,
    registry: "unknown",
    error: "The manager configuration could not be checked.",
  };
  const fallback = await coordinator.changeGlobalToolSources([unavailable, missingBun]);
  const previousLocation = [
    { ...unavailable, root: source.root, version: source.version },
    missingBun,
  ];
  assert.deepEqual(
    fallback.inventory.managers,
    previousLocation,
    "An unavailable capture retains its last known location without reusing public registry trust",
  );
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  assert.deepEqual(coordinator.snapshot().inventory.managers, previousLocation);
  await coordinator.changeGlobalToolSources(sources);
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => entered);
  await assert.rejects(
    coordinator.changeGlobalToolSources([{ ...source, root: otherRoot }, missingBun]),
    /Wait for the PC scan/,
  );
  release();
  await waitFor(() => coordinator.snapshot().history[0]?.status === "complete");
  assert.deepEqual(coordinator.snapshot().inventory.managers, sources);
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, inventoryLookup });
  assert.deepEqual(coordinator.snapshot().inventory.managers, sources);
});

test("legacy Windows inventory migration clears only active PC data and runs once", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "selected");
  await npmFixture(projectRoot);
  const dataDir = join(root, "state");
  const inventoryLookup = async () => ({
    installations: [
      {
        id: "global-new",
        name: "public-example",
        packageId: "public-example",
        version: "1.0.0",
        manager: "npm",
        rootId: "npm-root",
        origin: "registry",
        source: "npm",
        scope: "user",
        channel: "stable",
        updateStatus: "current",
        availableVersion: null,
      },
    ],
    managers: [],
    checkedRoots: ["npm-root"],
    coverage: ["Captured global root"],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
  });
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false, inventoryLookup });
  coordinator.changeSettings({ paused: true, pcIntervalMinutes: 15 });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  const before = coordinator.snapshot();
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const saved = storage.read();
  delete saved.snapshot.inventory.collector;
  delete saved.snapshot.inventory.managers;
  saved.snapshot.inventory.installations = [
    {
      id: "old-winget",
      name: "Old Windows app",
      version: "1.0",
      source: "WinGet",
      scope: "machine",
      channel: "Unknown",
      packageId: "Publisher.App",
      updateStatus: "available",
      availableVersion: "2.0",
    },
  ];
  saved.snapshot.inventory.evidence = {
    status: "complete",
    lastAttempt: "2026-10-01T10:00:00.000Z",
    lastSuccess: "2026-10-01T10:00:00.000Z",
    coverage: ["Windows registry"],
    errors: [],
  };
  const finding = (subjectId, id) => ({
    id,
    subjectId,
    subjectLabel: "Fixture",
    kind: "update",
    name: "Tool",
    packageName: "tool",
    installedVersion: "1.0.0",
    availableVersion: "2.0.0",
    severity: "info",
    source: "Fixture",
    description: "Update",
    advisoryUrl: null,
    detectedAt: "2026-10-01T10:00:00.000Z",
    lastSeenAt: "2026-10-01T10:00:00.000Z",
  });
  saved.snapshot.findings = [
    finding(before.device.id, "old-pc"),
    finding(project.id, "project-finding"),
  ];
  saved.snapshot.notifications = ["old-pc", "project-finding"].map((id) => ({
    id: `notification-${id}`,
    findingId: id,
    title: "Update",
    body: "Update",
    createdAt: "2026-10-01T10:00:00.000Z",
    deliveredAt: null,
  }));
  saved.notified = ["old-pc", "project-finding"];
  saved.due.pc = Date.now() - 60000;
  storage.write(saved);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false, inventoryLookup });
  const migrated = coordinator.snapshot();
  assert.equal(migrated.inventory.collector, "npm-bun-global-v1");
  assert.equal(migrated.inventory.evidence.status, "not-scanned");
  assert.deepEqual(migrated.inventory.installations, []);
  assert.deepEqual(migrated.inventory.managers, []);
  assert.deepEqual(migrated.projects, before.projects);
  assert.deepEqual(migrated.history, before.history);
  assert.deepEqual(migrated.settings, before.settings);
  assert.equal(migrated.device.id, before.device.id);
  assert.deepEqual(
    migrated.findings.map((f) => f.id),
    ["project-finding"],
  );
  assert.deepEqual(
    migrated.notifications.map((n) => n.findingId),
    ["project-finding"],
  );
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => coordinator.snapshot().history[0]?.status === "complete");
  const collected = coordinator.snapshot().inventory;
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false, inventoryLookup });
  assert.deepEqual(
    coordinator.snapshot().inventory,
    collected,
    "Migration must not repeat on next startup",
  );
});

test("severity/fix changes notify, while failed detail and version refreshes retain known evidence quietly", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  let severity = "high";
  let fixed = "1.5.0";
  let detailsUnavailable = false;
  let versionsFailed = false;
  const lookup = async (dependencies) => {
    const alias = dependencies.find((d) => d.name === "alias");
    return {
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: !versionsFailed && d.id === alias.id ? "1.5.0" : null,
        versionStatus:
          d.role === "transitive" ? "unsupported" : versionsFailed ? "failed" : "checked",
        advisoryStatus: "checked",
        advisoryIds: d.id === alias.id ? ["GHSA-fixture"] : [],
      })),
      advisories: new Map([
        [
          alias.id,
          [
            {
              id: "GHSA-fixture",
              summary: "Fixture advisory",
              severity: detailsUnavailable ? "unknown" : severity,
              fixed: detailsUnavailable ? null : fixed,
              url: "https://osv.dev/vulnerability/GHSA-fixture",
              detailsUnavailable,
            },
          ],
        ],
      ]),
      coverage: [],
      errors: versionsFailed
        ? ["Public-registry version lookup failed."]
        : detailsUnavailable
          ? ["Some advisory details are unavailable."]
          : [],
    };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  const firstAdvisory = coordinator.snapshot().findings.find((f) => f.kind === "advisory").id;
  severity = "critical";
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  const criticalAdvisory = coordinator.snapshot().findings.find((f) => f.kind === "advisory").id;
  assert.notEqual(criticalAdvisory, firstAdvisory);
  assert.ok(coordinator.snapshot().notifications.every((n) => n.findingId !== firstAdvisory));
  fixed = "1.7.0";
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  assert.ok(coordinator.snapshot().notifications.every((n) => n.findingId !== criticalAdvisory));
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 2);
  detailsUnavailable = true;
  versionsFailed = true;
  await scan(coordinator, project.id);
  const failedRefresh = coordinator.snapshot();
  assert.equal(failedRefresh.notifications.length, 2);
  assert.equal(failedRefresh.projects[0].evidence.status, "partial");
  assert.equal(
    failedRefresh.projects[0].dependencies.find((d) => d.name === "alias").availableVersion,
    "1.5.0",
  );
  assert.equal(
    failedRefresh.projects[0].dependencies.find((d) => d.name === "alias").versionStatus,
    "failed",
  );
  const advisory = failedRefresh.findings.find((f) => f.kind === "advisory");
  assert.equal(advisory.severity, "critical");
  assert.equal(advisory.availableVersion, "1.7.0");
});

test("mixed project refreshes clear checked identities while retaining failed identities and quiet notifications", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot, {
    dependencies: {
      alias: "npm:public-example@^1.0.0",
      refreshed: "^1.0.0",
      failed: "^1.0.0",
    },
  });
  const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
  for (const name of ["refreshed", "failed"])
    lock.packages[`node_modules/${name}`] = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    };
  await writeFile(join(projectRoot, "package-lock.json"), JSON.stringify(lock));
  let phase = 1;
  const lookup = async (dependencies) => {
    if (phase === 3) throw new Error("Whole source lookup interrupted");
    const direct = dependencies.filter((d) => d.role !== "transitive");
    const checked = dependencies.map((d) => {
      const failed = phase === 2 && d.name === "failed";
      const actionable =
        d.role !== "transitive" && !failed && !(phase === 2 && d.name === "refreshed");
      return {
        ...d,
        availableVersion: actionable ? (phase === 2 ? "1.7.0" : "1.5.0") : null,
        versionStatus: d.role === "transitive" ? "unsupported" : failed ? "failed" : "checked",
        advisoryStatus: failed ? "failed" : "checked",
        advisoryIds: actionable ? [`GHSA-${d.packageName}`] : [],
      };
    });
    return {
      dependencies: checked,
      versionChecked: new Set(
        direct.filter((d) => !(phase === 2 && d.name === "failed")).map((d) => d.id),
      ),
      advisories: new Map(
        checked
          .filter((d) => d.advisoryIds.length)
          .map((d) => [
            d.id,
            [
              {
                id: d.advisoryIds[0],
                summary: "Mixed refresh fixture advisory",
                severity: phase === 2 ? "critical" : "high",
                fixed: phase === 2 ? "1.7.0" : "1.5.0",
                url: `https://osv.dev/vulnerability/${d.advisoryIds[0]}`,
              },
            ],
          ]),
      ),
      coverage: [],
      errors:
        phase === 2
          ? ["Public-registry version lookup failed.", "Known-advisory lookup failed."]
          : [],
    };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 6);
  phase = 2;
  await scan(coordinator, project.id);
  const mixed = coordinator.snapshot();
  const actionable = mixed.findings.filter((f) => f.kind !== "coverage");
  assert.equal(actionable.length, 4);
  assert.equal(
    actionable.filter((f) => f.name === "refreshed").length,
    0,
    "Fresh current/nonaffected results must clear findings even when another identity fails",
  );
  assert.equal(actionable.filter((f) => f.name === "alias").length, 2);
  assert.ok(
    actionable.filter((f) => f.name === "alias").every((f) => f.availableVersion === "1.7.0"),
  );
  assert.equal(actionable.filter((f) => f.name === "failed").length, 2);
  assert.ok(
    actionable.filter((f) => f.name === "failed").every((f) => f.availableVersion === "1.5.0"),
  );
  assert.equal(mixed.notifications.length, 4);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  assert.equal(coordinator.snapshot().notificationSummary.updateCount, 2);
  assert.equal(coordinator.snapshot().notificationSummary.advisoryCount, 2);
  const pendingIds = mixed.notifications.map((n) => n.id).sort();
  await scan(coordinator, project.id);
  assert.deepEqual(
    coordinator
      .snapshot()
      .notifications.map((n) => n.id)
      .sort(),
    pendingIds,
    "An identical partial rescan must not add notifications",
  );
  phase = 3;
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().projects[0].evidence.status, "failed");
  assert.deepEqual(
    coordinator
      .snapshot()
      .findings.filter((f) => f.kind !== "coverage")
      .map((f) => f.id)
      .sort(),
    actionable.map((f) => f.id).sort(),
    "A whole lookup failure must retain every previous actionable identity",
  );
  assert.deepEqual(
    coordinator
      .snapshot()
      .notifications.map((n) => n.id)
      .sort(),
    pendingIds,
  );
});

test("live progress and one settled summary preserve frozen receipts, new arrivals, and restart cooldown", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const releases = [];
  let calls = 0;
  const lookup = async (dependencies, _signal, onProgress) => {
    const call = ++calls;
    onProgress?.({ stage: "advisories", completed: 0, total: 2 });
    if (call <= 2) await new Promise((resolve) => releases.push(resolve));
    onProgress?.({ stage: "advisories", completed: 2, total: 2 });
    const alias = dependencies.find((d) => d.name === "alias");
    const checked = dependencies.map((d) => ({
      ...d,
      availableVersion: d.id === alias.id ? "1.5.0" : null,
      versionStatus: d.role === "transitive" ? "unsupported" : "checked",
      advisoryStatus: "checked",
      advisoryIds: call === 1 && d.id === alias.id ? ["GHSA-summary"] : [],
    }));
    checked.push({
      ...checked.find((d) => d.id === alias.id),
      id: `${alias.id}-duplicate`,
      importer: "other-workspace",
      advisoryIds: [],
    });
    return {
      dependencies: checked,
      versionChecked: new Set(
        checked.filter((d) => d.versionStatus === "checked").map((d) => d.id),
      ),
      advisories: new Map(
        call === 1
          ? [
              [
                alias.id,
                [
                  {
                    id: "GHSA-summary",
                    summary: "Summary fixture advisory",
                    severity: "high",
                    fixed: "1.5.0",
                    url: "https://osv.dev/vulnerability/GHSA-summary",
                  },
                ],
              ],
            ]
          : [],
      ),
      coverage: [],
      errors: [],
    };
  };
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  coordinator.changeSettings({ paused: true });
  const projects = [];
  for (const name of ["first", "second"]) {
    const projectRoot = join(root, name);
    await npmFixture(projectRoot);
    projects.push(await coordinator.addProject({ path: projectRoot, mode: "maintained" }));
  }
  coordinator.requestScan({ target: "projects" });
  await waitFor(() => releases.length === 1);
  const active = coordinator.snapshot();
  assert.equal(active.scanProgress.active.targetId, projects[0].id);
  assert.equal(active.scanProgress.active.stage, "advisories");
  assert.equal(active.scanProgress.active.completed, 0);
  assert.equal(active.scanProgress.active.total, 2);
  assert.equal(active.scanProgress.queued[0].targetId, projects[1].id);
  assert.equal(active.notificationSummary, null);
  releases[0]();
  await waitFor(() => releases.length === 2);
  assert.equal(
    coordinator.snapshot().notificationSummary,
    null,
    "Remaining target must settle first",
  );
  releases[1]();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  assert.equal(
    coordinator.snapshot().notificationSummary,
    null,
    "Settling interval must remain quiet",
  );
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const initial = coordinator.snapshot();
  const frozen = initial.notificationSummary;
  assert.equal(frozen.updateCount, 2, "Duplicate importer observations count once per project");
  assert.equal(frozen.newUpdateCount, 2);
  assert.equal(frozen.advisoryCount, 1);
  assert.equal(frozen.newAdvisoryCount, 1);
  assert.equal(frozen.projectCount, 2);
  assert.equal(frozen.pcCount, 0);
  assert.equal(frozen.filter, "all");
  assert.equal(frozen.title, "1 security advisory", "New advisories lead the title");
  assert.equal(
    initial.notifications.length,
    5,
    "Per-finding events remain durable behind one summary",
  );

  const thirdRoot = join(root, "third");
  await npmFixture(thirdRoot);
  // Maintained, so its new findings notify; watch-only notifications are off by default.
  const third = await coordinator.addProject({ path: thirdRoot, mode: "maintained" });
  await scan(coordinator, third.id);
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const newer = coordinator.snapshot().notificationSummary;
  assert.equal(newer.id, frozen.id, "New arrivals must not replace the frozen presentation");
  assert.equal(newer.updateCount, 3);
  assert.equal(newer.newUpdateCount, 2);
  assert.equal(newer.title, frozen.title);
  coordinator.acknowledgeNotificationSummary(frozen.id);
  const delivered = coordinator.snapshot();
  assert.equal(delivered.notifications.filter((n) => n.deliveredAt !== null).length, 5);
  assert.equal(
    delivered.notifications.filter((n) => n.deliveredAt === null).length,
    2,
    "The old presentation receipt must leave newly discovered events pending",
  );
  assert.equal(delivered.notificationSummary, null);
  const cooldown = delivered.notificationNextAt;
  coordinator.acknowledgeNotificationSummary(frozen.id);
  assert.equal(
    coordinator.snapshot().notificationNextAt,
    cooldown,
    "Retries must not extend cooldown",
  );
  assert.throws(
    () => coordinator.acknowledgeNotificationSummary("unknown-summary"),
    /no longer available/,
  );
  await coordinator.close();
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  assert.equal(coordinator.snapshot().notificationNextAt, cooldown);
  assert.equal(coordinator.snapshot().notificationSummary, null);
  assert.equal(
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length,
    2,
  );
  assert.equal(coordinator.snapshot().scanProgress.active, null);
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const expired = storage.read();
  expired.snapshot.notificationNextAt = new Date(Date.now() - 1000).toISOString();
  storage.write(expired);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
  const resolved = coordinator.snapshot().notificationSummary;
  assert.equal(resolved.newAdvisoryCount, 0);
  assert.equal(resolved.title, "3 updates available", "Updates title a batch without advisories");
  coordinator.removeProject(third.id);
  assert.equal(
    coordinator.snapshot().notifications.filter((n) => n.deliveredAt === null).length,
    0,
  );
  const beforeResolvedReceipt = coordinator.snapshot().notificationNextAt;
  coordinator.acknowledgeNotificationSummary(resolved.id);
  assert.equal(
    coordinator.snapshot().notificationNextAt,
    beforeResolvedReceipt,
    "Fully resolved summaries must not postpone future notifications",
  );
});

test("shutdown cancels an in-flight public lookup and durably marks interruption without erasing evidence", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const dataDir = join(root, "state");
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "watch" });
  await scan(coordinator, project.id);
  const original = coordinator.snapshot().projects[0];
  await coordinator.close();
  let started = false;
  const blockedFetch = async (_url, options) => {
    started = true;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
  };
  coordinator = new MonitoringCoordinator({
    dataDir,
    dependencyLookup: (deps, signal) => lookupDependencies(deps, blockedFetch, signal),
  });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => started);
  const closing = Date.now();
  await coordinator.close();
  assert.ok(
    Date.now() - closing < 2000,
    "Shutdown should abort requests rather than wait for network timeouts.",
  );
  const storage = new MonitoringStorage(dataDir);
  const retained = storage.read().snapshot;
  storage.close();
  assert.equal(retained.projects[0].evidence.status, "failed");
  assert.equal(retained.projects[0].evidence.lastSuccess, original.evidence.lastSuccess);
  assert.deepEqual(retained.projects[0].dependencies, original.dependencies);
  assert.equal(retained.history[0].status, "failed");
});

test("a failed durable write is recorded as a sanitized attempt error and never escapes the scan worker", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const lookup = async (dependencies) => ({
    dependencies,
    advisories: new Map(),
    coverage: [],
    errors: [],
  });
  const write = MonitoringStorage.prototype.write;
  let writes = 0;
  let failAt = 0;
  t.mock.method(MonitoringStorage.prototype, "write", function (state) {
    if (++writes === failAt) throw new Error(`Storage unavailable at ${root}`);
    return write.call(this, state);
  });
  let updateChecks = "complete";
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
    inventoryLookup: async () => ({
      installations: [],
      coverage: [],
      errors: updateChecks === "failed" ? ["Version lookup failed."] : [],
      inventoryChecks: "complete",
      updateChecks,
      checkedRoots: [],
      managers: [],
    }),
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  const saved = coordinator.snapshot().projects[0];
  assert.equal(saved.evidence.status, "complete");
  const notSaved = "Evidence could not be saved; the previous saved evidence is retained.";

  failAt = writes + 1; // The record written when the attempt starts.
  await scan(coordinator, project.id);
  let attempt = coordinator.snapshot().history[0];
  assert.equal(attempt.status, "failed");
  assert.deepEqual(attempt.errors, [notSaved]);
  const afterStart = coordinator.snapshot().projects[0];
  assert.equal(afterStart.evidence.status, "failed");
  assert.equal(afterStart.evidence.lastSuccess, saved.evidence.lastSuccess);
  assert.deepEqual(afterStart.dependencies, saved.dependencies);

  failAt = writes + 2; // The record written when the attempt finishes.
  await scan(coordinator, project.id);
  attempt = coordinator.snapshot().history[0];
  assert.equal(attempt.status, "partial", "An unsaved attempt is never reported complete");
  assert.deepEqual(attempt.errors, [notSaved]);
  assert.equal(coordinator.snapshot().projects[0].evidence.status, "partial");
  assert.deepEqual(coordinator.snapshot().projects[0].evidence.errors, [notSaved]);

  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().history[0].status, "complete", "The worker keeps running");

  // Anything unexpected outside the attempt's own handling still cannot reject the worker.
  coordinator.mergeFindings = () => {
    throw new Error("Unexpected failure");
  };
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  delete coordinator.mergeFindings;
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().history[0].status, "complete");

  // An unsaved PC result also marks its update checks, never upgrading a failed check.
  for (const [checks, expected] of [
    ["complete", "partial"],
    ["failed", "failed"],
  ]) {
    updateChecks = checks;
    failAt = writes + 2;
    const previous = coordinator.snapshot().history[0].id;
    coordinator.requestScan({ target: "pc" });
    await waitFor(() => {
      const latest = coordinator.snapshot().history[0];
      return latest.id !== previous && latest.status !== "scanning";
    });
    const { history, inventory } = coordinator.snapshot();
    assert.equal(history[0].status, "partial");
    assert.ok(history[0].errors.includes(notSaved));
    assert.equal(inventory.evidence.status, "partial");
    assert.ok(inventory.evidence.errors.includes(notSaved));
    assert.equal(inventory.updateEvidence.status, expected);
    assert.ok(inventory.updateEvidence.errors.includes(notSaved), checks);
  }
});

test("a manual rescan requested during a target's scan runs once afterwards, while scheduled requests do not", async (t) => {
  let coordinator;
  const gates = [];
  t.after(() => {
    for (const release of gates) release();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const lookup = async (dependencies) => {
    await new Promise((resolve) => gates.push(resolve));
    return { dependencies, advisories: new Map(), coverage: [], errors: [] };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => gates.length === 1);

  // The scan's next automatic run becomes due; the active target is still not queued again.
  const clock = t.mock.method(Date, "now", () => Date.parse(new Date().toISOString()) + 7_200_000);
  coordinator.changeSettings({ paused: false });
  clock.mock.restore();
  assert.deepEqual(coordinator.snapshot().scanProgress.queued, []);

  for (let i = 0; i < 3; i++)
    coordinator.requestScan({ target: "projects", projectId: project.id });
  const progress = coordinator.snapshot().scanProgress;
  assert.equal(progress.active.targetId, project.id);
  assert.deepEqual(
    progress.queued.map((target) => target.targetId),
    [project.id],
    "Repeated manual requests queue one rescan behind the active scan",
  );
  gates[0]();
  await waitFor(() => gates.length === 2);
  gates[1]();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  assert.equal(gates.length, 2);
  assert.equal(coordinator.snapshot().history.filter((a) => a.targetId === project.id).length, 2);
  assert.deepEqual(coordinator.snapshot().scanProgress.queued, []);
});

test("removing a project aborts its active scan and ends the attempt failed, never scanning", async (t) => {
  let coordinator;
  let releaseIgnoring;
  t.after(() => {
    releaseIgnoring?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const signals = {};
  const lookup = async (dependencies, signal, _progress, local) => {
    const name = basename(local.root);
    signals[name] = signal;
    if (name === "aborting")
      await new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new InputError("The scan stopped before public package checks finished.")),
          { once: true },
        ),
      );
    if (name === "ignoring")
      await new Promise((resolve) => {
        releaseIgnoring = resolve;
      });
    return { dependencies, advisories: new Map(), coverage: [], errors: [] };
  };
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  coordinator.changeSettings({ paused: true });
  const projects = {};
  for (const name of ["aborting", "ignoring", "survivor"]) {
    await npmFixture(join(root, name));
    projects[name] = await coordinator.addProject({ path: join(root, name), mode: "maintained" });
  }
  const removed = "The project was removed during this scan.";
  const attempt = (name) =>
    coordinator.snapshot().history.find((a) => a.targetId === projects[name].id);

  // A lookup that honors its signal is cancelled by the removal alone, not by shutdown.
  coordinator.requestScan({ target: "projects", projectId: projects.aborting.id });
  await waitFor(() => signals.aborting);
  assert.equal(signals.aborting.aborted, false);
  coordinator.removeProject(projects.aborting.id);
  assert.equal(signals.aborting.aborted, true);
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  assert.equal(attempt("aborting").status, "failed");
  assert.deepEqual(attempt("aborting").errors, [removed]);

  // A lookup that ignores its signal still ends the attempt as removed when it returns.
  coordinator.requestScan({ target: "projects", projectId: projects.ignoring.id });
  await waitFor(() => releaseIgnoring);
  coordinator.removeProject(projects.ignoring.id);
  releaseIgnoring();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  assert.equal(attempt("ignoring").status, "failed");
  assert.deepEqual(attempt("ignoring").errors, [removed]);
  assert.equal(coordinator.snapshot().findings.length, 0);

  await scan(coordinator, projects.survivor.id);
  assert.equal(coordinator.snapshot().projects.length, 1);
  assert.equal(attempt("survivor").status, "complete", "Other scans are not cancelled");
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  assert.ok(storage.read().snapshot.history.every((a) => a.status !== "scanning"));
  storage.close();
});

test("findings seen while notifications are off are not announced when they are re-enabled", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  let available = "1.5.0";
  const lookup = async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: d.name === "alias" ? available : null,
      versionStatus: d.role === "transitive" ? "unsupported" : "checked",
      advisoryStatus: "checked",
    })),
    advisories: new Map(),
    coverage: [],
    errors: [],
  });
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  coordinator.changeSettings({ paused: true, notifyNewFindings: false });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  const updates = () => coordinator.snapshot().findings.filter((f) => f.kind === "update");
  assert.equal(updates().length, 1);
  assert.equal(coordinator.snapshot().notifications.length, 0);

  coordinator.changeSettings({ notifyNewFindings: true });
  await scan(coordinator, project.id);
  assert.equal(
    coordinator.snapshot().notifications.length,
    0,
    "The backlog recorded while notifications were off is not new",
  );
  available = "1.7.0";
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().notifications.length, 1, "A later finding still notifies");

  // Recorded identities follow the current findings instead of growing without bound.
  available = null;
  await scan(coordinator, project.id);
  assert.equal(updates().length, 0);
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  assert.deepEqual(storage.read().notified, []);
  storage.close();
});

test("due entries of removed projects or projects without automatic scans are ignored", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const projectRoot = join(root, "project");
  await npmFixture(projectRoot);
  const lookup = async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: d.name === "alias" ? "1.5.0" : null,
      versionStatus: d.role === "transitive" ? "unsupported" : "checked",
      advisoryStatus: "checked",
    })),
    advisories: new Map(),
    coverage: [],
    errors: [],
  });
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await scan(coordinator, project.id);
  coordinator.changeSettings({ paused: false });
  const scheduled = coordinator.snapshot().runtime.nextScanAt;
  assert.ok(Date.parse(scheduled) > Date.now());

  const inspect = (selected) => inspectProject(selected.path);
  coordinator.configureProjectInspection(inspect, () => false);
  assert.equal(coordinator.snapshot().runtime.nextScanAt, null);
  coordinator.configureProjectInspection(inspect, () => true);
  assert.equal(coordinator.snapshot().runtime.nextScanAt, scheduled);
  // Application preferences decide eligibility without persist(); the cached snapshot follows.
  let automatic = true;
  coordinator.configureProjectInspection(inspect, () => automatic);
  coordinator.readApplication(); // Creates the table the first write needs.
  const revision = coordinator.revision;
  automatic = false;
  coordinator.writeApplication({});
  assert.notEqual(coordinator.revision, revision);
  assert.equal(JSON.parse(coordinator.snapshotJson()).runtime.nextScanAt, null);
  automatic = true;
  coordinator.writeApplication({});
  assert.equal(JSON.parse(coordinator.snapshotJson()).runtime.nextScanAt, scheduled);
  const unchanged = coordinator.revision;
  coordinator.writeApplication({});
  assert.equal(coordinator.revision, unchanged, "Unrelated application writes keep the cache");

  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  const stored = storage.read();
  stored.due["removed-project"] = 1;
  storage.write(stored);
  storage.close();
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  assert.equal(coordinator.snapshot().runtime.nextScanAt, scheduled);
  // A stale entry must not keep restarting the worker, which would postpone the summary forever.
  await waitFor(() => coordinator.snapshot().notificationSummary !== null);
});

// A complete saved state with findings for the PC and two projects.
function storedFixture() {
  const at = "2026-10-01T10:00:00.000Z";
  const evidence = {
    status: "complete",
    lastAttempt: at,
    lastSuccess: at,
    coverage: ["lockfile"],
    errors: [],
  };
  const project = (id) => ({
    id,
    name: id,
    path: `/projects/${id}`,
    mode: "maintained",
    packageManager: "npm",
    manifestPath: `/projects/${id}/package.json`,
    lockfilePath: `/projects/${id}/package-lock.json`,
    evidence: { ...evidence },
    dependencies: [
      {
        id: `${id}-alias`,
        name: "alias",
        packageName: "public-example",
        requested: "^1.0.0",
        resolved: "1.0.0",
        origin: "registry",
        role: "production",
        importer: ".",
        availableVersion: "1.5.0",
        latestVersion: null,
        versionStatus: "checked",
        advisoryStatus: "checked",
        advisoryIds: [],
      },
    ],
    createdAt: at,
  });
  const finding = (id, subjectId, kind = "update") => ({
    id,
    kind,
    subjectId,
    subjectLabel: subjectId,
    name: "alias",
    packageName: "public-example",
    installedVersion: "1.0.0",
    availableVersion: "1.5.0",
    severity: kind === "advisory" ? "high" : "info",
    source: "npm registry",
    description: "A newer version satisfies the requested range.",
    advisoryUrl: null,
    detectedAt: at,
    lastSeenAt: at,
  });
  return {
    snapshot: {
      protocolVersion: 1,
      runtime: {
        startedAt: at,
        mode: "interactive",
        host: "session",
        platform: "win32",
        nextScanAt: null,
      },
      device: { id: "device-1", label: "Owner PC", platform: "win32" },
      settings: {
        paused: true,
        pcIntervalMinutes: 120,
        projectIntervalMinutes: 30,
        notifyNewFindings: true,
      },
      inventory: {
        collector: "npm-bun-global-v1",
        managers: [],
        evidence: { ...evidence },
        updateEvidence: { ...evidence },
        installations: [
          {
            id: "tool",
            name: "tool",
            version: "1.0.0",
            source: "npm global",
            scope: "user",
            channel: "stable",
            availableVersion: "2.0.0",
            updateStatus: "available",
          },
        ],
      },
      projects: [project("project-a"), project("project-b")],
      findings: [
        finding("pc-update", "device-1"),
        finding("a-update", "project-a"),
        finding("a-advisory", "project-a", "advisory"),
        finding("b-update", "project-b"),
      ],
      history: [
        {
          id: "attempt",
          targetId: "project-a",
          targetLabel: "project-a",
          kind: "project",
          startedAt: at,
          finishedAt: at,
          status: "complete",
          coverage: ["lockfile"],
          errors: [],
        },
      ],
      notifications: [
        {
          id: "pending",
          findingId: "a-update",
          title: "a",
          body: "b",
          createdAt: at,
          deliveredAt: null,
        },
        {
          id: "sent",
          findingId: "b-update",
          title: "a",
          body: "b",
          createdAt: at,
          deliveredAt: at,
        },
      ],
      notificationNextAt: "2026-10-01T10:05:00.000Z",
    },
    due: { pc: 1, "project-a": 2, "project-b": 3 },
    notified: ["pc-update", "a-update", "a-advisory", "b-update"],
  };
}

test("a version 1 database migrates to per-subject rows in one transaction and keeps every record", async (t) => {
  let database;
  t.after(() => database?.isOpen && database.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  await mkdir(dataDir);
  const stored = storedFixture();
  // The schema version 1 statements, so the migration runs against a real older database.
  database = new DatabaseSync(join(dataDir, "monitoring.sqlite"));
  database.exec(`PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
    CREATE TABLE monitoring_state (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, due TEXT NOT NULL, notified TEXT NOT NULL);
    PRAGMA user_version=1;
    COMMIT;`);
  database
    .prepare("INSERT INTO monitoring_state(id,snapshot,due,notified) VALUES(1,?,?,?)")
    .run(
      JSON.stringify(stored.snapshot),
      JSON.stringify(stored.due),
      JSON.stringify(stored.notified),
    );
  database.exec(
    "CREATE TABLE application_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
  );
  database.prepare("INSERT INTO application_state(id,value) VALUES(1,?)").run('{"theme":"dark"}');
  const version = () => database.prepare("PRAGMA user_version").get().user_version;
  const tables = () =>
    database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
  const v1 = () => ({ ...database.prepare("SELECT * FROM monitoring_state").get() });
  const original = v1();

  // Invalid saved state is refused before anything is written.
  database.prepare("UPDATE monitoring_state SET notified=?").run('{"not":"a list"}');
  assert.throws(
    () => new MonitoringStorage(dataDir),
    /^Error: The monitoring database contains an invalid schedule state\.$/,
  );
  database.prepare("UPDATE monitoring_state SET notified=?").run(original.notified);
  // A failure after the split rows are written (the v1 table cannot be dropped) rolls them back.
  database.exec(
    "CREATE TABLE pin (state INTEGER REFERENCES monitoring_state(id)); INSERT INTO pin VALUES (1);",
  );
  assert.throws(() => new MonitoringStorage(dataDir), /FOREIGN KEY constraint failed/);
  assert.equal(version(), 1);
  assert.deepEqual(tables(), ["application_state", "monitoring_state", "pin"]);
  assert.deepEqual(v1(), original);
  database.exec("DROP TABLE pin");

  const storage = new MonitoringStorage(dataDir);
  try {
    assert.equal(version(), 2);
    assert.deepEqual(tables(), [
      "application_state",
      "monitoring_findings",
      "monitoring_meta",
      "monitoring_projects",
    ]);
    assert.deepEqual(
      database
        .prepare("SELECT subject_id FROM monitoring_findings")
        .all()
        .map((r) => r.subject_id),
      ["device-1", "project-a", "project-b"],
    );
    // Device, settings, projects, findings, history, notifications, due and notified survive.
    assert.deepEqual(storage.read(), stored);
    assert.deepEqual(storage.readApplication(), { theme: "dark" });
  } finally {
    storage.close();
  }
  database.exec("PRAGMA user_version=3");
  assert.throws(() => new MonitoringStorage(dataDir), /needs a newer Versionstead version/);
});

test("a project scan rewrites only its own rows, removal deletes them and a restart reads the same state", async (t) => {
  let coordinator;
  let database;
  t.after(async () => {
    if (database?.isOpen) database.close();
    await coordinator?.close();
  });
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const lookup = async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: d.name === "alias" ? "1.5.0" : null,
      versionStatus: d.role === "transitive" ? "unsupported" : "checked",
      advisoryStatus: "checked",
    })),
    advisories: new Map(),
    coverage: [],
    errors: [],
  });
  coordinator = new MonitoringCoordinator({ dataDir, dependencyLookup: lookup });
  coordinator.changeSettings({ paused: true });
  const projects = [];
  for (const name of ["first", "second"]) {
    await npmFixture(join(root, name));
    projects.push(await coordinator.addProject({ path: join(root, name), mode: "maintained" }));
    await scan(coordinator, projects.at(-1).id);
  }
  const [first, second] = projects;
  database = new DatabaseSync(join(dataDir, "monitoring.sqlite"));
  // A leading space keeps every row valid JSON and marks the rows later writes leave alone.
  database.exec(`UPDATE monitoring_meta SET value=' '||value;
    UPDATE monitoring_projects SET value=' '||value;
    UPDATE monitoring_findings SET value=' '||value;`);
  await scan(coordinator, first.id);
  assert.deepEqual(
    database
      .prepare(
        `SELECT 'meta' AS row FROM monitoring_meta WHERE value NOT LIKE ' %'
        UNION ALL SELECT 'project ' || id FROM monitoring_projects WHERE value NOT LIKE ' %'
        UNION ALL SELECT 'findings ' || subject_id FROM monitoring_findings WHERE value NOT LIKE ' %'`,
      )
      .all()
      .map((r) => r.row)
      .sort(),
    ["findings " + first.id, "meta", "project " + first.id].sort(),
  );

  coordinator.removeProject(second.id);
  assert.deepEqual(
    database
      .prepare("SELECT id FROM monitoring_projects")
      .all()
      .map((r) => r.id),
    [first.id],
  );
  assert.deepEqual(
    database
      .prepare("SELECT subject_id FROM monitoring_findings")
      .all()
      .map((r) => r.subject_id),
    [first.id],
  );

  // The stored state, without the live fields the snapshot adds.
  const expected = coordinator.snapshot();
  delete expected.features;
  delete expected.scanProgress;
  delete expected.notificationSummary;
  delete expected.notificationsWaiting; // derived, never stored
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  try {
    assert.deepEqual(storage.read().snapshot, expected);
  } finally {
    storage.close();
  }
});

test("a failed storage write rolls back every row and a corrupt row fails clearly", async (t) => {
  let storage;
  let database;
  t.after(() => {
    storage?.close();
    if (database?.isOpen) database.close();
  });
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const before = storedFixture();
  storage = new MonitoringStorage(dataDir);
  storage.write(before);
  database = new DatabaseSync(join(dataDir, "monitoring.sqlite"));
  const after = structuredClone(before);
  after.snapshot.history[0].status = "partial";
  after.snapshot.projects[0].evidence.status = "partial";
  after.snapshot.findings[1].lastSeenAt = "2026-10-02T10:00:00.000Z";
  after.snapshot.projects.pop();
  after.snapshot.findings = after.snapshot.findings.filter((f) => f.subjectId !== "project-b");
  const reopened = () => {
    const reader = new MonitoringStorage(dataDir);
    try {
      return reader.read();
    } finally {
      reader.close();
    }
  };

  // The removed subject's findings are deleted last, after every other row has been written.
  database.exec(`CREATE TRIGGER fail BEFORE DELETE ON monitoring_findings
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  assert.throws(() => storage.write(after), /simulated write failure/);
  assert.deepEqual(reopened(), before);
  database.exec("DROP TRIGGER fail");
  // The failed write is not remembered as written.
  storage.write(after);
  assert.deepEqual(reopened(), after);

  for (const [corruption, message] of [
    ["UPDATE monitoring_projects SET value='{'", /invalid project record/],
    ["UPDATE monitoring_projects SET value=json_remove(value,'$.evidence')", /invalid monitoring/],
    [
      "UPDATE monitoring_findings SET subject_id='other' WHERE subject_id='project-a'",
      /invalid findings record/,
    ],
    ["DELETE FROM monitoring_meta", /invalid monitoring state record/],
  ]) {
    database.exec(corruption);
    const reader = new MonitoringStorage(dataDir);
    try {
      assert.throws(() => reader.read(), message, corruption);
      // A storage that remembers no rows rewrites all of them.
      reader.write(after);
    } finally {
      reader.close();
    }
    assert.deepEqual(reopened(), after, corruption);
  }
});

test("Cancel stops only the running scan, records it as cancelled by you, and keeps previous evidence", async (t) => {
  let coordinator;
  let release;
  t.after(() => {
    release?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const signals = [];
  const modes = [];
  const lookup = async (dependencies, signal) => {
    signals.push(signal);
    const mode = modes.shift() ?? "complete";
    // "honor" rejects when its signal aborts; "ignore" returns normally once released.
    if (mode === "honor")
      await new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new InputError("The scan stopped before public package checks finished.")),
          { once: true },
        ),
      );
    if (mode === "ignore") await new Promise((resolve) => (release = resolve));
    return {
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.name === "alias" ? (mode === "complete" ? "1.5.0" : "9.9.9") : null,
        advisoryStatus: "checked",
      })),
      advisories: new Map(),
      coverage: [`Injected ${mode} evidence`],
      errors: [],
    };
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: lookup,
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "one"));
  await npmFixture(join(root, "two"));
  const one = await coordinator.addProject({ path: join(root, "one"), mode: "maintained" });
  const two = await coordinator.addProject({ path: join(root, "two"), mode: "maintained" });
  await scan(coordinator, one.id);
  const before = coordinator.snapshot();
  const evidence = before.projects.find((p) => p.id === one.id).evidence;
  const findings = before.findings.filter((f) => f.subjectId === one.id);
  for (const mode of ["honor", "ignore"]) {
    release = undefined;
    modes.push(mode, "complete");
    const calls = signals.length;
    coordinator.requestScan({ target: "projects", projectId: one.id });
    coordinator.requestScan({ target: "projects", projectId: two.id });
    await waitFor(() => signals.length > calls && (mode === "honor" || release));
    const { scanId, targetId } = coordinator.snapshot().scanProgress.active;
    assert.equal(targetId, one.id);
    coordinator.cancelScan(scanId);
    coordinator.cancelScan(scanId); // a second click while it stops changes nothing
    release?.();
    await waitFor(() => {
      const progress = coordinator.snapshot().scanProgress;
      return progress.active === null && progress.queued.length === 0;
    });
    const after = coordinator.snapshot();
    const attempt = after.history.find((a) => a.targetId === one.id);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.cancelled, true);
    assert.deepEqual(attempt.errors, ["Cancelled by you"]);
    assert.deepEqual(after.projects.find((p) => p.id === one.id).evidence, evidence);
    assert.deepEqual(
      after.findings.filter((f) => f.subjectId === one.id),
      findings,
    );
    assert.equal(
      after.history.find((a) => a.targetId === two.id).status,
      "complete",
      "the queued scan still runs",
    );
  }
  // A Cancel that reaches a finished scan is refused and changes nothing.
  const finished = coordinator.snapshot().history.find((a) => a.targetId === two.id);
  assert.throws(() => coordinator.cancelScan(finished.id), /already finished/);
  assert.equal(
    coordinator.snapshot().history.find((a) => a.targetId === two.id).status,
    "complete",
  );
});

test("Cancel is refused once a scan is writing its results, which then finish normally", async (t) => {
  let coordinator;
  let respond;
  t.after(() => {
    respond?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => ({
      dependencies,
      advisories: new Map(),
      coverage: [],
      errors: [],
    }),
    // Plan A's lifecycle lookup runs after the scan has written its dependencies; hold it open.
    // A 500 is not retried (a 429 or 503 would be asked again and never answered).
    sourceFetch: () =>
      new Promise((resolve) => (respond = () => resolve(new Response("{}", { status: 500 })))),
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"), { engines: { node: ">=24" } });
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => respond);
  const active = coordinator.snapshot().scanProgress.active;
  assert.equal(active.writing, true);
  // The page reads the decoded progress, so the contract must carry the flag too.
  assert.equal(coordinator.progressSnapshot().scanProgress.active.writing, true);
  assert.throws(() => coordinator.cancelScan(active.scanId), /can no longer be cancelled/);
  respond();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  const attempt = coordinator.snapshot().history[0];
  assert.notEqual(attempt.cancelled, true);
  assert.notEqual(coordinator.snapshot().projects[0].evidence.lastSuccess, null);
});

test("Cancel is refused once This PC has written its inventory, which then finishes normally", async (t) => {
  let coordinator;
  let respond;
  t.after(() => {
    respond?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    inventoryLookup: async () => ({
      installations: [publicTool],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    }),
    // The release-facts lookup runs after This PC has written its inventory; hold it open. A 500 is
    // not retried (a 429 or 503 would be asked again and never answered).
    sourceFetch: () =>
      new Promise((resolve) => (respond = () => resolve(new Response("{}", { status: 500 })))),
  });
  coordinator.changeSettings({ paused: true });
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => respond);
  const active = coordinator.progressSnapshot().scanProgress.active;
  assert.equal(active.writing, true);
  assert.throws(() => coordinator.cancelScan(active.scanId), /can no longer be cancelled/);
  respond();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  const { history, inventory } = coordinator.snapshot();
  assert.notEqual(history[0].cancelled, true);
  assert.equal(inventory.installations.length, 1);
  assert.notEqual(inventory.evidence.lastSuccess, null);
});

test("Retry failed checks rescans only targets that still exist and failed or left gaps", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => ({
      dependencies,
      advisories: new Map(),
      coverage: [],
      errors: [],
    }),
  });
  coordinator.changeSettings({ paused: true });
  const projects = {};
  for (const name of ["ok", "broken", "gone"]) {
    await npmFixture(join(root, name));
    projects[name] = await coordinator.addProject({ path: join(root, name), mode: "maintained" });
  }
  await writeFile(join(root, "broken", "package-lock.json"), "broken");
  await writeFile(join(root, "gone", "package-lock.json"), "broken");
  for (const name of ["ok", "broken", "gone"]) await scan(coordinator, projects[name].id);
  assert.deepEqual(
    coordinator.snapshot().projects.map((p) => p.evidence.status),
    ["complete", "failed", "failed"],
  );
  // The page counted two failed targets; one is removed before Retry reaches the coordinator.
  coordinator.removeProject(projects.gone.id);
  const attempts = (id) => coordinator.snapshot().history.filter((a) => a.targetId === id).length;
  const before = { ok: attempts(projects.ok.id), broken: attempts(projects.broken.id) };
  coordinator.requestScan({ target: "failed" });
  await waitFor(() => {
    const progress = coordinator.snapshot().scanProgress;
    return progress.active === null && progress.queued.length === 0;
  });
  assert.equal(attempts(projects.broken.id), before.broken + 1);
  assert.equal(attempts(projects.ok.id), before.ok);
  assert.equal(
    coordinator.snapshot().inventory.evidence.lastAttempt,
    null,
    "an unscanned PC has no failed check",
  );
  assert.throws(
    () => coordinator.requestScan({ target: "failed", projectId: projects.ok.id }),
    /Invalid scan target/,
  );
});

test("Retry failed checks includes a target that left gaps and This PC when only its update checks failed", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  let gaps = true;
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => ({
      dependencies,
      advisories: new Map(),
      coverage: [],
      errors: gaps ? ["Advisory lookup failed."] : [],
    }),
    inventoryLookup: async () => ({
      installations: [],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: gaps ? "failed" : "complete",
    }),
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  const idle = () => {
    const progress = coordinator.snapshot().scanProgress;
    return progress.active === null && progress.queued.length === 0;
  };
  coordinator.requestScan({ target: "all" });
  await waitFor(idle);
  const status = () => {
    const { inventory, projects } = coordinator.snapshot();
    return [
      inventory.evidence.status,
      inventory.updateEvidence.status,
      projects[0].evidence.status,
    ];
  };
  assert.deepEqual(status(), ["complete", "failed", "partial"]);
  const attempts = () => coordinator.snapshot().history.length;

  // Both are asked again, and once they recover a second Retry has nothing left to do.
  gaps = false;
  const before = attempts();
  coordinator.requestScan({ target: "failed" });
  await waitFor(idle);
  assert.equal(attempts(), before + 2);
  assert.deepEqual(status(), ["complete", "complete", "complete"]);
  coordinator.requestScan({ target: "failed" });
  assert.equal(coordinator.snapshot().scanProgress.active, null);
  assert.equal(attempts(), before + 2);
});

test("Retry failed checks queues nothing for a project that is rescanning", async (t) => {
  let coordinator;
  let release;
  t.after(() => {
    release?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  let mode = "fail";
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => {
      if (mode === "fail") throw new Error("Lookup unavailable.");
      if (mode === "hold") await new Promise((resolve) => (release = resolve));
      return { dependencies, advisories: new Map(), coverage: [], errors: [] };
    },
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().projects[0].evidence.status, "failed");
  mode = "hold";
  coordinator.requestScan({ target: "failed" });
  await waitFor(() => release);
  // A second Retry, while the first one's rescan is under way, has nothing to add.
  coordinator.requestScan({ target: "failed" });
  assert.equal(coordinator.snapshot().scanProgress.queued.length, 0);
  mode = "ok";
  release();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  const attempts = coordinator.snapshot().history.filter((a) => a.targetId === project.id);
  assert.equal(attempts.length, 2, "the failure and its one rescan");
});

test("Retry failed checks queues nothing for This PC while its scan finishes", async (t) => {
  let coordinator;
  let respond;
  t.after(() => {
    respond?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    inventoryLookup: async () => ({
      installations: [publicTool],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: ["One update check failed."],
      inventoryChecks: "complete",
      updateChecks: "partial",
    }),
    // Held in the release-facts lookup, after the update checks took their final status.
    sourceFetch: () =>
      new Promise((resolve) => (respond = () => resolve(new Response("{}", { status: 500 })))),
  });
  coordinator.changeSettings({ paused: true });
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => respond);
  const { inventory } = coordinator.snapshot();
  assert.deepEqual(
    [inventory.evidence.status, inventory.updateEvidence.status],
    ["scanning", "partial"],
  );
  coordinator.requestScan({ target: "failed" });
  assert.equal(coordinator.snapshot().scanProgress.queued.length, 0);
  respond();
  await waitFor(() => coordinator.snapshot().scanProgress.active === null);
  const attempts = coordinator.snapshot().history.filter((a) => a.kind === "pc");
  assert.equal(attempts.length, 1, "no second scan of This PC");
});

test("a Cancel restores This PC's and a project's previous evidence, even when the final save fails", async (t) => {
  let coordinator;
  let release;
  let failAt = 0;
  t.after(() => {
    failAt = 0;
    release?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const write = MonitoringStorage.prototype.write;
  let writes = 0;
  t.mock.method(MonitoringStorage.prototype, "write", function (state) {
    if (++writes === failAt) throw new Error(`Storage unavailable at ${root}`);
    return write.call(this, state);
  });
  // A "held" lookup ignores the scan's signal and answers differently everywhere a scan writes.
  const modes = [];
  const answer = async () => {
    const mode = modes.shift() ?? "first";
    if (mode === "held") await new Promise((resolve) => (release = resolve));
    return mode;
  };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => {
      const mode = await answer();
      return {
        dependencies: dependencies.map((d) => ({
          ...d,
          availableVersion: d.name === "alias" ? (mode === "held" ? "9.9.9" : "1.5.0") : null,
        })),
        advisories: new Map(),
        coverage: [`${mode} evidence`],
        errors: [],
      };
    },
    inventoryLookup: async () => {
      const mode = await answer();
      return {
        installations: mode === "held" ? [publicTool] : [],
        managers: [],
        checkedRoots: [],
        coverage: [`${mode} inventory`],
        errors: [],
        inventoryChecks: "complete",
        updateChecks: "complete",
      };
    },
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  const idle = () => {
    const progress = coordinator.snapshot().scanProgress;
    return progress.active === null && progress.queued.length === 0;
  };
  coordinator.requestScan({ target: "all" });
  await waitFor(idle);
  const stateNow = () => {
    const { inventory, projects, findings } = coordinator.snapshot();
    return { inventory, projects, findings };
  };
  const before = stateNow();
  assert.deepEqual(
    [before.inventory.evidence, before.inventory.updateEvidence, before.projects[0].evidence].map(
      (evidence) => evidence.status,
    ),
    ["complete", "complete", "complete"],
  );
  assert.equal(before.findings.length, 1, "the project's update finding");

  const notSaved = "Evidence could not be saved; the previous saved evidence is retained.";
  for (const failSave of [false, true])
    for (const request of [{ target: "pc" }, { target: "projects", projectId: project.id }]) {
      const label = `${request.target}, ${failSave ? "the final save fails" : "the final save works"}`;
      modes.push("held");
      release = undefined;
      const finishedId = coordinator.snapshot().history[0].id;
      // The record written when the scan starts comes first, then the one when it ends.
      failAt = failSave ? writes + 2 : 0;
      coordinator.requestScan(request);
      await waitFor(() => release);
      // A Cancel that names the scan before this one stops nothing.
      assert.throws(() => coordinator.cancelScan(finishedId), /already finished/, label);
      coordinator.cancelScan(coordinator.snapshot().scanProgress.active.scanId);
      release();
      await waitFor(idle);
      const attempt = coordinator.snapshot().history[0];
      assert.equal(attempt.cancelled, true, label);
      assert.deepEqual(
        attempt.errors,
        failSave ? ["Cancelled by you", notSaved] : ["Cancelled by you"],
        label,
      );
      assert.deepEqual(stateNow(), before, label);
      // Nothing reads as failed, so Retry failed checks has nothing to start.
      coordinator.requestScan({ target: "failed" });
      assert.equal(coordinator.snapshot().scanProgress.active, null, label);
    }
});

test("a Cancel followed by shutdown leaves the previous evidence on disk, and shutdown first refuses the Cancel", async (t) => {
  let coordinator;
  let release;
  t.after(() => {
    release?.();
    return coordinator?.close();
  });
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const modes = ["first", "held"];
  coordinator = new MonitoringCoordinator({
    dataDir,
    dependencyLookup: async (dependencies) => {
      const mode = modes.shift();
      if (mode === "held") await new Promise((resolve) => (release = resolve));
      return {
        dependencies: dependencies.map((d) => ({
          ...d,
          availableVersion: d.name === "alias" ? (mode === "first" ? "1.5.0" : "9.9.9") : null,
        })),
        advisories: new Map(),
        coverage: [`Injected ${mode} evidence`],
        errors: [],
      };
    },
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  await scan(coordinator, project.id);
  const before = coordinator.snapshot();
  assert.ok(before.findings.some((f) => f.availableVersion === "1.5.0"));
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => release);
  const { scanId } = coordinator.snapshot().scanProgress.active;
  coordinator.cancelScan(scanId);
  const closing = coordinator.close();
  assert.throws(() => coordinator.cancelScan(scanId), /stopping/);
  release();
  await closing;
  const reader = new MonitoringStorage(dataDir);
  try {
    const { snapshot } = reader.read();
    assert.deepEqual(snapshot.projects[0].evidence, before.projects[0].evidence);
    assert.deepEqual(snapshot.findings, before.findings);
    assert.equal(snapshot.history[0].cancelled, true);
  } finally {
    reader.close();
  }
});

test("resolved findings last 30 days across restarts, leave when reopened, and go with their project", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  let available = "1.5.0";
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  const options = {
    dataDir: join(root, "state"),
    now: () => clock,
    dependencyLookup: async (dependencies) => ({
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.name === "alias" ? available : null,
        advisoryStatus: "checked",
      })),
      advisories: new Map(),
      coverage: [],
      errors: [],
    }),
  };
  coordinator = new MonitoringCoordinator(options);
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  const evidence = () => coordinator.snapshot().projects[0].evidence;
  await scan(coordinator, project.id);
  const first = evidence();
  assert.equal(first.previousSuccess, null, "a first success has no previous one");
  available = "1.6.0"; // a newer release: the same open problem
  await scan(coordinator, project.id);
  assert.equal(evidence().previousSuccess, first.lastSuccess);
  assert.deepEqual(coordinator.snapshot().resolvedFindings, []);
  available = null;
  await scan(coordinator, project.id);
  const resolved = coordinator.snapshot().resolvedFindings;
  assert.deepEqual(
    resolved.map((f) => [f.availableVersion, f.resolvedAt]),
    [["1.6.0", new Date(clock).toISOString()]],
  );
  await coordinator.close();
  coordinator = new MonitoringCoordinator(options);
  assert.deepEqual(coordinator.snapshot().resolvedFindings, resolved, "kept across a restart");
  available = "1.6.0"; // reported again: open, so no longer resolved
  await scan(coordinator, project.id);
  assert.deepEqual(coordinator.snapshot().resolvedFindings, []);
  available = null;
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().resolvedFindings.length, 1);
  await coordinator.close();
  clock += 31 * 86_400_000;
  coordinator = new MonitoringCoordinator(options);
  assert.deepEqual(coordinator.snapshot().resolvedFindings, [], "older than 30 days");
  available = "1.6.0";
  await scan(coordinator, project.id);
  available = null;
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().resolvedFindings.length, 1);
  coordinator.removeProject(project.id);
  assert.deepEqual(coordinator.snapshot().resolvedFindings, []);
});

test("a stale lockfile leaves findings unknown, never resolved", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    // Like the public lookups: a dependency the lockfile does not resolve is not checked.
    dependencyLookup: async (dependencies) => ({
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.resolved && d.name === "alias" ? "1.5.0" : null,
        versionStatus: d.resolved ? "checked" : "unsupported",
        advisoryStatus: d.resolved ? "checked" : "unsupported",
      })),
      advisories: new Map(),
      coverage: [],
      errors: [],
    }),
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  const lockfile = join(root, "app", "package-lock.json");
  const resolvedLockfile = await readFile(lockfile, "utf8");
  const updates = () => coordinator.snapshot().findings.filter((f) => f.kind === "update");
  await scan(coordinator, project.id);
  assert.equal(updates().length, 1);
  // The lockfile loses its entries, so the manifest's dependency has no resolved version and its
  // update and advisory checks are skipped. A skipped check says nothing about the finding.
  await writeFile(
    lockfile,
    JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" } } }),
  );
  await scan(coordinator, project.id);
  assert.equal(coordinator.snapshot().projects[0].evidence.status, "partial");
  assert.deepEqual(
    coordinator.snapshot().resolvedFindings,
    [],
    "a skipped check is not a resolution",
  );
  await writeFile(lockfile, resolvedLockfile);
  await scan(coordinator, project.id);
  assert.equal(updates().length, 1);
  assert.deepEqual(coordinator.snapshot().resolvedFindings, []);
});

test("evidence saved before resolved history loads with an empty list and an unknown previous success", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  await coordinator.close();
  const storage = new MonitoringStorage(dataDir);
  try {
    const stored = storage.read();
    delete stored.snapshot.resolvedFindings;
    const older = {
      ...stored.snapshot.projects[0].evidence,
      lastSuccess: "2026-10-01T00:00:00.000Z",
    };
    delete older.previousSuccess;
    stored.snapshot.projects[0].evidence = older;
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  const loaded = coordinator.snapshot();
  assert.deepEqual(loaded.resolvedFindings, []);
  assert.equal(
    "previousSuccess" in loaded.projects[0].evidence,
    false,
    "unknown until the next success",
  );
});

test("resolved findings older than 30 days leave on a schedule tick, without a restart", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const dataDir = join(root, "state");
  const day = 86_400_000;
  const advisory = {
    id: "GHSA-test-0001",
    summary: "A known advisory.",
    severity: "high",
    url: "https://osv.dev/vulnerability/GHSA-test-0001",
    fixed: "1.0.1",
    detailsUnavailable: false,
  };
  let available = "1.5.0";
  let advised = true;
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  coordinator = new MonitoringCoordinator({
    dataDir,
    now: () => clock,
    dependencyLookup: async (dependencies) => ({
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.name === "alias" ? available : null,
        advisoryStatus: "checked",
        advisoryIds: advised && d.name === "alias" ? [advisory.id] : [],
      })),
      advisories: new Map(
        advised
          ? dependencies.filter((d) => d.name === "alias").map((d) => [d.id, [advisory]])
          : [],
      ),
      coverage: [],
      errors: [],
    }),
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  await scan(coordinator, project.id);
  // The update is resolved now, the advisory 20 days later.
  available = null;
  await scan(coordinator, project.id);
  clock += 20 * day;
  advised = false;
  await scan(coordinator, project.id);
  const kinds = () => coordinator.snapshot().resolvedFindings.map((f) => f.kind);
  assert.deepEqual(kinds(), ["advisory", "update"], "newest first");
  // 31 days after the update and 11 after the advisory: the tick drops only the older entry...
  clock += 11 * day;
  await waitFor(() => kinds().length === 1);
  assert.deepEqual(kinds(), ["advisory"]);
  // ...and saves the removal: the database holds it before anything else writes (close would).
  const reader = new MonitoringStorage(dataDir);
  try {
    const stored = reader.read().snapshot.resolvedFindings;
    assert.deepEqual(
      stored.map((f) => f.kind),
      ["advisory"],
    );
  } finally {
    reader.close();
  }
});

// Runs one This PC scan and waits for its attempt to settle.
async function settledPcScan(coordinator) {
  const previous = coordinator.snapshot().history[0]?.id;
  coordinator.requestScan({ target: "pc" });
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest?.id !== previous && latest?.status !== "scanning";
  });
}

// A project whose `alias` dependency offers an update (1.5.0) and, at 1.0.0 only, has an advisory.
// Public checks answer as the real ones do: all of OSV, or none of it, and likewise the registry.
async function outageProject(t) {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const app = join(root, "app");
  await npmFixture(app);
  const lockfile = join(app, "package-lock.json");
  const lock = JSON.parse(await readFile(lockfile, "utf8"));
  const advisory = {
    id: "GHSA-test-0001",
    summary: "A known advisory.",
    severity: "high",
    url: "https://osv.dev/vulnerability/GHSA-test-0001",
    fixed: "1.0.1",
    detailsUnavailable: false,
  };
  const down = { osv: false, registry: false };
  const affected = (d) => d.name === "alias" && d.resolved === "1.0.0";
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => ({
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.name === "alias" && !down.registry ? "1.5.0" : null,
        ...(d.name === "alias" ? { versionStatus: down.registry ? "failed" : "checked" } : {}),
        advisoryStatus: down.osv ? "failed" : "checked",
        advisoryIds: !down.osv && affected(d) ? [advisory.id] : [],
      })),
      versionChecked: new Set(down.registry ? [] : dependencies.map((d) => d.id)),
      advisories: new Map(
        down.osv ? [] : dependencies.filter(affected).map((d) => [d.id, [advisory]]),
      ),
      coverage: [],
      errors: [
        ...(down.osv
          ? [
              "Known-advisory lookup failed or returned incomplete data; this is not a clean result.",
            ]
          : []),
        ...(down.registry
          ? ["Public-registry version lookup failed; unavailable update evidence remains unknown."]
          : []),
      ],
    }),
  });
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: app, mode: "maintained" });
  const names = (findings) => findings.map((f) => `${f.kind}@${f.installedVersion}`).sort();
  return {
    // Installs `version` of alias, scans with `outage` down, and returns what is resolved.
    async at(version, outage = {}) {
      Object.assign(down, { osv: false, registry: false }, outage);
      const entry = lock.packages["node_modules/alias"];
      entry.version = version;
      entry.resolved = `https://registry.npmjs.org/public-example/-/public-example-${version}.tgz`;
      await writeFile(lockfile, JSON.stringify(lock));
      await scan(coordinator, project.id);
      return names(coordinator.snapshot().resolvedFindings);
    },
    open: () =>
      names(
        coordinator.snapshot().findings.filter((f) => f.kind === "advisory" || f.kind === "update"),
      ),
  };
}

test("findings of a dependency that kept its id stay open and unresolved while its checks are down", async (t) => {
  const project = await outageProject(t);
  await project.at("1.0.0");
  const reported = ["advisory@1.0.0", "update@1.0.0"];
  assert.deepEqual(project.open(), reported);
  assert.deepEqual(await project.at("1.0.0", { osv: true, registry: true }), []);
  assert.deepEqual(project.open(), reported, "kept as the last scan found them");
  assert.deepEqual(await project.at("1.0.0"), []);
  assert.deepEqual(project.open(), reported);
});

test("a lockfile bump while a public check is down leaves the package's findings unresolved", async (t) => {
  // A bumped dependency has a new id, so nothing is kept under it: a check that did not answer for
  // the new version says nothing about what an earlier scan reported, whichever check it was.
  for (const outage of [{ osv: true }, { registry: true }, { osv: true, registry: true }]) {
    const project = await outageProject(t);
    await project.at("1.0.0");
    assert.deepEqual(project.open(), ["advisory@1.0.0", "update@1.0.0"]);
    assert.deepEqual(
      await project.at("1.0.1", outage),
      [],
      `${Object.keys(outage).join(" and ")} down`,
    );
  }
  // Once they answer for the new version, the same bump is a resolution.
  const answered = await outageProject(t);
  await answered.at("1.0.0");
  assert.deepEqual(await answered.at("1.0.1"), ["advisory@1.0.0", "update@1.0.0"]);
});

test("a global tool upgraded while its update check is unknown leaves its findings unresolved", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  const globalRoot = join(root, "npm", "node_modules");
  // The id follows the installed version, as an installation's does.
  const tool = (version, extra) => ({
    id: identity("global-tool", "npm", globalRoot, "tool-alias", "tool", version),
    name: "tool-alias",
    packageId: "tool",
    version,
    manager: "npm",
    rootId: identity("global-root", "npm", globalRoot),
    origin: "registry",
    source: "npm global",
    scope: "user",
    channel: "Stable",
    availableVersion: null,
    updateStatus: "current",
    updateCheckedAt: null,
    ...extra,
  });
  const inventory = (installations, extra) => ({
    installations,
    managers: [],
    checkedRoots: [],
    coverage: [],
    errors: [],
    inventoryChecks: "complete",
    updateChecks: "complete",
    ...extra,
  });
  const read = (installation, deprecated) =>
    new Map([[installation.id, { deprecated, installScript: false, candidateDeprecated: null }]]);
  const names = (findings) => findings.map((f) => `${f.kind}@${f.installedVersion}`).sort();
  const outdated = tool("1.0.0", { availableVersion: "2.0.0", updateStatus: "available" });
  const deprecatedAt1 = inventory([outdated], { signals: read(outdated, "Use new-tool.") });
  const failedCheck = {
    errors: ["A global package version check failed or returned unsupported release metadata."],
    inventoryChecks: "partial",
    updateChecks: "failed",
  };
  let scanned = deprecatedAt1;
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    lookup: false,
    inventoryLookup: async () => scanned,
  });
  coordinator.changeSettings({ paused: true });
  const openNames = () =>
    names(coordinator.snapshot().findings.filter((f) => f.kind !== "coverage"));
  const resolved = () => names(coordinator.snapshot().resolvedFindings);
  await settledPcScan(coordinator);
  assert.deepEqual(openNames(), ["lifecycle@1.0.0", "update@1.0.0"]);
  // The check fails and the tool is unchanged: what was reported is kept, as before.
  scanned = inventory([tool("1.0.0", { updateStatus: "unknown" })], failedCheck);
  await settledPcScan(coordinator);
  assert.deepEqual(openNames(), ["lifecycle@1.0.0", "update@1.0.0"]);
  assert.deepEqual(resolved(), []);
  // The tool is upgraded and the check fails again: nothing says its notice or its update are gone.
  scanned = inventory([tool("1.0.1", { updateStatus: "unknown" })], failedCheck);
  await settledPcScan(coordinator);
  assert.deepEqual(resolved(), []);
  // Once the registry answers for the new version, the upgrade is a resolution.
  scanned = deprecatedAt1;
  await settledPcScan(coordinator);
  assert.deepEqual(openNames(), ["lifecycle@1.0.0", "update@1.0.0"]);
  const upgraded = tool("1.0.1");
  scanned = inventory([upgraded], { signals: read(upgraded, null) });
  await settledPcScan(coordinator);
  assert.deepEqual(resolved(), ["lifecycle@1.0.0", "update@1.0.0"]);
});

test("a scan resolves only its own target's findings", async (t) => {
  let coordinator;
  t.after(() => coordinator?.close());
  const root = await temporary(t);
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  let aliasUpdate = "1.5.0";
  let tool = { version: "1.0.0", availableVersion: "2.0.0", updateStatus: "available" };
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    now: () => clock,
    dependencyLookup: async (dependencies) => ({
      dependencies: dependencies.map((d) => ({
        ...d,
        availableVersion: d.name === "alias" ? aliasUpdate : null,
        advisoryStatus: "checked",
      })),
      advisories: new Map(),
      coverage: [],
      errors: [],
    }),
    inventoryLookup: async () => ({
      installations: [
        {
          id: identity("global-tool", tool.version),
          name: "tool",
          packageId: "tool",
          manager: "npm",
          rootId: "root-npm",
          origin: "registry",
          source: "npm global",
          scope: "user",
          channel: "Stable",
          updateCheckedAt: null,
          ...tool,
        },
      ],
      managers: [],
      checkedRoots: [],
      coverage: [],
      errors: [],
      inventoryChecks: "complete",
      updateChecks: "complete",
    }),
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  const resolved = () =>
    coordinator
      .snapshot()
      .resolvedFindings.map((f) => (f.subjectId === project.id ? "project" : "pc"));
  const updates = (subjectId) =>
    coordinator.snapshot().findings.filter((f) => f.kind === "update" && f.subjectId === subjectId);
  await settledPcScan(coordinator);
  clock += 60_000;
  await scan(coordinator, project.id);
  assert.equal(updates(coordinator.snapshot().device.id).length, 1);
  assert.equal(updates(project.id).length, 1);
  assert.deepEqual(resolved(), [], "a project scan leaves This PC's findings alone");
  // The tool is upgraded: its update is resolved; the project's stays open.
  tool = { version: "2.0.0", availableVersion: null, updateStatus: "current" };
  clock += 60_000;
  await settledPcScan(coordinator);
  assert.deepEqual(resolved(), ["pc"], "a This PC scan leaves the project's findings alone");
  assert.equal(updates(project.id).length, 1);
  aliasUpdate = null;
  clock += 60_000;
  await scan(coordinator, project.id);
  assert.deepEqual(resolved(), ["project", "pc"], "newest first");
});

test("every finding of a successful scan, its incomplete-checks gap included, is detected no later than the scan's last success, even on a slow clock", async (t) => {
  const RealDate = Date;
  let clock = RealDate.parse("2026-10-08T12:00:00.000Z");
  // A clock that moves on at every reading, as a slow machine's does between a scan's last steps.
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        clock += 1;
        super(clock);
      } else super(...args);
    }
    static now() {
      clock += 1;
      return clock;
    }
  };
  let coordinator;
  t.after(() => {
    globalThis.Date = RealDate;
    return coordinator?.close();
  });
  const root = await temporary(t);
  coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => ({
      dependencies,
      advisories: new Map(),
      coverage: [],
      errors: [
        "Known-advisory lookup failed or returned incomplete data; this is not a clean result.",
      ],
    }),
  });
  coordinator.changeSettings({ paused: true });
  await npmFixture(join(root, "app"));
  const project = await coordinator.addProject({ path: join(root, "app"), mode: "maintained" });
  coordinator.requestScan({ target: "projects", projectId: project.id });
  await waitFor(() => coordinator.snapshot().history[0]?.status === "partial");
  const { findings, projects } = coordinator.snapshot();
  const gap = findings.find((f) => f.kind === "coverage");
  assert.ok(gap, "the gap is reported");
  // New since last scan compares detection with the success before the next scan's: a finding stamped
  // after its own scan's success would read as new in the scan after it too.
  assert.ok(
    RealDate.parse(gap.detectedAt) <= RealDate.parse(projects[0].evidence.lastSuccess),
    `${gap.detectedAt} is after ${projects[0].evidence.lastSuccess}`,
  );
});
