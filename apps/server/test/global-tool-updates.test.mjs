import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { toolDirectories, toolExecutable } from "../dist/adapters/tool-paths.js";
import { readGlobalInstallation } from "../dist/adapters/inventory.js";
import {
  resolveGlobalToolUpdate,
  verifyGlobalToolUpdate,
  executeGlobalToolUpdate,
} from "../dist/adapters/global-tool-updates.js";
import { decodeGlobalToolUpdateRequest } from "@versionstead/contracts/global-tool-updates";

async function fixture(t, manager = "npm", alias = "@scope/tool", name = alias) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "versionstead-updates-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(
    base,
    manager,
    ...(process.platform !== "win32" && manager === "npm" ? ["lib"] : []),
    "node_modules",
  );
  await mkdir(join(root, alias), { recursive: true });
  const manifest = join(root, alias, "package.json");
  await writeFile(manifest, JSON.stringify({ name, version: "1.0.0" }));
  if (manager === "bun")
    await writeFile(
      join(dirname(root), "package.json"),
      JSON.stringify({
        dependencies: {
          [alias]: alias === name ? "1.0.0" : `npm:${name}@1.0.0`,
        },
      }),
    );
  const source = {
    manager,
    status: "detected",
    version: manager === "npm" ? "11.7.0" : "1.4.0",
    root,
    registry: "public",
    blockedScopes: [],
    checkedAt: new Date().toISOString(),
    error: null,
  };
  const item = {
    ...(await readGlobalInstallation(
      source,
      alias,
      manager === "bun" ? (alias === name ? "1.0.0" : `npm:${name}@1.0.0`) : null,
    )),
    availableVersion: "2.0.0",
    updateStatus: "available",
  };
  const options = {
    discover: async () => [source],
    npm: async () => ({
      executable: process.execPath,
      cli: join(base, "npm-cli.js"),
      version: "11.7.0",
    }),
    executable: async () => process.execPath,
  };
  return { base, root, manifest, source, item, options };
}

test("Windows fallback paths preserve PATH priority and include known directories", () => {
  const paths = toolDirectories(
    {
      Path: 'C:\\first;"C:\\space dir";c:\\FIRST;.;\\\\server\\share;\\drive-relative;C:relative',
      APPDATA: "C:\\Roaming",
      LOCALAPPDATA: "C:\\Local",
      USERPROFILE: "C:\\Owner",
      BUN_INSTALL: "D:\\Bun",
      VOLTA_HOME: "D:\\Volta",
      PNPM_HOME: "D:\\pnpm",
      ProgramFiles: "C:\\Program Files",
    },
    "win32",
  );
  assert.deepEqual(paths.slice(0, 2), ["C:\\first", "C:\\space dir"]);
  for (const suffix of [
    "Roaming\\npm",
    "Local\\Programs\\nodejs",
    "Local\\Volta\\bin",
    "Local\\pnpm",
    "Owner\\.local\\bin",
    "Owner\\.bun\\bin",
    "Owner\\scoop\\shims",
    "Bun\\bin",
    "Volta\\bin",
    "pnpm",
    "Program Files\\nodejs",
  ])
    assert(
      paths.some((p) => p.endsWith(suffix)),
      suffix,
    );
  assert(paths.every((p) => /^[a-z]:[\\/]/i.test(p)));
});

test(
  "executable discovery finds a missing-PATH Bun in its configured Windows install",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.base, "bin"));
    await writeFile(join(f.base, "bin", "versionstead-fixture.exe"), "fixture");
    const original = process.env.BUN_INSTALL;
    process.env.BUN_INSTALL = f.base;
    try {
      assert.equal(
        await toolExecutable("versionstead-fixture.exe"),
        await realpath(join(f.base, "bin", "versionstead-fixture.exe")),
      );
    } finally {
      if (original === undefined) delete process.env.BUN_INSTALL;
      else process.env.BUN_INSTALL = original;
    }
  },
);

test("npm update targets the observed global prefix and exact canonical/alias version", async (t) => {
  const f = await fixture(t, "npm", "alias-tool", "@scope/tool");
  const plan = await resolveGlobalToolUpdate(f.item, undefined, f.options);
  assert.equal(plan.executable, process.execPath);
  assert.equal(
    plan.args[plan.args.indexOf("--prefix") + 1],
    process.platform === "win32" ? dirname(f.root) : dirname(dirname(f.root)),
  );
  assert.equal(plan.args.at(-1), "alias-tool@npm:@scope/tool@2.0.0");
  assert(plan.args.includes("--registry=https://registry.npmjs.org/"));
  assert.equal(plan.env.NODE_OPTIONS, undefined);
  const approved = await resolveGlobalToolUpdate(f.item, undefined, {
    ...f.options,
    discover: async () => [{ ...f.source, version: "12.0.0" }],
    npm: async () => ({
      executable: process.execPath,
      cli: "cli.js",
      version: "12.0.0",
    }),
  });
  assert(approved.args.includes("--allow-scripts=@scope/tool"));
});

test("Bun update pins the global directory and preserves aliases in executable and copied command", async (t) => {
  const f = await fixture(t, "bun", "alias-tool", "@scope/tool");
  const plan = await resolveGlobalToolUpdate(f.item, undefined, f.options);
  assert.equal(plan.env.BUN_INSTALL_GLOBAL_DIR, dirname(f.root));
  assert.equal(plan.cwd, dirname(f.root));
  assert.deepEqual(plan.args, [
    "add",
    "--global",
    "--exact",
    "--no-progress",
    "alias-tool@npm:@scope/tool@2.0.0",
  ]);
  assert(plan.command.includes("BUN_INSTALL_GLOBAL_DIR="));
  assert(plan.command.includes(dirname(f.root)));
  await writeFile(f.manifest, JSON.stringify({ name: "@scope/tool", version: "2.0.0" }));
  await verifyGlobalToolUpdate(plan, f.item);
});

test("Bun refuses a missing exact global manifest or declaration before resolving an installer", async (t) => {
  const f = await fixture(t, "bun");
  const parent = join(f.base, "package.json");
  const contents = JSON.stringify({ dependencies: { [f.item.name]: "1.0.0" } });
  await writeFile(parent, contents);
  let resolved = 0;
  const options = {
    ...f.options,
    executable: async () => {
      resolved++;
      return process.execPath;
    },
  };
  const globalManifest = join(dirname(f.root), "package.json");
  await rm(globalManifest);
  await assert.rejects(
    resolveGlobalToolUpdate(f.item, undefined, options),
    /global dependency manifest is missing/,
  );
  await writeFile(globalManifest, JSON.stringify({ dependencies: {} }));
  await assert.rejects(resolveGlobalToolUpdate(f.item, undefined, options), /no longer declared/);
  assert.equal(resolved, 0);
  assert.equal(await readFile(parent, "utf8"), contents);
});

test("update refuses stale versions, roots, private sources, prereleases and malformed target requests", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { version: "0.9.0" },
    { rootId: "0".repeat(32) },
    { name: "../escape" },
    { availableVersion: "2.0.0-next.1" },
    { availableVersion: "0.5.0" },
    { availableVersion: "2.0.0; touch secret" },
    { origin: "local" },
    { updateStatus: "unknown" },
  ])
    await assert.rejects(resolveGlobalToolUpdate({ ...f.item, ...changes }, undefined, f.options));
  for (const changes of [
    { registry: "unsupported" },
    { blockedScopes: ["@scope"] },
    { status: "unavailable" },
  ])
    await assert.rejects(
      resolveGlobalToolUpdate(f.item, undefined, {
        ...f.options,
        discover: async () => [{ ...f.source, ...changes }],
      }),
    );
  await writeFile(f.manifest, JSON.stringify({ name: f.item.name, version: "1.1.0" }));
  await assert.rejects(resolveGlobalToolUpdate(f.item, undefined, f.options), /changed/);
  for (const targetVersion of ["latest", "2.0.0;echo", "2.0.0-beta.1"])
    assert.throws(() =>
      decodeGlobalToolUpdateRequest({
        installationId: f.item.id,
        expectedVersion: "1.0.0",
        targetVersion,
      }),
    );
});

test("update verification requires the requested identity/version, not just a successful exit", async (t) => {
  const f = await fixture(t);
  const plan = await resolveGlobalToolUpdate(f.item, undefined, f.options);
  await assert.rejects(verifyGlobalToolUpdate(plan, f.item), /could not be verified/);
  await writeFile(f.manifest, JSON.stringify({ name: f.item.name, version: "2.0.0" }));
  await verifyGlobalToolUpdate(plan, f.item);
  await writeFile(f.manifest, JSON.stringify({ name: "different", version: "2.0.0" }));
  await assert.rejects(verifyGlobalToolUpdate(plan, f.item), /could not be verified/);
});

test("installed package symlinks outside the observed root cannot become update targets", async (t) => {
  const f = await fixture(t, "npm", "tool");
  const external = join(f.base, "external");
  await mkdir(external);
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({ name: "tool", version: "1.0.0" }),
  );
  await rm(join(f.root, "tool"), { recursive: true });
  await symlink(external, join(f.root, "tool"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveGlobalToolUpdate(f.item, undefined, f.options), /symlink escapes/);
});

test("manual update subprocesses have sanitized failures, cancellation, output and runtime bounds", async (t) => {
  const f = await fixture(t);
  const plan = {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    cwd: f.base,
    env: { ...process.env, NODE_OPTIONS: "" },
    command: "fixture",
    source: f.source,
  };
  await executeGlobalToolUpdate(plan, new AbortController().signal);
  await assert.rejects(
    executeGlobalToolUpdate(
      {
        ...plan,
        args: ["-e", "process.stderr.write('EPERM secret credential'); process.exit(1)"],
      },
      new AbortController().signal,
    ),
    (error) => /not writable/.test(error.message) && !error.message.includes("secret"),
  );
  await assert.rejects(
    executeGlobalToolUpdate(
      { ...plan, args: ["-e", "setInterval(()=>{}, 1000)"] },
      new AbortController().signal,
      100,
    ),
    /five minutes/,
  );
  await assert.rejects(
    executeGlobalToolUpdate(
      {
        ...plan,
        args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{}, 1000)"],
      },
      new AbortController().signal,
    ),
    /output limit/,
  );
  const controller = new AbortController();
  const running = executeGlobalToolUpdate(
    { ...plan, args: ["-e", "setInterval(()=>{},1000)"] },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /stopped/);
});
