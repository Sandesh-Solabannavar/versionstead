import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { declaredRuntimes, pcRuntimes } from "../dist/adapters/runtimes.js";
import { inspectProject, selectDirectory } from "../dist/adapters/projects.js";
import { inspectRepository } from "../dist/adapters/repositories.js";

const none = { nvmrc: null, nodeVersion: null };
const locked = (packageName, resolved, origin = "registry") => ({
  id: `${packageName}@${resolved}`,
  name: packageName,
  packageName,
  requested: null,
  resolved,
  origin,
  role: "transitive",
  importer: ".",
  availableVersion: null,
  latestVersion: null,
  advisoryStatus: "not-checked",
  advisoryIds: [],
});
const lockfile = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { example: "^1.0.0" } },
    "node_modules/example": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    },
  },
});
const repositoryProject = {
  id: "project",
  name: "fixture/repo",
  path: "https://github.com/fixture/repo",
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
  createdAt: "2026-10-08T00:00:00.000Z",
  repository: {
    provider: "github",
    repositoryId: "1",
    name: "fixture/repo",
    ref: "main",
    commit: null,
    url: "https://github.com/fixture/repo",
  },
};

test("declared runtimes use the lowest engines major, numeric version files, pnpm, and the locked electron", () => {
  const { runtimes, notes } = declaredRuntimes(
    {
      engines: { node: "^20.9.0 || >=22" },
      packageManager:
        "pnpm@9.15.0+sha512.76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c",
    },
    { nvmrc: "v20.11.1\n# team default\n", nodeVersion: "22" },
    [
      locked("electron", "38.2.1"),
      locked("electron", "38.2.1"),
      locked("electron", "39.0.0", "unknown"),
    ],
  );
  assert.deepEqual(runtimes, [
    {
      product: "nodejs",
      cycle: "20",
      version: "^20.9.0 || >=22",
      sources: ["engines.node", ".nvmrc"],
    },
    { product: "nodejs", cycle: "22", version: "22", sources: [".node-version"] },
    { product: "pnpm", cycle: "9", version: "9.15.0", sources: ["packageManager"] },
    { product: "electron", cycle: "38", version: "38.2.1", sources: ["electron in the lockfile"] },
  ]);
  assert.deepEqual(notes, []);
  assert.equal(
    declaredRuntimes({ engines: { node: ">=18 <20 || >=22" } }, none, []).runtimes[0].cycle,
    "18",
  );
});

test("unusual runtime declarations become notes, never guesses", () => {
  const cases = [
    [{ engines: { node: "*" } }, {}, /does not set a minimum Node\.js major version/],
    [{ engines: { node: ">=0.10" } }, {}, /does not set a minimum Node\.js major version/],
    [{ engines: { node: "latest and greatest" } }, {}, /not a valid SemVer range/],
    [{ engines: { node: `>=${"9".repeat(200)}` } }, {}, /not a valid SemVer range/],
    [{ engines: { node: "lts/*" } }, {}, /not a valid SemVer range/],
    [{ engines: { node: ">=20 <19" } }, {}, /not a valid SemVer range/],
    [{}, { nvmrc: "lts/*" }, /\.nvmrc names "lts\/\*"; only numeric Node\.js versions are checked/],
    [{}, { nvmrc: "lts/iron" }, /\.nvmrc names "lts\/iron"/],
    [{}, { nodeVersion: "node" }, /\.node-version names "node"/],
    [{}, { nvmrc: "$(curl https://example.invalid)" }, /\.nvmrc has an unsupported value/],
    [{}, { nvmrc: "20\u202e" }, /\.nvmrc has an unsupported value/],
    [{}, { nodeVersion: "a".repeat(41) }, /\.node-version has an unsupported value/],
    [
      { packageManager: "yarn@4.5.0" },
      {},
      /packageManager names yarn; only pnpm's end of life is checked/,
    ],
  ];
  for (const [manifest, files, note] of cases) {
    const result = declaredRuntimes(manifest, { ...none, ...files }, []);
    assert.deepEqual(result.runtimes, [], JSON.stringify([manifest, files]));
    assert.match(result.notes.join("\n"), note);
    assert.ok(!result.notes.join("\n").includes("curl"), "Unsafe file content is never echoed");
    assert.ok(!result.notes.join("\n").includes("\u202e"), "Control characters are never echoed");
    assert.ok(!result.notes.join("\n").includes("a".repeat(41)), "Long values are never echoed");
  }
  assert.deepEqual(
    declaredRuntimes({ engines: { node: 20 } }, { nvmrc: "\n\n", nodeVersion: "" }, []),
    {
      runtimes: [],
      notes: [],
    },
  );
  // A manifest of any shape is read, not trusted: nothing throws and nothing is declared.
  for (const manifest of [
    { engines: null },
    { engines: [] },
    { engines: "node" },
    { engines: { node: null } },
    { engines: { node: "  " } },
    { packageManager: 42 },
  ])
    assert.deepEqual(
      declaredRuntimes(manifest, none, []),
      { runtimes: [], notes: [] },
      JSON.stringify(manifest),
    );
});

test("This PC's runtimes are the captured PATH Node.js and Bun; a missing capture is a note", () => {
  const npm = {
    manager: "npm",
    status: "detected",
    version: "11.7.0",
    root: "C:\\npm\\node_modules",
    registry: "public",
    blockedScopes: [],
    checkedAt: "2026-10-08T00:00:00.000Z",
    error: null,
    nodeVersion: "24.13.1",
  };
  const bun = {
    manager: "bun",
    status: "detected",
    version: "1.4.0",
    root: "C:\\bun\\node_modules",
    registry: "public",
    blockedScopes: [],
    checkedAt: "2026-10-08T00:00:00.000Z",
    error: null,
  };
  const node = {
    product: "nodejs",
    cycle: "24",
    version: "24.13.1",
    sources: ["Node.js on the owner's PATH"],
  };
  assert.deepEqual(pcRuntimes([npm, bun]), {
    runtimes: [node, { product: "bun", cycle: "1", version: "1.4.0", sources: ["Bun on this PC"] }],
    notes: [],
    complete: true,
  });
  const uncaptured = {
    runtimes: [],
    notes: [
      "The Node.js version on the owner's PATH was not captured; its end of life was not checked.",
    ],
    complete: false,
  };
  assert.deepEqual(
    pcRuntimes([
      { ...npm, nodeVersion: null },
      { ...bun, status: "not-installed", version: null, root: null },
    ]),
    uncaptured,
  );
  // Nothing captured at all, or a Node.js version that is not SemVer, is the same unknown.
  assert.deepEqual(pcRuntimes([]), uncaptured);
  assert.deepEqual(pcRuntimes([{ ...npm, nodeVersion: "latest" }]), uncaptured);
  // A Bun that is installed but whose version was not read is unknown, not absent: a note, and the
  // check is incomplete. One that is not installed adds nothing.
  for (const unread of [
    { ...bun, status: "unavailable", version: null, root: null },
    { ...bun, version: "not-a-version" },
    { ...bun, version: "" },
  ])
    assert.deepEqual(pcRuntimes([npm, unread]), {
      runtimes: [node],
      notes: ["Bun's version could not be read; its end of life was not checked."],
      complete: false,
    });
  assert.deepEqual(
    pcRuntimes([npm, { ...bun, status: "not-installed", version: null, root: null }]),
    { runtimes: [node], notes: [], complete: true },
  );
  assert.deepEqual(pcRuntimes([npm]), { runtimes: [node], notes: [], complete: true });
});

test("project inputs carry runtimes without failing on an unreadable runtime file", async (t) => {
  const root = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-runtimes-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ engines: { node: ">=20" }, dependencies: { example: "^1.0.0" } }),
  );
  await writeFile(join(root, "package-lock.json"), lockfile);
  await writeFile(join(root, ".nvmrc"), "2".repeat(5000));
  const inputs = await inspectProject(root);
  assert.deepEqual(inputs.runtimes, [
    { product: "nodejs", cycle: "20", version: ">=20", sources: ["engines.node"] },
  ]);
  assert.ok(inputs.coverage.some((line) => /\.nvmrc could not be read safely/.test(line)));
  assert.deepEqual(inputs.errors, []);
  const before = inputs.inputFingerprint;
  await writeFile(join(root, ".nvmrc"), "22\n");
  const changed = await inspectProject(root);
  assert.notEqual(changed.inputFingerprint, before, "Runtime files are collected inputs");
  assert.equal(changed.runtimes.length, 2);
});

test("selected GitHub repositories read .nvmrc and .node-version at the resolved commit", async () => {
  const sha = "a".repeat(40);
  const files = {
    "package.json": JSON.stringify({ dependencies: { example: "^1.0.0" } }),
    "package-lock.json": lockfile,
    ".nvmrc": "v18.20.4\n",
  };
  const requested = [];
  const fetcher = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/commits/main")) return Response.json({ sha });
    assert.equal(url.searchParams.get("ref"), sha);
    const name = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    requested.push(name);
    return files[name] === undefined
      ? new Response("", { status: 404 })
      : new Response(files[name]);
  };
  const inputs = await inspectRepository(repositoryProject, "fixture-token", fetcher);
  assert.ok(requested.includes(".nvmrc") && requested.includes(".node-version"));
  assert.deepEqual(inputs.runtimes, [
    { product: "nodejs", cycle: "18", version: "18.20.4", sources: [".nvmrc"] },
  ]);
});

test("a runtime file a project cannot supply safely is a coverage note, never a failed scan or a command", async (t) => {
  const root = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-runtimes-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ engines: { node: "lts/*" }, dependencies: { example: "^1.0.0" } }),
  );
  await writeFile(join(root, "package-lock.json"), lockfile);
  await mkdir(join(root, ".nvmrc"));
  await writeFile(join(root, ".node-version"), "$(touch executed)\n");
  const inputs = await inspectProject(root);
  assert.deepEqual(inputs.runtimes, []);
  const notes = inputs.coverage.join("\n");
  assert.match(notes, /engines\.node is not a valid SemVer range/);
  assert.match(notes, /\.nvmrc could not be read safely/);
  assert.match(notes, /\.node-version has an unsupported value/);
  assert.ok(!notes.includes("touch"), "File content is never echoed");
  assert.deepEqual(inputs.errors, []);
  await assert.rejects(readFile(join(root, "executed")), { code: "ENOENT" });
});

test("a provider failure on a runtime file is a coverage note, never a failed scan", async () => {
  const files = {
    "package.json": JSON.stringify({ dependencies: { example: "^1.0.0" } }),
    "package-lock.json": lockfile,
    ".node-version": "20.1.0\n",
  };
  const fetcher = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/commits/main")) return Response.json({ sha: "a".repeat(40) });
    const name = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    if (name === ".nvmrc") return new Response("busy", { status: 503 });
    return files[name] === undefined
      ? new Response("", { status: 404 })
      : new Response(files[name]);
  };
  const inputs = await inspectRepository(repositoryProject, "fixture-token", fetcher);
  assert.deepEqual(inputs.runtimes, [
    { product: "nodejs", cycle: "20", version: "20.1.0", sources: [".node-version"] },
  ]);
  assert.ok(inputs.coverage.some((line) => /\.nvmrc could not be read safely/.test(line)));
  assert.deepEqual(inputs.errors, []);
});
