import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProject, inspectProjectFiles, selectDirectory } from "../dist/adapters/projects.js";
import { inspectRepository } from "../dist/adapters/repositories.js";
import { lookupDependencies } from "../dist/adapters/lookups.js";
import { decodeProject } from "@versionstead/contracts/monitoring";

function fixture() {
  const root = {
    name: "bun-monorepo",
    scripts: { postinstall: "never-execute" },
    workspaces: {
      packages: ["apps/*", "packages/*"],
      catalog: { shared: "^1.0.0", compat: "npm:real@^2.0.0" },
      catalogs: { dev: { "@types/tool": "^4.0.0" } },
    },
    dependencies: { shared: "catalog:", compat: "catalog:", "@fixture/lib": "workspace:*" },
    devDependencies: { private: "^9.0.0", gitpkg: "github:owner/repo", local: "file:../local" },
  };
  const web = {
    name: "web",
    dependencies: { shared: "catalog:" },
    devDependencies: { "@types/tool": "catalog:dev" },
  };
  const lib = { name: "@fixture/lib", dependencies: { shared: "^2.0.0" } };
  const lock = {
    lockfileVersion: 1,
    workspaces: { "": root, "apps/web": web, "packages/lib": lib },
    catalog: root.workspaces.catalog,
    catalogs: root.workspaces.catalogs,
    packages: {
      shared: ["shared@1.2.0", "", {}, "sha512-example"],
      compat: ["real@2.3.0", "", {}, "sha512-example"],
      "@fixture/lib": ["@fixture/lib@workspace:packages/lib"],
      web: ["web@workspace:apps/web"],
      "@fixture/lib/shared": ["shared@2.1.0", "", {}, "sha512-example"],
      "@types/tool": ["@types/tool@4.2.0", "", {}, "sha512-example"],
      transitive: ["transitive@3.1.0", "", {}, "sha512-example"],
      private: ["private@9.1.0", "https://private.example/private.tgz", {}, "sha512-example"],
      gitpkg: ["gitpkg@github:owner/repo#abcdef", {}, "owner-repo-abcdef"],
      local: ["local@file:../local", {}],
    },
  };
  return {
    "package.json": JSON.stringify(root),
    "apps/web/package.json": JSON.stringify(web),
    "packages/lib/package.json": JSON.stringify(lib),
    // Real Bun lockfiles permit comments and trailing commas.
    "bun.lock": JSON.stringify(lock, null, 2)
      .replace('"lockfileVersion": 1,', '"lockfileVersion": 1, // Bun text lockfile')
      .replace(/\n}$/, ",\n}"),
  };
}
const read = (files) => async (name) => files[name] ?? null;
const sha = "a".repeat(40);
const project = (provider) => ({
  id: "fixture-project",
  name: "fixture/repo",
  path: `https://${provider}.com/fixture/repo`,
  mode: "maintained",
  packageManager: "unknown",
  manifestPath: null,
  lockfilePath: null,
  dependencies: [],
  createdAt: new Date().toISOString(),
  evidence: {
    status: "not-scanned",
    lastAttempt: null,
    lastSuccess: null,
    coverage: [],
    errors: [],
  },
  repository: {
    provider,
    repositoryId: "1",
    name: "fixture/repo",
    ref: "main",
    commit: null,
    url: `https://${provider}.com/fixture/repo`,
  },
});

test("Bun JSONC projects preserve workspace, alias, catalog, nested and transitive identities without executing scripts", async (t) => {
  const root = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-bun-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(fixture())) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  }
  const inputs = await inspectProject(root);
  assert.equal(inputs.packageManager, "bun");
  assert.equal(inputs.lockfilePath, "bun.lock");
  const shared = inputs.dependencies.filter((d) => d.name === "shared");
  assert.deepEqual(
    shared.map((d) => [d.importer, d.resolved]),
    [
      [".", "1.2.0"],
      ["apps/web", "1.2.0"],
      ["packages/lib", "2.1.0"],
    ],
  );
  assert.equal(new Set(shared.map((d) => d.id)).size, 3);
  assert.equal(shared[0].requested, "catalog:");
  assert.equal(shared[0].requestedRange, "^1.0.0");
  const alias = inputs.dependencies.find((d) => d.name === "compat");
  assert.equal(alias.packageName, "real");
  assert.equal(alias.requestedRange, "^2.0.0");
  assert.equal(inputs.dependencies.find((d) => d.name === "@types/tool").role, "development");
  assert.equal(inputs.dependencies.find((d) => d.name === "transitive").role, "transitive");
  for (const [name, origin] of [
    ["@fixture/lib", "workspace"],
    ["private", "unknown"],
    ["gitpkg", "git"],
    ["local", "local"],
  ])
    assert.equal(inputs.dependencies.find((d) => d.name === name).origin, origin);
  assert.match(inputs.coverage.join(" "), /3 selected workspace/);
  assert.equal((await inspectProject(root)).inputFingerprint, inputs.inputFingerprint);
  decodeProject({
    ...project("github"),
    packageManager: inputs.packageManager,
    dependencies: inputs.dependencies,
  });
  await assert.rejects(readFile(join(root, "executed")), { code: "ENOENT" });
});

test("Bun catalog ranges drive compatible update checks while private, workspace and local packages stay unqueried", async () => {
  const inputs = await inspectProjectFiles(read(fixture()));
  const queried = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).includes("api.osv.dev")) {
      const queries = JSON.parse(init.body).queries;
      queried.push(...queries.map((q) => q.package.name));
      return Response.json({ results: queries.map(() => ({ vulns: [] })) });
    }
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    queried.push(name);
    const versions = Object.fromEntries(
      ["1.2.0", "1.3.0", "2.1.0", "2.2.0", "2.3.0", "3.1.0", "4.2.0"].map((v) => [v, {}]),
    );
    return Response.json({ name, "dist-tags": { latest: "4.2.0" }, versions });
  };
  const result = await lookupDependencies(inputs.dependencies, fetcher);
  assert.equal(result.errors.length, 0);
  assert.equal(
    result.dependencies.find((d) => d.name === "shared" && d.importer === ".").availableVersion,
    "1.3.0",
  );
  assert.equal(
    result.dependencies.find((d) => d.name === "shared" && d.importer === "packages/lib")
      .availableVersion,
    "2.3.0",
  );
  assert(queried.includes("real"));
  assert(queried.includes("transitive"));
  for (const name of ["compat", "private", "gitpkg", "local", "@fixture/lib", "web"])
    assert(!queried.includes(name), name);
});

test("GitHub and GitLab Bun scans read every workspace at one immutable commit through the shared parser", async () => {
  for (const provider of ["github", "gitlab"]) {
    const files = fixture();
    const seen = [];
    const fetcher = async (input) => {
      const url = new URL(input);
      if (url.pathname.includes("/commits/"))
        return Response.json(provider === "github" ? { sha } : { id: sha });
      assert.equal(url.searchParams.get("ref"), sha);
      const name = decodeURIComponent(
        url.pathname.split(provider === "github" ? "/contents/" : "/repository/files/")[1],
      );
      seen.push(name);
      if (!(name in files)) return new Response("", { status: 404 });
      return provider === "github"
        ? new Response(files[name])
        : Response.json({
            encoding: "base64",
            content: Buffer.from(files[name]).toString("base64"),
            file_path: name,
            commit_id: sha,
          });
    };
    const inputs = await inspectRepository(project(provider), "fake-token", fetcher);
    assert.equal(inputs.packageManager, "bun");
    assert.equal(inputs.repositoryCommit, sha);
    assert(seen.includes("bun.lock"));
    assert(seen.includes("apps/web/package.json"));
    assert(seen.includes("packages/lib/package.json"));
    assert.equal(inputs.dependencies.filter((d) => d.name === "shared").length, 3);
  }
});

test("Bun missing and stale manifest/catalog evidence remains partial instead of silently dropping direct dependencies", async () => {
  const files = fixture();
  delete files["apps/web/package.json"];
  const root = JSON.parse(files["package.json"]);
  root.dependencies.missing = "^1.0.0";
  root.workspaces.catalog.shared = "^3.0.0";
  files["package.json"] = JSON.stringify(root);
  const inputs = await inspectProjectFiles(read(files));
  assert(inputs.errors.some((e) => /workspace.*package.json/.test(e)));
  assert(inputs.errors.some((e) => /catalog/.test(e)));
  assert(inputs.errors.some((e) => /missing.*lockfile/.test(e)));
  assert.equal(inputs.dependencies.find((d) => d.name === "missing").resolved, null);
  assert.equal(
    inputs.dependencies.find((d) => d.name === "shared" && d.importer === "apps/web").resolved,
    "1.2.0",
  );
});

test("Bun malformed, ambiguous, newer and escaping lock inputs fail explicitly", async () => {
  const malformed = { ...fixture(), "bun.lock": '{"lockfileVersion":1,"packages":{' };
  await assert.rejects(inspectProjectFiles(read(malformed)), /malformed/);
  await assert.rejects(
    inspectProjectFiles(read({ ...fixture(), "package-lock.json": "{}" })),
    /lockfiles|package manager/,
  );
  await assert.rejects(
    inspectProjectFiles(
      read({ ...fixture(), "bun.lock": '{"lockfileVersion":99,"workspaces":{},"packages":{}}' }),
    ),
    /supported/,
  );
  const escaping = {
    ...fixture(),
    "bun.lock":
      '{"lockfileVersion":1,"workspaces":{"":{"name":"root"},"../outside":{"name":"escape"}},"packages":{}}',
  };
  const seen = [];
  await assert.rejects(
    inspectProjectFiles(async (name) => {
      seen.push(name);
      return escaping[name] ?? null;
    }),
    /escape|unsupported/,
  );
  assert(!seen.some((name) => name.includes("..")));
  await assert.rejects(
    inspectProjectFiles(read({ "package.json": "{}", "bun.lockb": "binary" })),
    /bun.lockb/,
  );
});

test("Bun project registry configuration blocks scoped, private and unsupported routing from public checks", async () => {
  const scoped = await inspectProjectFiles(
    read({ ...fixture(), "bunfig.toml": '[install.scopes]\n"@types" = "https://private.example"' }),
  );
  assert.equal(scoped.dependencies.find((d) => d.name === "@types/tool").origin, "unknown");
  assert.equal(scoped.dependencies.find((d) => d.name === "shared").origin, "registry");
  for (const config of [
    '[install]\nregistry = "https://private.example"',
    'install.registry = "https://private.example"',
  ]) {
    const inputs = await inspectProjectFiles(read({ ...fixture(), "bunfig.toml": config }));
    assert(!inputs.dependencies.some((d) => d.origin === "registry"));
  }
});
