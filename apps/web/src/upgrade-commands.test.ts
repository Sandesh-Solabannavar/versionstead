import assert from "node:assert/strict";
import test from "node:test";
import type { Dependency } from "@versionstead/contracts/monitoring";
import {
  dependencyUpgradeCommand,
  globalUpgradeCommand,
  npmPackageUrl,
} from "./upgrade-commands.ts";

type Manager = "npm" | "pnpm" | "bun" | "unknown";
const dependency = (changes: Partial<Dependency> = {}) => ({
  name: "lodash",
  packageName: "lodash",
  requested: "^4.17.0",
  origin: "registry" as const,
  role: "production" as const,
  importer: ".",
  ...changes,
});
const command = (
  manager: Manager,
  changes: Partial<Dependency> = {},
  version: string | null = "4.17.21",
  others: string[] = [],
) =>
  dependencyUpgradeCommand(
    {
      packageManager: manager,
      dependencies: [
        { role: "production", importer: "." },
        // A transitive record never makes another workspace.
        { role: "transitive", importer: "node_modules/some/where" },
        ...others.map((importer) => ({ role: "production" as const, importer })),
      ],
    },
    dependency(changes),
    version,
  );

test("npm commands install the exact version, with dependency role and workspace flags", () => {
  assert.equal(command("npm"), "npm install lodash@4.17.21");
  assert.equal(command("npm", { role: "development" }), "npm install lodash@4.17.21 --save-dev");
  assert.equal(command("npm", { role: "optional" }), "npm install lodash@4.17.21 --save-optional");
  assert.equal(
    command("npm", { importer: "packages/app" }),
    "npm install lodash@4.17.21 --workspace packages/app",
  );
  assert.equal(
    command("npm", { importer: "packages/app", role: "development" }),
    "npm install lodash@4.17.21 --save-dev --workspace packages/app",
  );
  assert.equal(
    command(
      "npm",
      { name: "@types/node", packageName: "@types/node", role: "development" },
      "22.1.0",
    ),
    "npm install @types/node@22.1.0 --save-dev",
  );
});

test("pnpm commands add -w at a workspace root and filter other workspaces by path", () => {
  assert.equal(command("pnpm"), "pnpm add lodash@4.17.21");
  assert.equal(command("pnpm", {}, "4.17.21", ["packages/app"]), "pnpm add lodash@4.17.21 -w");
  assert.equal(
    command("pnpm", { role: "development" }, "4.17.21", ["packages/app"]),
    "pnpm add lodash@4.17.21 -D -w",
  );
  assert.equal(
    command("pnpm", { importer: "packages/app" }, "4.17.21", ["packages/app"]),
    "pnpm --filter ./packages/app add lodash@4.17.21",
  );
  assert.equal(
    command("pnpm", { importer: "packages/app", role: "development" }),
    "pnpm --filter ./packages/app add lodash@4.17.21 -D",
  );
  assert.equal(
    command("pnpm", { importer: "packages/app", role: "optional" }),
    "pnpm --filter ./packages/app add lodash@4.17.21 -O",
  );
});

test("bun commands add the exact version, using --cwd for a workspace", () => {
  assert.equal(command("bun"), "bun add lodash@4.17.21");
  assert.equal(command("bun", { role: "development" }), "bun add lodash@4.17.21 --dev");
  assert.equal(command("bun", { role: "optional" }), "bun add lodash@4.17.21 --optional");
  assert.equal(
    command("bun", { importer: "packages/app" }),
    "bun add lodash@4.17.21 --cwd packages/app",
  );
  assert.equal(
    command("bun", { importer: "packages/app", role: "development" }),
    "bun add lodash@4.17.21 --dev --cwd packages/app",
  );
});

test("workspace paths are bare or double-quoted only from a minimal alphabet", () => {
  assert.equal(
    command("npm", { importer: "packages/my app" }),
    'npm install lodash@4.17.21 --workspace "packages/my app"',
  );
  assert.equal(
    command("pnpm", { importer: "apps/web new" }),
    'pnpm --filter "./apps/web new" add lodash@4.17.21',
  );
  assert.equal(
    command("bun", { importer: "packages/@scope+pkg~1" }),
    'bun add lodash@4.17.21 --cwd "packages/@scope+pkg~1"',
  );
  assert.equal(
    command("npm", { importer: "packages/zażółć-日本" }),
    'npm install lodash@4.17.21 --workspace "packages/zażółć-日本"',
  );
  assert.equal(
    command("npm", { importer: "packages/a.b_c-d/e" }),
    "npm install lodash@4.17.21 --workspace packages/a.b_c-d/e",
  );
  assert.equal(
    command("pnpm", { importer: ".hidden/.config" }),
    "pnpm --filter ./.hidden/.config add lodash@4.17.21",
  );
});

test("a workspace path with any other character gets no command, whatever the shell", () => {
  const refused = [
    // The cmd.exe separator that a .cmd shim would run as a second command, even inside quotes.
    "packages/a&calc",
    "packages/a&&calc",
    "packages/a ^& calc",
    "packages/a|calc",
    "packages/a;calc",
    "packages/a<b",
    "packages/a>b",
    // Once admitted inside double quotes, and not needed to name a workspace.
    "packages/a=b",
    "packages/a,b",
    "packages/(a)",
    "packages/a)b",
    "packages/a#b",
    "packages/a'b",
    // Expansion and escape characters in cmd, PowerShell and POSIX shells.
    "packages/$(whoami)",
    "packages/$HOME",
    "packages/`x`",
    'packages/a"b',
    "packages/100%",
    "packages/%PATH%",
    "packages/a\\b",
    "packages/a!b",
    "packages/a^b",
    // Globs, braces and pnpm selector syntax.
    "packages/*",
    "packages/a?b",
    "packages/{a,b}",
    "packages/[ab]",
    "packages/a:b",
    // Control, format and look-alike characters.
    "packages/a\nb",
    "packages/a\tb",
    "packages/a\u0000b",
    "packages/a\u202eb",
    "packages/a\u00a0b",
    "packages/a\uff06b",
    // Options, absolute paths and paths leaving the project.
    "-g",
    "--prefix=/etc",
    "/etc/passwd",
    "C:/Windows",
    "../outside",
    "packages/../../outside",
    "",
  ];
  for (const importer of refused)
    for (const manager of ["npm", "pnpm", "bun"] as const)
      assert.equal(command(manager, { importer }), null, `${manager} ${JSON.stringify(importer)}`);
});

test("path segments that end in a dot or are blank are refused, since pnpm reads trailing dots as a selector", () => {
  for (const importer of [
    "packages/a...",
    "packages/a..",
    "packages/a.",
    "packages/...",
    "packages/./a",
    "a/./b",
    "packages//a",
    "packages/a/",
    "packages/ /a",
  ])
    for (const manager of ["npm", "pnpm", "bun"] as const)
      assert.equal(command(manager, { importer }), null, `${manager} ${JSON.stringify(importer)}`);
  // Dots inside or before a name are ordinary.
  assert.equal(
    command("pnpm", { importer: "packages/a.b" }),
    "pnpm --filter ./packages/a.b add lodash@4.17.21",
  );
});

test("no command is built for aliases, non-registry or transitive dependencies, or a missing candidate", () => {
  assert.equal(command("npm", { name: "lodash-4", packageName: "lodash" }), null);
  assert.equal(command("npm", { requested: "npm:lodash@^4.0.0" }), null);
  for (const origin of ["workspace", "git", "local", "unknown"] as const)
    assert.equal(command("npm", { origin }), null);
  assert.equal(command("npm", { role: "transitive" }), null);
  assert.equal(command("unknown"), null);
  for (const version of [null, "", "latest", "^4.17.21", "4.17", "4.17.21 && echo x", "4.17.21;x"])
    assert.equal(command("npm", {}, version), null, String(version));
  for (const name of [
    "lodash; rm -rf /",
    "-evil",
    "$(x)",
    "a b",
    "",
    "@scope",
    "a/b",
    "x".repeat(215),
  ])
    assert.equal(command("npm", { name, packageName: name }), null, name);
  assert.equal(
    command("npm", { name: "JSONStream", packageName: "JSONStream" }),
    "npm install JSONStream@4.17.21",
  );
  assert.equal(command("npm", {}, "5.0.0-rc.1"), "npm install lodash@5.0.0-rc.1");
});

test("global commands install the exact version with the manager that owns the tool", () => {
  const tool = (changes = {}) => ({
    manager: "npm" as "npm" | "bun" | undefined,
    name: "typescript",
    packageId: "typescript" as string | undefined,
    origin: "registry" as "registry" | "local" | "unknown" | undefined,
    ...changes,
  });
  assert.equal(globalUpgradeCommand(tool(), "5.9.2"), "npm install --global typescript@5.9.2");
  assert.equal(
    globalUpgradeCommand(tool({ manager: "bun" }), "5.9.2"),
    "bun add --global typescript@5.9.2",
  );
  assert.equal(
    globalUpgradeCommand(tool({ name: "@angular/cli", packageId: "@angular/cli" }), "20.0.0"),
    "npm install --global @angular/cli@20.0.0",
  );
  // Without a package identity the installed name is the package.
  assert.equal(
    globalUpgradeCommand(tool({ packageId: undefined }), "5.9.2"),
    "npm install --global typescript@5.9.2",
  );
  assert.equal(globalUpgradeCommand(tool({ name: "tsc", packageId: "typescript" }), "5.9.2"), null);
  assert.equal(globalUpgradeCommand(tool({ origin: "local" }), "5.9.2"), null);
  assert.equal(globalUpgradeCommand(tool({ origin: undefined }), "5.9.2"), null);
  assert.equal(globalUpgradeCommand(tool({ manager: undefined }), "5.9.2"), null);
  assert.equal(globalUpgradeCommand(tool(), null), null);
  assert.equal(globalUpgradeCommand(tool(), "latest"), null);
  assert.equal(globalUpgradeCommand(tool({ name: "x; y", packageId: "x; y" }), "1.0.0"), null);
});

test("npm package links come only from valid package names", () => {
  assert.equal(npmPackageUrl("lodash"), "https://www.npmjs.com/package/lodash");
  assert.equal(npmPackageUrl("@types/node"), "https://www.npmjs.com/package/@types/node");
  for (const name of [
    "",
    "../x",
    "a b",
    "a?b",
    "a#b",
    "a/b",
    "@scope",
    "https://x.test",
    "x".repeat(215),
  ])
    assert.equal(npmPackageUrl(name), null, name);
});
