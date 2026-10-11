import assert from "node:assert/strict";
import test from "node:test";
import type {
  Dependency,
  Installation,
  MonitoringSnapshot,
  Project,
} from "@versionstead/contracts/monitoring";
import { behindFirst, usageAction, versionDrift } from "./version-drift.ts";

const evidence = {
  status: "complete" as const,
  lastAttempt: "2026-10-08T12:00:00Z",
  lastSuccess: "2026-10-08T12:00:00Z",
  coverage: [],
  errors: [],
};
const dep = (
  name: string,
  resolved: string | null,
  changes: Partial<Dependency> = {},
): Dependency => ({
  id: `${changes.importer ?? "."}:${changes.packageName ?? name}:${name}`,
  name,
  packageName: name,
  requested: "^1.0.0",
  resolved,
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
const project = (
  name: string,
  packageManager: Project["packageManager"],
  dependencies: Dependency[],
): Project => ({
  id: name,
  name,
  path: `C:\\code\\${name}`,
  mode: "maintained",
  packageManager,
  manifestPath: null,
  lockfilePath: null,
  evidence,
  dependencies,
  createdAt: "2026-10-01T00:00:00Z",
});
const tool = (manager: "npm" | "bun", version: string): Installation => ({
  id: `tsx-${manager}`,
  name: "tsx",
  version,
  source: `${manager} global`,
  scope: "user",
  channel: "stable",
  packageId: "tsx",
  manager,
  rootId: (manager === "npm" ? "b" : "c").repeat(32),
  origin: "registry",
  availableVersion: null,
  updateStatus: "current",
});
const snapshotOf = (
  projects: Project[],
  installations: Installation[] = [],
): Pick<MonitoringSnapshot, "device" | "projects" | "inventory"> => ({
  device: { id: "pc", label: "PC", platform: "win32" },
  inventory: { evidence, installations },
  projects,
});

test("drift lists direct registry packages at several versions with the version to align to and commands to get there", () => {
  const snapshot: Pick<MonitoringSnapshot, "device" | "projects" | "inventory"> = {
    device: { id: "pc", label: "PC", platform: "win32" },
    inventory: { evidence, installations: [tool("npm", "4.0.0"), tool("bun", "4.1.0")] },
    projects: [
      project("admin", "npm", [
        dep("react", "18.3.1"),
        dep("lodash", "4.17.21"),
        dep("zod", "4.0.0-beta.1"),
        dep("scheduler", "0.23.0", { role: "transitive" }),
      ]),
      project("shop", "pnpm", [
        dep("react", "19.1.0"),
        dep("react", "18.3.1", { importer: "packages/web" }),
        dep("lodash", "4.17.21"),
        dep("zod", "3.25.0"),
        dep("scheduler", "0.25.0", { role: "transitive" }),
        dep("from-git", "1.0.0", { origin: "git" }),
      ]),
      project("legacy", "bun", [
        dep("react-17", "17.0.2", { packageName: "react" }),
        dep("from-git", "2.0.0", { origin: "git" }),
        dep("unresolved", null),
        dep("unresolved", "workspace:*"),
      ]),
    ],
  };
  const rows = versionDrift(snapshot);
  assert.deepEqual(
    rows.map((row) => [row.key, row.target, row.versions]),
    [
      ["projects:react", "19.1.0", ["19.1.0", "18.3.1", "17.0.2"]],
      ["global:tsx", "4.1.0", ["4.1.0", "4.0.0"]],
      // The stable version is the target; the beta beside it is listed but not aligned to.
      ["projects:zod", "3.25.0", ["4.0.0-beta.1", "3.25.0"]],
    ],
    "Same-version, transitive, non-registry, and non-SemVer copies are not drift",
  );
  assert.deepEqual(
    rows[0]!.usages.map((usage) => [
      usage.subjectLabel,
      usage.where,
      usage.name,
      usage.version,
      usage.command,
    ]),
    [
      ["admin", "root", "react", "18.3.1", "npm install react@19.1.0"],
      ["legacy", "root", "react-17", "17.0.2", null],
      ["shop", "packages/web", "react", "18.3.1", "pnpm --filter ./packages/web add react@19.1.0"],
      ["shop", "root", "react", "19.1.0", null],
    ],
  );
  assert.deepEqual(
    rows[1]!.usages.map((usage) => [usage.subjectId, usage.where, usage.version, usage.command]),
    [
      ["pc", "Bun", "4.1.0", null],
      ["pc", "npm", "4.0.0", "npm install --global tsx@4.1.0"],
    ],
  );
});

test("one project's workspaces at different versions is drift too, and a single copy is not", () => {
  const rows = versionDrift({
    device: { id: "pc", label: "PC", platform: "win32" },
    inventory: { evidence, installations: [tool("npm", "4.0.0")] },
    projects: [
      project("mono", "npm", [
        dep("typescript", "5.4.0", { importer: "apps/server" }),
        dep("typescript", "5.9.2", { importer: "apps/web" }),
      ]),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.key),
    ["projects:typescript"],
  );
  assert.deepEqual(
    rows[0]!.usages.map((usage) => usage.command),
    ["npm install typescript@5.9.2 --workspace apps/server", null],
  );
});

test("prereleases rank by SemVer precedence, and versions that are not SemVer are left out without throwing", () => {
  const resolved = [
    "1.0.0-beta.2",
    "1.0.0",
    "1.0.0-alpha",
    "1.0.0-rc.1",
    "1.0.0-beta.11",
    "0.9.0",
    // Not SemVer 2.0.0: never compared, never listed.
    "latest",
    "",
    "1.2",
    "v1.2.3",
    "01.2.3",
    "1.0.0-01",
    "1.2.3.4",
    "9007199254740993.0.0",
    " 1.0.0",
    null,
  ];
  const rows = versionDrift(
    snapshotOf(
      resolved.map((version, index) => project(`p${index}`, "npm", [dep("pkg", version)])),
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.target, row.versions]),
    [["1.0.0", ["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-alpha", "0.9.0"]]],
  );
  assert.equal(rows[0]!.usages.length, 6);
  assert.deepEqual(
    versionDrift(
      snapshotOf([
        project("a", "npm", [dep("solo", "1.0.0")]),
        project("b", "npm", [dep("solo", "latest")]),
      ]),
    ),
    [],
    "One SemVer copy beside one that is not SemVer is not drift",
  );
});

test("rows, versions, and copies keep one order whatever the order of the snapshot", () => {
  // Two checkouts share a display name, and three copies are equal in SemVer precedence.
  const app = (id: string, manager: Project["packageManager"], version: string): Project => ({
    ...project("app", manager, [
      dep("pkg", version),
      dep("pkg", "3.0.0", { importer: "packages/web" }),
    ]),
    id,
  });
  const projects = [
    app("a1", "npm", "2.0.0"),
    app("a2", "pnpm", "2.0.0"),
    app("a3", "bun", "2.0.0+build.1"),
    app("a4", "npm", "2.0.0+build.2"),
  ];
  const installations = [tool("npm", "4.0.0"), tool("bun", "4.1.0")];
  const forward = versionDrift(snapshotOf(projects, installations));
  const reversed = versionDrift(
    snapshotOf(
      projects
        .toReversed()
        .map((item) => ({ ...item, dependencies: item.dependencies.toReversed() })),
      installations.toReversed(),
    ),
  );
  assert.deepEqual(reversed, forward);
  assert.deepEqual(
    forward.map((row) => row.key),
    ["projects:pkg", "global:tsx"],
  );
  assert.deepEqual(forward[0]!.versions, ["3.0.0", "2.0.0", "2.0.0+build.1", "2.0.0+build.2"]);
  assert.deepEqual(
    forward[0]!.usages.map((usage) => `${usage.subjectId}:${usage.where}`),
    [
      "a1:packages/web",
      "a2:packages/web",
      "a3:packages/web",
      "a4:packages/web",
      "a1:root",
      "a2:root",
      "a3:root",
      "a4:root",
    ],
  );
});

test("global copies count only as managed registry installs with SemVer versions, and an alias gets no command", () => {
  const rows = versionDrift(
    snapshotOf(
      [],
      [
        tool("npm", "4.1.0"),
        { ...tool("bun", "4.0.0"), id: "tsx-alias", name: "tsx-next" },
        { ...tool("bun", "9.0.0"), id: "local", origin: "local" },
        { ...tool("bun", "8.0.0"), id: "unknown-origin", origin: undefined },
        { ...tool("bun", "7.0.0"), id: "unmanaged", manager: undefined },
        { ...tool("bun", "latest"), id: "not-semver" },
      ],
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.versions]),
    [["global:tsx", ["4.1.0", "4.0.0"]]],
  );
  assert.deepEqual(
    rows[0]!.usages.map((usage) => [usage.name, usage.where, usage.version, usage.command]),
    [
      ["tsx-next", "Bun", "4.0.0", null],
      ["tsx", "npm", "4.1.0", null],
    ],
  );
});

test("copies align to the newest stable version in use, and a prerelease newer than that is left alone", () => {
  const rows = versionDrift(
    snapshotOf(
      [
        project("a", "npm", [dep("pkg", "2.0.0")]),
        project("b", "npm", [dep("pkg", "1.0.0")]),
        project("c", "npm", [dep("pkg", "3.0.0-beta")]),
        project("d", "npm", [dep("pkg", "2.0.0-rc.1")]),
      ],
      [
        tool("npm", "1.0.0"),
        tool("bun", "3.0.0-beta"),
        { ...tool("bun", "2.0.0"), id: "tsx-next", name: "tsx-next" },
      ],
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.target, row.versions]),
    [
      ["projects:pkg", "2.0.0", ["3.0.0-beta", "2.0.0", "2.0.0-rc.1", "1.0.0"]],
      ["global:tsx", "2.0.0", ["3.0.0-beta", "2.0.0", "1.0.0"]],
    ],
  );
  // The beta copy is newer than the target: not behind, and no command that would downgrade it.
  // A prerelease of the target's own version is older than it, so it is behind.
  assert.deepEqual(
    rows[0]!.usages.map((usage) => [
      usage.subjectLabel,
      usage.version,
      usage.behind,
      usage.command,
    ]),
    [
      ["a", "2.0.0", false, null],
      ["b", "1.0.0", true, "npm install pkg@2.0.0"],
      ["c", "3.0.0-beta", false, null],
      ["d", "2.0.0-rc.1", true, "npm install pkg@2.0.0"],
    ],
  );
  assert.deepEqual(
    rows[1]!.usages.map((usage) => [
      usage.where,
      usage.name,
      usage.version,
      usage.behind,
      usage.command,
    ]),
    [
      ["Bun", "tsx", "3.0.0-beta", false, null],
      ["Bun", "tsx-next", "2.0.0", false, null],
      ["npm", "tsx", "1.0.0", true, "npm install --global tsx@2.0.0"],
    ],
  );
});

test("when only prereleases are in use, the newest prerelease is the target", () => {
  const rows = versionDrift(
    snapshotOf(
      [
        project("a", "npm", [dep("pkg", "1.0.0-beta.2")]),
        project("b", "npm", [dep("pkg", "1.0.0-alpha")]),
        project("c", "npm", [dep("pkg", "1.0.0-rc.1")]),
      ],
      [tool("npm", "2.0.0-beta.1"), tool("bun", "2.0.0-beta.2")],
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.target]),
    [
      ["projects:pkg", "1.0.0-rc.1"],
      ["global:tsx", "2.0.0-beta.2"],
    ],
  );
  assert.deepEqual(
    rows[0]!.usages.map((usage) => [usage.version, usage.behind, usage.command]),
    [
      ["1.0.0-beta.2", true, "npm install pkg@1.0.0-rc.1"],
      ["1.0.0-alpha", true, "npm install pkg@1.0.0-rc.1"],
      ["1.0.0-rc.1", false, null],
    ],
  );
  assert.deepEqual(
    rows[1]!.usages.map((usage) => [usage.where, usage.behind, usage.command]),
    [
      ["Bun", false, null],
      ["npm", true, "npm install --global tsx@2.0.0-beta.2"],
    ],
  );
});

test("the project root and a workspace folder named root keep one order, each with its own command", () => {
  // Both read "root", so name, version and project tie; only the command tells them apart.
  const layout: [string, string][] = [
    [".", "1.0.0"],
    ["root", "1.0.0"],
    ["apps/web", "2.0.0"],
  ];
  const mono = (order: [string, string][]) =>
    project(
      "mono",
      "npm",
      order.map(([importer, version]) => dep("pkg", version, { importer })),
    );
  const forward = versionDrift(snapshotOf([mono(layout)]));
  assert.deepEqual(versionDrift(snapshotOf([mono(layout.toReversed())])), forward);
  assert.deepEqual(
    forward[0]!.usages.map((usage) => [usage.where, usage.command]),
    [
      ["apps/web", null],
      ["root", "npm install pkg@2.0.0"],
      ["root", "npm install pkg@2.0.0 --workspace root"],
    ],
  );
});

test("copies of one package in one workspace are ordered by the name they are installed under", () => {
  // The alias is newer, so ordering by version would put it first.
  const dependencies = [dep("pkg", "1.0.0"), dep("zeta", "2.0.0", { packageName: "pkg" })];
  const forward = versionDrift(snapshotOf([project("app", "npm", dependencies)]));
  assert.deepEqual(
    versionDrift(snapshotOf([project("app", "npm", dependencies.toReversed())])),
    forward,
  );
  assert.deepEqual(
    forward[0]!.usages.map((usage) => [usage.name, usage.version]),
    [
      ["pkg", "1.0.0"],
      ["zeta", "2.0.0"],
    ],
  );
});

test("a package in projects and on this PC lists its This PC row first, whatever the snapshot order", () => {
  const projects = [
    project("a", "npm", [dep("tsx", "1.0.0")]),
    project("b", "npm", [dep("tsx", "2.0.0")]),
  ];
  const installations = [tool("npm", "4.0.0"), tool("bun", "4.1.0")];
  const keys = ["global:tsx", "projects:tsx"];
  assert.deepEqual(
    versionDrift(snapshotOf(projects, installations)).map((row) => row.key),
    keys,
  );
  assert.deepEqual(
    versionDrift(snapshotOf(projects.toReversed(), installations.toReversed())).map(
      (row) => row.key,
    ),
    keys,
  );
});

test("a dependency repeated in one workspace at two versions keeps one order, newest first", () => {
  // Their commands read the same, so only the version can order them.
  const dependencies = [
    dep("pkg", "1.0.0"),
    dep("pkg", "2.0.0"),
    dep("pkg", "3.0.0", { importer: "apps/web" }),
  ];
  const forward = versionDrift(snapshotOf([project("app", "npm", dependencies)]));
  assert.deepEqual(
    versionDrift(snapshotOf([project("app", "npm", dependencies.toReversed())])),
    forward,
  );
  assert.deepEqual(
    forward[0]!.usages.map((usage) => [usage.where, usage.version]),
    [
      ["apps/web", "3.0.0"],
      ["root", "2.0.0"],
      ["root", "1.0.0"],
    ],
  );
});

test("the sheet lists the copies that need a change first, each group in place order", () => {
  const unchanged = Array.from({ length: 4 }, (_, index) =>
    dep("effect", "4.0.2", { importer: `packages/a${index}` }),
  );
  const rows = versionDrift(
    snapshotOf([
      project("aaa", "pnpm", unchanged),
      project("zzz", "pnpm", [
        dep("effect", "4.0.0", { importer: "apps/server" }),
        dep("effect", "4.0.1", { importer: "packages/contracts" }),
      ]),
    ]),
  );
  const usages = rows[0]!.usages;
  assert.deepEqual(
    usages.map((usage) => usage.subjectLabel),
    ["aaa", "aaa", "aaa", "aaa", "zzz", "zzz"],
    "The data stays in place order",
  );
  assert.deepEqual(
    behindFirst(usages).map((usage) => [usage.subjectLabel, usage.where, usage.behind]),
    [
      ["zzz", "apps/server", true],
      ["zzz", "packages/contracts", true],
      ["aaa", "packages/a0", false],
      ["aaa", "packages/a1", false],
      ["aaa", "packages/a2", false],
      ["aaa", "packages/a3", false],
    ],
  );
  assert.deepEqual(behindFirst([]), []);
});

test("This PC's commands wait while its results are unverified, and a project's never do", () => {
  const global = { scope: "global" } as const;
  const projects = { scope: "projects" } as const;
  const behind = { behind: true, command: "npm install --global tsx@4.1.0" };
  const held = "Finish a successful PC scan";
  assert.equal(usageAction(global, behind, null), "copy");
  assert.equal(usageAction(global, behind, held), "held");
  assert.equal(usageAction(projects, behind, held), "copy", "A project's evidence is not the PC's");
  assert.equal(usageAction(global, { behind: true, command: null }, held), "none");
  assert.equal(usageAction(global, { behind: false, command: null }, held), "unchanged");
  assert.equal(usageAction(projects, { behind: false, command: null }, null), "unchanged");
});
