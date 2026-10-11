import assert from "node:assert/strict";
import test from "node:test";
import { keepResolved, newlyResolved, resolvedLimit } from "../dist/resolved-findings.js";

const at = "2026-10-08T12:00:00.000Z";
const finding = (overrides) => ({
  kind: "update",
  subjectId: "project",
  subjectLabel: "Project",
  name: "tool",
  packageName: "tool",
  installedVersion: "1.0.0",
  availableVersion: "1.1.0",
  severity: "info",
  source: "npm registry",
  description: "A newer version satisfies the requested range.",
  advisoryUrl: null,
  detectedAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

test("a finding is resolved only when a check stops reporting its problem", () => {
  const update = finding({ id: "u1" });
  const advisory = finding({
    id: "a1",
    kind: "advisory",
    severity: "high",
    availableVersion: "1.0.1",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-1",
  });
  const runtime = finding({
    id: "n1",
    kind: "lifecycle",
    name: "Node.js 24",
    packageName: null,
    installedVersion: "24.1.0",
    availableVersion: null,
    severity: "low",
  });
  const before = [
    update,
    advisory,
    runtime,
    finding({ id: "c1", kind: "coverage" }),
    finding({ id: "o1", kind: "other" }),
  ];
  const ids = (after) => newlyResolved(before, after, at).map((item) => item.id);
  // A newer release, a rescored advisory, and a patched runtime line are the same open problems.
  assert.deepEqual(
    ids([
      { ...update, id: "u2", availableVersion: "1.2.0" },
      { ...advisory, id: "a2", severity: "critical" },
      { ...runtime, id: "n2", installedVersion: "24.2.0" },
    ]),
    [],
  );
  // The advisory still applies after a move to another affected version.
  assert.deepEqual(
    ids([update, runtime, { ...advisory, id: "a3", installedVersion: "1.0.0-1" }]),
    [],
  );
  // The installed version moved past the offer; the advisory and the runtime line are gone.
  const resolved = newlyResolved(
    before,
    [
      { ...update, id: "u3", installedVersion: "1.1.0", availableVersion: "2.0.0" },
      { ...runtime, id: "n3", name: "Node.js 26", installedVersion: "26.0.0" },
    ],
    at,
  );
  assert.deepEqual(
    resolved.map((item) => item.id),
    ["u1", "a1", "n1"],
    "never a gap or an unknown kind",
  );
  assert.ok(resolved.every((item) => item.resolvedAt === at));
});

test("a package the scan could not read is left unknown, never reported resolved", () => {
  const update = finding({ id: "x1", name: "unread", packageName: "unread" });
  const advisory = finding({
    id: "x2",
    kind: "advisory",
    name: "unread",
    packageName: "unread",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-2",
  });
  const gone = finding({ id: "x3", name: "gone", packageName: "gone" });
  const runtime = finding({
    id: "x4",
    kind: "lifecycle",
    name: "Node.js 24",
    packageName: null,
    installedVersion: "24.1.0",
    availableVersion: null,
  });
  const deprecation = finding({
    id: "x5",
    kind: "lifecycle",
    name: "unread",
    packageName: "unread",
    availableVersion: null,
    severity: "low",
  });
  const ids = (...unread) =>
    newlyResolved([update, advisory, gone, runtime, deprecation], [], at, ...unread).map(
      (item) => item.id,
    );
  // Each kind of finding of an unread package is held back, a deprecation notice included. A
  // package that is gone is resolved, and so is a runtime line, which names no package.
  assert.deepEqual(ids(new Set(["unread"])), ["x3", "x4"]);
  // Without the set, whatever the checks stopped reporting is resolved.
  assert.deepEqual(ids(), ["x1", "x2", "x3", "x4", "x5"]);
});

test("resolved history keeps the last 30 days, at most 500, newest first, without reopened problems", () => {
  const now = Date.parse(at);
  const day = 86_400_000;
  const entry = (id, ageDays) => ({
    ...finding({ id, name: id, packageName: id }),
    resolvedAt: new Date(now - ageDays * day).toISOString(),
  });
  const kept = keepResolved(
    [
      entry("old", 31),
      entry("edge", 30),
      entry("recent", 1),
      entry("open", 2),
      { ...entry("bad", 1), resolvedAt: "not a time" },
    ],
    [finding({ id: "open-again", name: "open", packageName: "open" })],
    now,
  );
  assert.deepEqual(
    kept.map((item) => item.id),
    ["recent", "edge"],
  );
  const many = Array.from({ length: resolvedLimit + 20 }, (_, index) =>
    entry(`p${index}`, index / 100),
  );
  const bounded = keepResolved(many, [], now);
  assert.equal(bounded.length, 500);
  assert.equal(bounded[0].id, "p0");
});

test("a package's advisories are separate problems, and so is an alias that names another package", () => {
  const advisory = (id, ghsa) =>
    finding({
      id,
      kind: "advisory",
      severity: "high",
      availableVersion: "1.0.1",
      advisoryUrl: `https://osv.dev/vulnerability/${ghsa}`,
    });
  const first = advisory("a1", "GHSA-1");
  const second = advisory("a2", "GHSA-2");
  // One of the package's two advisories is fixed; the other still applies.
  assert.deepEqual(
    newlyResolved([first, second], [{ ...second, id: "a3" }], at).map((item) => item.id),
    ["a1"],
  );
  // An alias keeps its name but installs another package: the first package's problem is gone.
  const aliased = (packageName) => finding({ id: packageName, name: "alias", packageName });
  assert.deepEqual(
    newlyResolved([aliased("real-a")], [aliased("real-b")], at).map((item) => item.id),
    ["real-a"],
  );
});

test("a problem open in one subject does not reopen another subject's resolved copy", () => {
  const now = Date.parse(at);
  const resolved = { ...finding({ id: "a1", subjectId: "project-a" }), resolvedAt: at };
  const open = (subjectId) => [finding({ id: `open-${subjectId}`, subjectId })];
  assert.deepEqual(
    keepResolved([resolved], open("project-b"), now).map((item) => item.id),
    ["a1"],
  );
  assert.deepEqual(keepResolved([resolved], open("project-a"), now), [], "its own subject does");
});
