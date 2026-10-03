import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkNativeVersions,
  parseOutdated,
  runOutdatedCommand,
} from "../dist/adapters/outdated.js";
import { lookupDependencies } from "../dist/adapters/lookups.js";
import { inspectProject, selectDirectory } from "../dist/adapters/projects.js";
import { MonitoringCoordinator } from "../dist/monitoring.js";

async function temporary(t) {
  const root = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-outdated-test-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
function dependency(id, importer = ".", resolved = "1.0.0", extra = {}) {
  return {
    id,
    name: "example",
    packageName: "example",
    importer,
    requested: "^1.0.0",
    resolved,
    origin: "registry",
    role: "production",
    availableVersion: null,
    latestVersion: null,
    advisoryStatus: "not-checked",
    advisoryIds: [],
    ...extra,
  };
}
const executable = async (manager) => ({
  executable: process.execPath,
  prefix: [],
  version: manager === "bun" ? "1.4.0" : manager === "pnpm" ? "10.14.0" : "11.7.0",
});

test("outdated parsers preserve npm aliases and parse Bun 1.4 tables without treating errors as current", () => {
  assert.equal(
    parseOutdated(
      "npm",
      JSON.stringify({ alias: [{ current: "1.0.0", wanted: "1.4.0", latest: "2.0.0" }] }),
    )[0].name,
    "alias",
  );
  assert.equal(
    parseOutdated("pnpm", '{"example":{"wanted":"1.0.0","latest":"2.0.0"}}')[0].current,
    null,
  );
  const bun =
    "\u001b[32m| Package | Current | Update | Latest |\u001b[0m\n| --- | --- | --- | --- |\n| @scope/example (dev) | 1.0.0 | 1.2.0 | 2.0.0 |";
  assert.equal(parseOutdated("bun", bun)[0].name, "@scope/example");
  assert.equal(
    parseOutdated(
      "bun",
      "┌─────┐\n│ Package │ Current │ Update │ Latest │\n├─────┤\n│ example │ 1.0.0 │ 1.2.0 │ 2.0.0 │\n└─────┘",
    )[0].wanted,
    "1.2.0",
  );
  assert.throws(() => parseOutdated("npm", '{"error":{"message":"token secret"}}'));
  assert.throws(() => parseOutdated("bun", "Registry is unavailable"));
  assert.throws(() =>
    parseOutdated("bun", "| Package | Current | Update | Latest |\n| example | 1.0.0 |"),
  );
});

test("pnpm checks each workspace and obtains compatible/latest separately, preserving locked versions", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "child"));
  const deps = [
    dependency("root"),
    dependency("child", "child", "1.1.0"),
    dependency("private", ".", "1.0.0", { origin: "unknown" }),
  ];
  const calls = [];
  const result = await checkNativeVersions(root, "pnpm", deps, undefined, undefined, {
    executable,
    run: async (_command, args, cwd, env) => {
      calls.push({ args, cwd });
      assert.equal(env.NODE_OPTIONS, "");
      assert.equal(env.COREPACK_ENABLE_NETWORK, "0");
      assert.ok(args.includes("--config.ignore-pnpmfile=true"));
      assert.ok(args.includes("--config.manage-package-manager-versions=false"));
      assert.ok(!args.includes("--recursive"));
      const wanted = cwd === root ? "1.0.0" : "1.1.0";
      return {
        code: 1,
        stdout: JSON.stringify({
          example: { wanted, latest: args.includes("--compatible") ? "1.9.0" : "2.0.0" },
        }),
        stderr: "",
      };
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.checked.size, 2);
  assert.equal(result.checked.get("child").compatible, "1.9.0");
  assert.equal(result.checked.get("root").latest, "2.0.0");
  assert.equal(deps[0].resolved, "1.0.0");
  assert.equal(result.checked.has("private"), false);
});

test("npm duplicate workspace rows stay scoped to their actual package locations and all batches are attempted", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "child"));
  const deps = [dependency("root"), dependency("child", "child", "2.0.0", { requested: "^2.0.0" })];
  for (let i = 0; i < 40; i++)
    deps.push(
      dependency(`extra-${i}`, ".", "1.0.0", { name: `extra-${i}`, packageName: `extra-${i}` }),
    );
  const calls = [];
  const progress = [];
  const result = await checkNativeVersions(
    root,
    "npm",
    deps,
    undefined,
    (completed, total) => progress.push([completed, total]),
    {
      executable,
      run: async (_command, args, cwd) => {
        calls.push(args);
        assert.ok(args.includes("--ignore-scripts"));
        assert.ok(!args.includes("--workspaces=false"));
        const json = Object.fromEntries(
          deps
            .filter((dep) => dep.importer === "." && args.includes(dep.name))
            .map((dep) => [
              dep.name,
              {
                current: "1.0.0",
                wanted: "1.9.0",
                latest: "3.0.0",
                location: join(root, "node_modules", dep.name),
              },
            ]),
        );
        if (args.includes("example"))
          json.example = [
            {
              current: "1.0.0",
              wanted: "1.9.0",
              latest: "3.0.0",
              location: join(root, "node_modules", "example"),
            },
            {
              current: "2.0.0",
              wanted: "2.9.0",
              latest: "3.0.0",
              location: join(root, "child", "node_modules", "example"),
            },
          ];
        assert.ok(cwd === root || cwd === join(root, "child"));
        return { code: 1, stdout: JSON.stringify(json), stderr: "" };
      },
    },
  );
  assert.equal(result.checked.size, 42);
  assert.equal(calls.length, 3);
  assert.equal(result.checked.get("root").compatible, "1.9.0");
  assert.equal(result.checked.get("child").compatible, "2.9.0");
  assert.deepEqual(progress.at(-1), [42, 42]);
});

test("unreported records, absent managers, malformed output, warnings and timeouts retain registry fallback", async (t) => {
  const root = await temporary(t);
  const deps = [dependency("a")];
  for (const report of [
    { code: 0, stdout: "{}", stderr: "" },
    { code: 1, stdout: '{"error":{"token":"sensitive"}}', stderr: "" },
    {
      code: 1,
      stdout: '{"example":{"wanted":"1.9.0","latest":"2.0.0"}}',
      stderr: "authentication failed sensitive",
    },
    { code: 2, stdout: "", stderr: "error" },
  ]) {
    const result = await checkNativeVersions(root, "npm", deps, undefined, undefined, {
      executable,
      run: async () => report,
    });
    assert.equal(result.checked.size, 0);
    assert.ok(!JSON.stringify(result.coverage).includes("sensitive"));
  }
  const missing = await checkNativeVersions(root, "npm", deps, undefined, undefined, {
    executable: async () => null,
  });
  assert.equal(missing.checked.size, 0);
  assert.ok(missing.coverage.some((line) => line.includes("missing")));
  const timedOut = await checkNativeVersions(root, "npm", deps, undefined, undefined, {
    executable,
    run: async () => {
      throw new Error("secret path timeout");
    },
  });
  assert.equal(timedOut.checked.size, 0);
  assert.ok(!JSON.stringify(timedOut).includes("secret path"));
});

test("pnpm config plugins are not initialized and missing compatible evidence does not become a clean scan", async (t) => {
  const root = await temporary(t);
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "configDependencies:\n  malicious: never-install\n",
  );
  let called = false;
  const result = await checkNativeVersions(root, "pnpm", [dependency("a")], undefined, undefined, {
    executable,
    run: async () => {
      called = true;
      throw new Error();
    },
  });
  assert.equal(called, false);
  assert.equal(result.checked.size, 0);
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const incomplete = await checkNativeVersions(
    root,
    "pnpm",
    [dependency("a")],
    undefined,
    undefined,
    {
      executable,
      run: async (_c, args) => ({
        code: 1,
        stdout: args.includes("--compatible")
          ? "{}"
          : '{"example":{"wanted":"1.0.0","latest":"2.0.0"}}',
        stderr: "",
      }),
    },
  );
  assert.equal(incomplete.checked.size, 0);
});

test("native versions replace only verified direct lookups while OSV still checks direct and transitive versions", async () => {
  const deps = [
    dependency("native"),
    dependency("fallback", ".", "1.0.0", { name: "second", packageName: "second" }),
    dependency("transitive", ".", "3.0.0", {
      name: "third",
      packageName: "third",
      role: "transitive",
    }),
  ];
  const queries = [];
  const registry = [];
  const fetcher = async (url, options) => {
    if (url.endsWith("querybatch")) {
      queries.push(...JSON.parse(options.body).queries);
      return Response.json({ results: [{ vulns: [{ id: "GHSA-example" }] }, {}, {}] });
    }
    if (url.includes("/vulns/"))
      return Response.json({
        summary: "Known issue",
        database_specific: { severity: "HIGH" },
        affected: [
          {
            package: { name: "example", ecosystem: "npm" },
            ranges: [{ type: "SEMVER", events: [{ fixed: "1.2.0" }] }],
          },
        ],
      });
    registry.push(url);
    return Response.json({
      name: "second",
      versions: { "1.0.0": {}, "1.3.0": {} },
      "dist-tags": { latest: "1.3.0" },
    });
  };
  const result = await lookupDependencies(deps, fetcher, undefined, undefined, async () => ({
    checked: new Map([
      ["native", { compatible: "1.9.0", latest: "2.0.0", source: "npm outdated 11.7.0" }],
    ]),
    coverage: ["native evidence"],
  }));
  assert.deepEqual(
    queries.map((q) => q.version),
    ["1.0.0", "1.0.0", "3.0.0"],
  );
  assert.equal(registry.length, 1);
  assert.equal(result.dependencies[0].availableVersion, "1.9.0");
  assert.equal(result.dependencies[0].versionSource, "npm outdated 11.7.0");
  assert.equal(result.dependencies[1].versionSource, "npm registry");
  assert.equal(result.advisories.get("native")[0].severity, "high");
  assert.equal(result.advisories.get("native")[0].fixed, "1.2.0");
  assert.equal(result.dependencies[2].advisoryStatus, "checked");
});

test("bounded command runner accepts exit 1, preserves cancellation, and does not use a shell", async (t) => {
  const root = await temporary(t);
  const file = join(root, "runner.cjs");
  await writeFile(
    file,
    "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 1;",
  );
  const command = { executable: process.execPath, prefix: [file], version: "11.7.0" };
  const report = await runOutdatedCommand(command, ["literal;&echo", "$(secret)"], root, {
    ...process.env,
    NODE_OPTIONS: "",
  });
  assert.equal(report.code, 1);
  assert.deepEqual(JSON.parse(report.stdout), ["literal;&echo", "$(secret)"]);
  await writeFile(file, "setTimeout(() => {}, 60000);");
  await assert.rejects(
    runOutdatedCommand(
      command,
      [],
      root,
      { ...process.env, NODE_OPTIONS: "" },
      AbortSignal.timeout(30),
    ),
  );
});

test("ordinary workspace links are coverage information while unresolved dependencies still need attention", async (t) => {
  const root = await temporary(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { internal: "workspace:*" } }),
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: 9\nimporters:\n  .:\n    dependencies:\n      internal:\n        specifier: workspace:*\n        version: link:packages/internal\n",
  );
  const inputs = await inspectProject(root);
  assert.equal(inputs.errors.length, 0);
  assert.ok(inputs.coverage.some((line) => line.includes("internal workspace/local")));
  await assert.rejects(readFile(join(root, "executed")), { code: "ENOENT" });
});

test("coordinator supplies native CLI context only to owner-session local projects", async (t) => {
  const root = await temporary(t);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, "package.json"), '{"dependencies":{"example":"^1.0.0"}}');
  await writeFile(
    join(checkout, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { example: "^1.0.0" } },
        "node_modules/example": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        },
      },
    }),
  );
  for (const [mode, host] of [
    ["interactive", "session"],
    ["background", "boot-task"],
    ["background", "session"],
  ]) {
    const contexts = [];
    const core = new MonitoringCoordinator({
      dataDir: join(root, `${mode}-${host}`),
      mode,
      host,
      dependencyLookup: async (dependencies, _signal, _progress, context) => {
        contexts.push(context);
        return {
          dependencies: [...dependencies],
          advisories: new Map(),
          coverage: [],
          errors: [],
          versionChecked: new Set(),
        };
      },
    });
    const scan = async (project) => {
      core.requestScan({ target: "projects", projectId: project.id });
      const deadline = Date.now() + 4000;
      while (
        !core
          .snapshot()
          .history.some(
            (attempt) => attempt.targetId === project.id && attempt.status !== "scanning",
          )
      ) {
        if (Date.now() > deadline) throw new Error("Scan did not finish.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      core.changeSettings({ paused: true });
      const local = await core.addProject({ path: checkout, mode: "maintained" });
      await scan(local);
      assert.ok(contexts.length > 0);
      assert.ok(
        contexts.every((context) =>
          mode === "interactive"
            ? context?.root === checkout && context.packageManager === "npm"
            : context === undefined,
        ),
      );
      contexts.length = 0;
      core.configureProjectInspection(
        () => inspectProject(checkout),
        () => false,
      );
      const remote = core.addRepository(
        {
          provider: "github",
          repositoryId: "1",
          name: "owner/example",
          ref: "main",
          commit: null,
          url: "https://github.com/owner/example",
        },
        "watch",
        false,
      );
      await scan(remote);
      assert.ok(contexts.length > 0);
      assert.ok(contexts.every((context) => context === undefined));
    } finally {
      await core.close();
    }
  }
});
