import assert from "node:assert/strict";
import test from "node:test";
import type { Dependency, Finding } from "@versionstead/contracts/monitoring";
import { copyAllText, projectUpgradePlan } from "./upgrade-plan.ts";

const now = Date.parse("2026-10-08T18:00:00.000Z");
const dep = (name: string, changes: Partial<Dependency> = {}): Dependency => ({
  id: `hash-${name}`,
  name,
  packageName: name,
  requested: "^1.0.0",
  resolved: "1.0.0",
  origin: "registry",
  role: "production",
  importer: ".",
  availableVersion: "1.1.0",
  latestVersion: null,
  versionStatus: "checked",
  advisoryStatus: "checked",
  advisoryIds: [],
  ...changes,
});
const update = (dependency: Dependency, changes: Partial<Finding> = {}): Finding => ({
  id: `update-${dependency.name}`,
  kind: "update",
  subjectId: "project",
  subjectLabel: "Project",
  name: dependency.name,
  packageName: dependency.packageName,
  installedVersion: dependency.resolved,
  availableVersion: dependency.availableVersion ?? dependency.latestVersion,
  severity: "info",
  source: "npm registry",
  description: "A newer version satisfies the requested range.",
  advisoryUrl: null,
  detectedAt: "2026-10-08T00:00:00.000Z",
  lastSeenAt: "2026-10-08T00:00:00.000Z",
  publishedAt: "2026-09-01T00:00:00.000Z",
  ...changes,
});

test("the dialog's plan leaves out what the owner holds and what is inside the cooldown, and counts both", () => {
  const settled = dep("settled");
  const held = dep("held");
  const fresh = dep("fresh");
  const big = dep("big", { availableVersion: "1.2.0", latestVersion: "2.0.0" });
  const project = {
    packageManager: "npm" as const,
    dependencies: [settled, held, fresh, big],
  };
  const findings = [
    update(settled),
    update(held, { ruleId: "snooze-1" }),
    update(fresh, { publishedAt: "2026-10-08T12:00:00.000Z" }),
    update(big),
  ];
  const compatible = projectUpgradePlan(project, findings, false, 3, now);
  assert.deepEqual(
    compatible.commands.map((item) => item.command),
    ["npm install big@1.2.0 settled@1.1.0"],
  );
  assert.deepEqual([compatible.held, compatible.tooNew], [1, 1]);
  const major = projectUpgradePlan(project, findings, true, 3, now);
  assert.deepEqual(
    major.commands.map((item) => item.command),
    ["npm install big@2.0.0 settled@1.1.0"],
    "Including majors installs the latest release",
  );
  assert.deepEqual([major.held, major.tooNew], [1, 1]);
  assert.equal(
    projectUpgradePlan(project, findings, false, 0, now).tooNew,
    0,
    "With the cooldown off nothing is young",
  );
});

test("Copy all puts one command on each line, in the order shown", () => {
  const plan = projectUpgradePlan(
    {
      packageManager: "pnpm",
      dependencies: [
        dep("lodash"),
        dep("web", { importer: "packages/web" }),
        dep("tsx", { role: "development" }),
      ],
    },
    [],
    false,
    3,
    now,
  );
  assert.equal(
    copyAllText(plan),
    [
      "pnpm add lodash@1.1.0 -w",
      "pnpm add tsx@1.1.0 -D -w",
      "pnpm --filter ./packages/web add web@1.1.0",
    ].join("\n"),
  );
  assert.equal(copyAllText({ commands: [] }), "");
});
