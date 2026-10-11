import assert from "node:assert/strict";
import test from "node:test";
import type { Dependency, Finding } from "@versionstead/contracts/monitoring";
import { heldDependencies } from "./monitoring-view.ts";
import {
  dependencyUpgradeCommand,
  globalUpgradeCommand,
  npmPackageUrl,
  projectUpgradeCommands,
  upgradeEmptyText,
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

test("a pnpm workspace root gets -w even when its packages declare no dependencies", () => {
  const project = {
    packageManager: "pnpm" as const,
    dependencies: [{ role: "development" as const, importer: "." }],
  };
  const typescript = dependency({
    name: "typescript",
    packageName: "typescript",
    role: "development",
  });
  assert.equal(
    dependencyUpgradeCommand({ ...project, pnpmWorkspace: true }, typescript, "5.1.0"),
    "pnpm add typescript@5.1.0 -D -w",
  );
  assert.equal(
    dependencyUpgradeCommand(project, typescript, "5.1.0"),
    "pnpm add typescript@5.1.0 -D",
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

const dep = (name: string, changes: Partial<Dependency> = {}): Dependency => ({
  id: `${changes.importer ?? "."}:${name}`,
  name,
  packageName: name,
  requested: "^1.0.0",
  resolved: "1.0.0",
  origin: "registry",
  role: "production",
  importer: ".",
  availableVersion: null,
  latestVersion: null,
  versionStatus: "checked",
  advisoryStatus: "checked",
  advisoryIds: [],
  ...changes,
});

test("project commands combine each workspace's packages by dependency type, compatible updates only by default", () => {
  const project = {
    packageManager: "pnpm" as const,
    dependencies: [
      dep("lodash", { resolved: "4.17.20", availableVersion: "4.17.21" }),
      dep("typescript", {
        role: "development",
        resolved: "5.4.0",
        availableVersion: "5.9.2",
        latestVersion: "6.0.0",
      }),
      dep("react", { resolved: "18.3.1", latestVersion: "19.1.0" }),
      dep("zod", { importer: "packages/app", resolved: "3.22.0", availableVersion: "3.25.0" }),
      dep("scheduler", { role: "transitive", resolved: "0.23.0", availableVersion: "0.23.2" }),
      dep("left-pad", { resolved: "1.0.0", availableVersion: "1.3.0", versionStatus: "failed" }),
    ],
  };
  assert.deepEqual(projectUpgradeCommands(project, "compatible"), {
    commands: [
      {
        where: "root · dependencies",
        role: "production",
        command: "pnpm add lodash@4.17.21 -w",
        packages: 1,
      },
      {
        where: "root · devDependencies",
        role: "development",
        command: "pnpm add typescript@5.9.2 -D -w",
        packages: 1,
      },
      {
        where: "packages/app · dependencies",
        role: "production",
        command: "pnpm --filter ./packages/app add zod@3.25.0",
        packages: 1,
      },
    ],
    unsupported: 0,
    held: 0,
    tooNew: 0,
    // left-pad's lookup failed: it is counted, never read as having no update.
    unchecked: 1,
  });
  const major = projectUpgradeCommands(project, "major");
  assert.deepEqual(
    major.commands.map((item) => item.command),
    [
      "pnpm add lodash@4.17.21 react@19.1.0 -w",
      "pnpm add typescript@6.0.0 -D -w",
      "pnpm --filter ./packages/app add zod@3.25.0",
    ],
  );
  assert.equal(major.unchecked, 1);
});

test("a compatible update never crosses a major version, and npm and Bun take every package in one command", () => {
  const npm = {
    packageManager: "npm" as const,
    dependencies: [
      dep("anything", { requested: "*", resolved: "1.0.0", availableVersion: "2.0.0" }),
      dep("a", { importer: "packages/app", role: "development", availableVersion: "1.1.0" }),
      dep("b", {
        importer: "packages/app",
        role: "development",
        resolved: "2.0.0",
        availableVersion: "2.0.1",
      }),
    ],
  };
  assert.deepEqual(
    projectUpgradeCommands(npm, "compatible").commands.map((item) => item.command),
    ["npm install a@1.1.0 b@2.0.1 --save-dev --workspace packages/app"],
  );
  assert.deepEqual(
    projectUpgradeCommands(npm, "major").commands.map((item) => item.command),
    [
      "npm install anything@2.0.0",
      "npm install a@1.1.0 b@2.0.1 --save-dev --workspace packages/app",
    ],
  );
  assert.deepEqual(
    projectUpgradeCommands({ ...npm, packageManager: "bun" }, "compatible").commands.map(
      (item) => item.command,
    ),
    ["bun add a@1.1.0 b@2.0.1 --dev --cwd packages/app"],
  );
  assert.deepEqual(
    projectUpgradeCommands({ ...npm, packageManager: "unknown" }, "major").commands,
    [],
  );
});

test("aliases, other sources, unquotable workspaces, and snoozed or ignored packages are counted, never commanded", () => {
  const project = {
    packageManager: "npm" as const,
    dependencies: [
      dep("lodash-4", { packageName: "lodash", resolved: "4.17.20", availableVersion: "4.17.21" }),
      dep("from-git", { origin: "git", availableVersion: "1.1.0" }),
      dep("unquotable", { importer: "packages/a&calc", availableVersion: "1.1.0" }),
      dep("held", { availableVersion: "1.1.0" }),
      dep("fine", { availableVersion: "1.2.0" }),
    ],
  };
  const plan = projectUpgradeCommands(project, "compatible", new Set([".:held"]));
  assert.deepEqual(
    plan.commands.map((item) => item.command),
    ["npm install fine@1.2.0"],
  );
  assert.equal(plan.unsupported, 3);
  assert.equal(plan.held, 1);
  assert.equal(plan.unchecked, 0);
  for (const item of plan.commands) assert.doesNotMatch(item.command, /&|lodash|from-git|held/);
});

test("a direct registry package whose lookup did not finish is counted as unchecked, and nothing else is", () => {
  const plan = (scope: "compatible" | "major") =>
    projectUpgradeCommands(
      {
        packageManager: "npm",
        dependencies: [
          dep("failed", { availableVersion: "1.1.0", versionStatus: "failed" }),
          dep("not-checked", { versionStatus: "not-checked" }),
          dep("unsupported", { versionStatus: "unsupported" }),
          dep("no-status", { versionStatus: undefined }),
          // A transitive record, a non-registry source, and a checked package are not unchecked.
          dep("transitive", { role: "transitive", versionStatus: "failed" }),
          dep("linked", { origin: "workspace", versionStatus: "unsupported" }),
          dep("fine", { availableVersion: "1.2.0" }),
        ],
      },
      scope,
    );
  for (const scope of ["compatible", "major"] as const) {
    assert.equal(plan(scope).unchecked, 4, scope);
    assert.equal(plan(scope).unsupported, 0, scope);
    assert.deepEqual(
      plan(scope).commands.map((item) => item.command),
      ["npm install fine@1.2.0"],
      scope,
    );
  }
});

test("commands come root first, then workspaces by path, then dependency types, whatever the order of the records", () => {
  const at = (importer: string) => ({ importer, availableVersion: "1.1.0" });
  const workspaces = projectUpgradeCommands(
    {
      packageManager: "npm",
      dependencies: [
        dep("web", at("packages/web")),
        dep("lint", { ...at("packages/app"), role: "development" }),
        dep("zed", at("packages/app")),
        dep("alpha", at("packages/app")),
        // The same package twice in one workspace and dependency type is one package.
        { ...dep("alpha", at("packages/app")), id: "again" },
        // A workspace that cannot be quoted counts every package in it, once each.
        dep("one", at("packages/a&calc")),
        dep("two", at("packages/a&calc")),
      ],
    },
    "compatible",
  );
  assert.deepEqual(
    workspaces.commands.map((item) => [item.where, item.command, item.packages]),
    [
      [
        "packages/app · dependencies",
        "npm install alpha@1.1.0 zed@1.1.0 --workspace packages/app",
        2,
      ],
      [
        "packages/app · devDependencies",
        "npm install lint@1.1.0 --save-dev --workspace packages/app",
        1,
      ],
      ["packages/web · dependencies", "npm install web@1.1.0 --workspace packages/web", 1],
    ],
  );
  assert.equal(workspaces.unsupported, 2);
  // The root leads even when another workspace's name sorts before ".".
  const root = projectUpgradeCommands(
    {
      packageManager: "npm",
      dependencies: [dep("tool", at("_tools")), dep("main", at("."))],
    },
    "compatible",
  );
  assert.deepEqual(
    root.commands.map((item) => item.where),
    ["root · dependencies", "_tools · dependencies"],
  );
});

test("a project whose only candidates have no safe command yields no command at all", () => {
  const plan = projectUpgradeCommands(
    {
      packageManager: "npm",
      dependencies: [
        dep("lodash-4", { packageName: "lodash", availableVersion: "1.1.0" }),
        dep("from-git", { origin: "git", availableVersion: "1.1.0" }),
      ],
    },
    "compatible",
  );
  assert.deepEqual(plan, { commands: [], unsupported: 2, held: 0, tooNew: 0, unchecked: 0 });
});

test("optional dependencies get their own command, flag, and label", () => {
  const plan = projectUpgradeCommands(
    {
      packageManager: "pnpm",
      dependencies: [dep("fsevents", { role: "optional", availableVersion: "1.1.0" })],
    },
    "compatible",
  );
  assert.deepEqual(plan.commands, [
    {
      where: "root · optionalDependencies",
      role: "optional",
      command: "pnpm add fsevents@1.1.0 -O",
      packages: 1,
    },
  ]);
});

test("including majors takes the greater of the latest release and the compatible one", () => {
  const plan = projectUpgradeCommands(
    {
      packageManager: "npm",
      dependencies: [
        // A latest tag that sits behind the newest release the range allows.
        dep("behind-tag", { availableVersion: "1.5.0", latestVersion: "1.2.0" }),
        dep("ahead-tag", { availableVersion: "1.5.0", latestVersion: "2.0.0" }),
        dep("only-latest", { availableVersion: null, latestVersion: "3.0.0" }),
      ],
    },
    "major",
  );
  assert.deepEqual(
    plan.commands.map((item) => item.command),
    ["npm install ahead-tag@2.0.0 behind-tag@1.5.0 only-latest@3.0.0"],
  );
});

test("a release younger than the cooldown is left out and counted, in compatible and major alike", () => {
  const project = {
    packageManager: "npm" as const,
    dependencies: [
      dep("old", { availableVersion: "1.1.0" }),
      dep("fresh", { availableVersion: "1.2.0", latestVersion: "2.0.0" }),
      dep("fresh-latest", { availableVersion: null, latestVersion: "3.0.0" }),
      dep("held", { availableVersion: "1.1.0" }),
    ],
  };
  // The age is known for the release an update finding describes, which is not always the one a command installs.
  const young = new Map([
    [".:fresh", "1.2.0"],
    [".:fresh-latest", "3.0.0"],
    [".:held", "1.1.0"],
  ]);
  const held = new Set([".:held"]);
  const compatible = projectUpgradeCommands(project, "compatible", held, young);
  assert.deepEqual(
    compatible.commands.map((item) => item.command),
    ["npm install old@1.1.0"],
  );
  assert.deepEqual(
    [compatible.held, compatible.tooNew],
    [1, 1],
    "A held package is counted as held only",
  );
  const major = projectUpgradeCommands(project, "major", held, young);
  assert.deepEqual(
    major.commands.map((item) => item.command),
    ["npm install fresh@2.0.0 old@1.1.0"],
    "The latest release of fresh has no known age, so it is not held back",
  );
  assert.deepEqual([major.held, major.tooNew], [1, 1]);
  assert.equal(
    projectUpgradeCommands(project, "compatible").tooNew,
    0,
    "Nothing is young by default",
  );
});

test("the held set of heldDependencies carries dependency ids, which are not names", () => {
  const zod = dep("zod", { importer: "packages/app", availableVersion: "1.1.0" });
  const update: Finding = {
    id: "update-zod",
    kind: "update",
    subjectId: "project",
    subjectLabel: "Project",
    name: "zod",
    packageName: "zod",
    installedVersion: "1.0.0",
    availableVersion: "1.1.0",
    severity: "info",
    source: "npm registry",
    description: "A newer version satisfies the requested range.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00Z",
    lastSeenAt: "2026-10-08T00:00:00Z",
    ruleId: "snooze-1",
  };
  const project = {
    packageManager: "npm" as const,
    dependencies: [
      { ...zod, id: "9f86d081884c7d659a2feaa0c55ad015" },
      dep("fine", { availableVersion: "1.2.0" }),
    ],
  };
  const held = heldDependencies(project, [update]);
  assert.deepEqual([...held], ["9f86d081884c7d659a2feaa0c55ad015"]);
  const plan = projectUpgradeCommands(project, "compatible", held);
  assert.deepEqual(
    plan.commands.map((item) => item.command),
    ["npm install fine@1.2.0"],
  );
  assert.equal(plan.held, 1);
});

test("an empty Upgrade commands dialog never reads as no updates while a package was not checked", () => {
  assert.equal(upgradeEmptyText(2, false), "No checked package has a command to copy.");
  assert.equal(upgradeEmptyText(1, true), "No checked package has a command to copy.");
  assert.equal(upgradeEmptyText(0, false), "No compatible update to copy.");
  assert.equal(upgradeEmptyText(0, true), "No update to copy.");
});
