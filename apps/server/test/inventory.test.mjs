import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunGlobalDirectory,
  decodeBunConfiguration,
  discoverGlobalToolSources,
  inspectGlobalSources,
  validateGlobalToolSources,
} from "../dist/adapters/inventory.js";

const checkedAt = "2026-10-02T10:00:00.000Z";
test("Bun roots follow explicit config and environment precedence without listing a parent project", () => {
  const home = join(tmpdir(), "Bun owner space"),
    cache = join(tmpdir(), "Bun cache");
  assert.equal(bunGlobalDirectory(null, {}, home), join(home, ".bun", "install", "global"));
  assert.equal(bunGlobalDirectory("~/custom", {}, home), join(home, "custom"));
  assert.equal(
    bunGlobalDirectory(null, { XDG_CACHE_HOME: cache, HOME: home }, home),
    join(cache, ".bun", "install", "global"),
  );
  assert.equal(
    bunGlobalDirectory(null, { BUN_INSTALL: cache }, home),
    join(cache, "install", "global"),
  );
  assert.equal(
    bunGlobalDirectory(home, { BUN_INSTALL_GLOBAL_DIR: cache, BUN_INSTALL: home }, home),
    cache,
  );
});

test("unsupported Bun routing syntax fails closed even beside a supported public setting", () => {
  for (const text of [
    'install.registry = "https://private.example/"',
    '["install"]\nregistry = "https://private.example/"',
    '[install]\nregistry = { url = "https://private.example/" }',
    '[install]\nscopes.company = "https://private.example/"',
    '[install.scopes.company]\nurl = "https://private.example/"',
  ]) {
    assert.equal(
      decodeBunConfiguration(`${text}\n[install]\nregistry = "https://registry.npmjs.org/"`)
        .registry,
      "unknown",
    );
  }
  assert.equal(
    decodeBunConfiguration('[install]\nregistry = "https://private.example/"').registry,
    "unsupported",
  );
  assert.deepEqual(
    decodeBunConfiguration('[install.scopes]\n"@private" = "https://private.example/"')
      .blockedScopes,
    ["@private"],
  );
  assert.equal(decodeBunConfiguration('install.globalDir = "~/custom"').globalDirUnsupported, true);
});
const absent = (manager) => ({
  manager,
  status: "not-installed",
  version: null,
  root: null,
  registry: "unknown",
  blockedScopes: [],
  checkedAt,
  error: null,
});
const source = (manager, root, changes = {}) => ({
  ...absent(manager),
  status: "detected",
  version: "1.0.0",
  root,
  registry: "public",
  ...changes,
});
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "versionstead-global-test-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const npm = join(base, "npm", "node_modules");
  const bun = join(base, "bun", "node_modules");
  await Promise.all([mkdir(npm, { recursive: true }), mkdir(bun, { recursive: true })]);
  return { base, npm, bun };
}
async function packageAt(root, alias, manifest = {}) {
  const directory = join(root, alias);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: alias, version: "1.0.0", ...manifest }),
  );
}
function registry(calls) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, "https://registry.npmjs.org");
    assert.equal(options.redirect, "error");
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    calls.push(name);
    return Response.json({
      name,
      versions: { "1.0.0": {}, "2.0.0": {} },
      "dist-tags": { latest: "2.0.0" },
    });
  };
}

test("global inventory uses installed versions, scoped/alias identities, and only Bun direct tools", async (t) => {
  const { npm, bun } = await fixture(t);
  await packageAt(npm, "same");
  await packageAt(npm, "@scope/tool", { version: "3.0.0" });
  await packageAt(npm, "alias", { name: "same" });
  await packageAt(bun, "same");
  await packageAt(bun, "hoisted-transitive");
  await writeFile(
    join(bun, "..", "package.json"),
    JSON.stringify({ dependencies: { same: "^0.5.0" } }),
  );
  const calls = [],
    progress = [];
  const result = await inspectGlobalSources(
    [source("npm", npm), source("bun", bun)],
    undefined,
    (value) => progress.push(value),
    registry(calls),
  );
  assert.equal(result.installations.length, 4);
  assert.equal(new Set(result.installations.map((item) => item.id)).size, 4);
  assert.equal(new Set(result.installations.map((item) => item.rootId)).size, 2);
  assert.deepEqual(calls.sort(), ["@scope/tool", "same"]);
  assert.equal(result.installations.find((item) => item.name === "alias").packageId, "same");
  const bunTool = result.installations.find((item) => item.manager === "bun");
  assert.equal(bunTool.version, "1.0.0");
  assert.equal(bunTool.availableVersion, "2.0.0");
  assert.equal(
    result.installations.find((item) => item.name === "@scope/tool").updateStatus,
    "current",
  );
  assert.equal(result.inventoryChecks, "complete");
  assert.equal(result.updateChecks, "complete");
  assert.equal(result.checkedRoots.length, 2);
  assert.deepEqual(progress.at(-1), { stage: "pc-updates", completed: 2, total: 2 });
  const aliasId = result.installations.find((item) => item.name === "alias").id;
  await packageAt(npm, "alias", { name: "replacement" });
  const replaced = await inspectGlobalSources(
    [source("npm", npm), absent("bun")],
    undefined,
    undefined,
    registry([]),
  );
  assert.notEqual(replaced.installations.find((item) => item.name === "alias").id, aliasId);
});

test("private, local, blocked-scope, unknown and prerelease names never reach public lookups", async (t) => {
  const { npm, bun } = await fixture(t);
  await packageAt(npm, "private-tool", { private: true });
  await packageAt(npm, "local-tool", { _from: "file:../source" });
  await packageAt(npm, "@private/tool");
  await packageAt(npm, "beta", { version: "2.0.0-beta.1" });
  await packageAt(npm, "private-tarball", { _from: "https://private.example/tool.tgz" });
  await packageAt(npm, "copied-npm", { _from: "copied-npm@file:../tool" });
  await packageAt(bun, "copied-local");
  await packageAt(bun, "tarball");
  await packageAt(bun, "git-tool");
  await writeFile(
    join(bun, "..", "package.json"),
    JSON.stringify({
      dependencies: {
        "copied-local": "file:../local",
        tarball: "https://private.example/archive.tgz",
        "git-tool": "owner/repo",
      },
    }),
  );
  const calls = [];
  const result = await inspectGlobalSources(
    [source("npm", npm, { blockedScopes: ["@private"] }), source("bun", bun)],
    undefined,
    undefined,
    registry(calls),
  );
  assert.deepEqual(calls, []);
  assert.equal(result.installations.length, 9);
  assert.ok(result.installations.every((item) => item.updateStatus === "unknown"));
  assert.equal(result.installations.find((item) => item.name === "copied-local").origin, "local");
  assert.equal(result.updateChecks, "unsupported");
});

test("all global names are checked with bounded concurrency despite individual source failures", async (t) => {
  const { npm } = await fixture(t);
  const names = Array.from({ length: 125 }, (_, index) => `tool-${String(index).padStart(3, "0")}`);
  await Promise.all(names.map((name) => packageAt(npm, name)));
  const calls = [],
    progress = [];
  let active = 0,
    peak = 0;
  const good = registry(calls);
  const result = await inspectGlobalSources(
    [source("npm", npm), absent("bun")],
    undefined,
    (value) => progress.push(value),
    async (url, options) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      try {
        if (name === "tool-010") {
          calls.push(name);
          return new Response("unavailable", { status: 503 });
        }
        if (name === "tool-011") {
          calls.push(name);
          return Response.json({ name: "another-package", versions: {}, "dist-tags": {} });
        }
        return await good(url, options);
      } finally {
        active--;
      }
    },
  );
  assert.deepEqual(calls.sort(), names);
  assert.equal(peak, 4);
  assert.equal(result.inventoryChecks, "complete");
  assert.equal(result.updateChecks, "partial");
  assert.equal(
    result.installations.filter((item) => item.updateStatus === "available").length,
    123,
  );
  for (const name of ["tool-010", "tool-011"]) {
    const item = result.installations.find((candidate) => candidate.name === name);
    assert.equal(item.updateStatus, "unknown");
    assert.equal(item.availableVersion, null);
    assert.equal(item.updateCheckedAt, null);
  }
  assert.ok(result.installations.find((item) => item.name === "tool-124").updateCheckedAt);
  assert.deepEqual(
    progress.filter((value) => value.stage === "pc-updates"),
    Array.from({ length: 126 }, (_, completed) => ({ stage: "pc-updates", completed, total: 125 })),
  );
  assert.ok(!result.errors.some((error) => /limited to 100/.test(error)));

  const abort = new AbortController(),
    cancelled = [];
  await assert.rejects(
    inspectGlobalSources(
      [source("npm", npm), absent("bun")],
      abort.signal,
      undefined,
      async (url, options) => {
        cancelled.push(url);
        if (cancelled.length === 4) abort.abort();
        options.signal.throwIfAborted();
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    ),
    /interrupted/,
  );
  assert.equal(cancelled.length, 4, "cancellation stops before queued names start");
});

test("missing Bun manifest and malformed npm metadata cannot establish removals", async (t) => {
  const { npm, bun } = await fixture(t);
  await packageAt(npm, "valid");
  await packageAt(npm, "broken", { version: "not-semver" });
  await packageAt(bun, "still-installed");
  const result = await inspectGlobalSources(
    [source("npm", npm), source("bun", bun)],
    undefined,
    undefined,
    registry([]),
  );
  assert.equal(result.installations.length, 1);
  assert.deepEqual(result.checkedRoots, []);
  assert.equal(result.inventoryChecks, "partial");
  assert.equal(result.managers.find((item) => item.manager === "bun").status, "unavailable");
  assert.ok(result.errors.length >= 2);
});

test("unavailable manager capture remains unavailable when previous package metadata is readable", async (t) => {
  const { npm } = await fixture(t);
  await packageAt(npm, "known");
  const calls = [];
  const result = await inspectGlobalSources(
    [
      source("npm", npm, {
        status: "unavailable",
        registry: "unknown",
        error: "npm discovery failed.",
      }),
      absent("bun"),
    ],
    undefined,
    undefined,
    registry(calls),
  );
  assert.equal(result.managers[0].status, "unavailable");
  assert.equal(result.managers[0].error, "npm discovery failed.");
  assert.equal(result.managers[0].checkedAt, checkedAt);
  assert.equal(result.installations.length, 1);
  assert.deepEqual(calls, []);
  assert.equal(result.inventoryChecks, "partial");
});

test("empty or absent managers establish empty inventory without querying or executing packages", async (t) => {
  const { base, npm, bun } = await fixture(t);
  const missingBun = join(base, "uncreated-bun", "node_modules");
  for (const sources of [
    [absent("npm"), absent("bun")],
    [source("npm", npm), absent("bun")],
    [absent("npm"), source("bun", missingBun)],
    [absent("npm"), source("bun", bun)],
  ]) {
    const calls = [];
    const result = await inspectGlobalSources(sources, undefined, undefined, registry(calls));
    assert.equal(result.inventoryChecks, "complete");
    assert.deepEqual(result.installations, []);
    assert.deepEqual(calls, []);
  }
});

test("failed or mismatched public responses preserve unknown updates and attempted progress", async (t) => {
  const { npm } = await fixture(t);
  await packageAt(npm, "known");
  for (const fetcher of [
    async () => {
      throw new Error("offline");
    },
    async () => Response.json({ name: "other", versions: {}, "dist-tags": { latest: "2.0.0" } }),
  ]) {
    const progress = [];
    const result = await inspectGlobalSources(
      [source("npm", npm), absent("bun")],
      undefined,
      (value) => progress.push(value),
      fetcher,
    );
    assert.equal(result.inventoryChecks, "complete");
    assert.equal(result.updateChecks, "failed");
    assert.equal(result.installations[0].updateStatus, "unknown");
    assert.equal(result.installations[0].availableVersion, null);
    assert.deepEqual(progress.at(-1), { stage: "pc-updates", completed: 1, total: 1 });
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(inspectGlobalSources([source("npm", npm)], abort.signal), /interrupted/);
});

test("owner source boundary validates both managers, local roots, versions and bounded config metadata", async (t) => {
  const { npm } = await fixture(t);
  const good = [source("npm", npm), absent("bun")];
  assert.equal((await validateGlobalToolSources(good)).length, 2);
  for (const changes of [
    { root: "relative/node_modules" },
    { root: "\\\\server\\share\\node_modules" },
    { root: npm + "\u0000" },
    { root: join(npm, "..") },
    { version: "unknown" },
    { blockedScopes: ["@private/path"] },
    { checkedAt: "never" },
    { error: "x".repeat(301) },
  ])
    await assert.rejects(validateGlobalToolSources([{ ...good[0], ...changes }, good[1]]));
  await assert.rejects(validateGlobalToolSources([good[0], good[0]]));
  await assert.rejects(validateGlobalToolSources([good[0]]));
  await assert.rejects(
    validateGlobalToolSources([{ ...good[0], status: "not-installed" }, good[1]]),
  );
  const missing = await validateGlobalToolSources([absent("npm"), absent("bun")], good);
  assert.equal(missing[0].status, "unavailable");
  assert.equal(missing[0].root, npm);
  assert.equal(missing[0].registry, "unknown");
});

test("manager discovery reports independent not-installed results without constrained executables", async () => {
  const names = [
    "PATH",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "BUN_INSTALL",
    "VOLTA_HOME",
    "PNPM_HOME",
    "ProgramFiles",
  ];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const sources = await discoverGlobalToolSources();
    assert.deepEqual(
      sources.map(({ manager, status, root, version }) => ({ manager, status, root, version })),
      ["npm", "bun"].map((manager) => ({
        manager,
        status: "not-installed",
        root: null,
        version: null,
      })),
    );
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
