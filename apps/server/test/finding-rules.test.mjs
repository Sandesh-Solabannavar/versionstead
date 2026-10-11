import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  CreateFindingRule,
  decodeFindingRule,
  MonitoringSnapshot,
} from "@versionstead/contracts/monitoring";
import * as Schema from "effect/Schema";
import { sharedEvidence } from "../dist/adapters/paired-computers.js";
import { selectDirectory } from "../dist/adapters/projects.js";
import {
  createRule,
  expiredRuleIds,
  matchingRule,
  ruleIndex,
  ruleScope,
} from "../dist/finding-rules.js";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { startServer } from "../dist/server.js";
import { MonitoringStorage } from "../dist/storage.js";

// Windows cannot delete a SQLite database that is still open. The directories are removed once,
// after every test has run its own `t.after` hooks and closed its coordinators and servers.
const directories = [];
after(() =>
  Promise.all(
    directories.map((path) =>
      rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  ),
);

const now = Date.parse("2026-10-08T12:00:00.000Z");
const day = 86_400_000;
const base = {
  id: "f",
  kind: "update",
  subjectId: "project",
  subjectLabel: "Project",
  name: "left-pad",
  packageName: "left-pad",
  installedVersion: "1.0.0",
  availableVersion: "1.3.0",
  severity: "info",
  source: "npm registry",
  description: "A newer version satisfies the requested range.",
  advisoryUrl: null,
  detectedAt: "2026-10-08T00:00:00.000Z",
  lastSeenAt: "2026-10-08T00:00:00.000Z",
};
const finding = (changes = {}) => ({ ...base, ...changes });
const hidden = (rules, item, at = now) => matchingRule(ruleIndex(rules), item, at)?.id ?? null;

test("a snooze covers its subject, package and kind until its date, across new candidate versions", () => {
  const rule = createRule({ findingId: "f", mode: "snooze", days: 7 }, finding(), now, "r1");
  assert.deepEqual(rule, {
    id: "r1",
    scope: { subjectId: "project", kind: "update", packageName: "left-pad" },
    mode: "snooze",
    until: "2026-10-15T12:00:00.000Z",
    createdAt: "2026-10-08T12:00:00.000Z",
  });
  assert.equal(
    hidden([rule], finding({ id: "g", availableVersion: "1.4.0", installedVersion: "1.1.0" })),
    "r1",
  );
  assert.equal(hidden([rule], finding({ subjectId: "other" })), null);
  assert.equal(
    hidden(
      [rule],
      finding({ kind: "advisory", advisoryUrl: "https://osv.dev/vulnerability/GHSA-1" }),
    ),
    null,
  );
  assert.equal(hidden([rule], finding(), now + 7 * day - 1), "r1");
  assert.equal(hidden([rule], finding(), now + 7 * day), null, "The snooze ends at its date");
  for (const days of [30, 90])
    assert.equal(
      Date.parse(createRule({ findingId: "f", mode: "snooze", days }, finding(), now, "r").until),
      now + days * day,
    );
});

test("a version snooze ends when a newer version than the snoozed candidate appears", () => {
  const rule = createRule(
    { findingId: "f", mode: "snooze", untilNewerVersion: true },
    finding(),
    now,
    "r2",
  );
  assert.equal(rule.untilVersion, "1.3.0");
  assert.equal(rule.until, undefined);
  assert.equal(hidden([rule], finding()), "r2");
  assert.equal(
    hidden([rule], finding({ availableVersion: "1.3.0", installedVersion: "1.2.0" })),
    "r2",
  );
  assert.equal(hidden([rule], finding({ availableVersion: "1.3.1" })), null);
  assert.equal(hidden([rule], finding({ availableVersion: "1.4.0-beta.1" })), null);
  assert.equal(
    hidden([rule], finding({ availableVersion: "not-semver" })),
    null,
    "An unparseable candidate is never hidden",
  );
  for (const target of [finding({ kind: "advisory" }), finding({ availableVersion: "latest" })])
    assert.throws(
      () =>
        createRule({ findingId: "f", mode: "snooze", untilNewerVersion: true }, target, now, "x"),
      /Only an update with a known candidate version/,
    );
});

test("rules never hide an advisory with another identity, a changed incomplete check, or a raised lifecycle severity", () => {
  const advisory = finding({
    kind: "advisory",
    severity: "high",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-aaaa",
    availableVersion: "1.2.0",
  });
  const ignored = createRule(
    { findingId: "f", mode: "ignore", reason: "Not reachable in our build" },
    advisory,
    now,
    "r3",
  );
  assert.equal(hidden([ignored], { ...advisory, id: "a2", installedVersion: "1.0.1" }), "r3");
  assert.equal(
    hidden([ignored], { ...advisory, advisoryUrl: "https://osv.dev/vulnerability/GHSA-bbbb" }),
    null,
  );
  // Without a link the finding's own id is the identity, so any change of it shows the advisory again.
  const bare = { ...advisory, advisoryUrl: null };
  const unlinked = createRule(
    { findingId: "f", mode: "ignore", reason: "No link" },
    bare,
    now,
    "r3b",
  );
  assert.equal(unlinked.scope.detail, "f");
  assert.equal(hidden([unlinked], bare), "r3b");
  assert.equal(hidden([unlinked], { ...bare, id: "a3" }), null);
  const coverage = finding({
    kind: "coverage",
    name: "Incomplete checks",
    packageName: null,
    installedVersion: null,
    availableVersion: null,
    severity: "unknown",
    description: "Known-advisory lookup failed.",
  });
  const snoozed = createRule({ findingId: "f", mode: "snooze", days: 30 }, coverage, now, "r4");
  assert.equal(hidden([snoozed], coverage), "r4");
  assert.equal(
    hidden([snoozed], {
      ...coverage,
      description:
        "Known-advisory lookup failed. A workspace importer has no readable package.json.",
    }),
    null,
    "A new gap shows again",
  );
  const lifecycle = finding({
    kind: "lifecycle",
    name: "Node.js 20",
    packageName: null,
    severity: "moderate",
    availableVersion: null,
  });
  const quiet = createRule({ findingId: "f", mode: "snooze", days: 90 }, lifecycle, now, "r5");
  assert.equal(hidden([quiet], lifecycle), "r5");
  assert.equal(
    hidden([quiet], { ...lifecycle, severity: "high" }),
    null,
    "End of life shows a snoozed warning again",
  );
});

test("an advisory hidden at one rating shows again when it is rated higher, and a lower rating stays hidden", () => {
  const advisory = finding({
    kind: "advisory",
    severity: "moderate",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-aaaa",
  });
  const rule = createRule(
    { findingId: "f", mode: "ignore", reason: "Not reachable in our build" },
    advisory,
    now,
    "r9",
  );
  assert.equal(rule.scope.severity, "moderate", "The rule records the rating it was made at");
  for (const [severity, shown] of [
    ["moderate", false],
    ["low", false],
    ["info", false],
    ["unknown", false],
    ["high", true],
    ["critical", true],
  ])
    assert.equal(hidden([rule], { ...advisory, severity }), shown ? null : "r9", severity);
  // Once the raised rating shows the advisory, the rule hides nothing and is removed.
  const subjects = new Set(["project"]);
  assert.deepEqual([...expiredRuleIds([rule], [advisory], subjects, now)], []);
  assert.deepEqual(
    [...expiredRuleIds([rule], [{ ...advisory, severity: "high" }], subjects, now)],
    ["r9"],
  );
  // An advisory whose rating could not be read when it was hidden shows once the rating is known.
  const unrated = { ...advisory, severity: "unknown" };
  const blind = createRule({ findingId: "f", mode: "snooze", days: 30 }, unrated, now, "r10");
  assert.equal(hidden([blind], unrated), "r10");
  assert.equal(hidden([blind], { ...advisory, severity: "low" }), null);
  // Only advisories record a rating; other rules are not tied to one.
  for (const other of [finding(), finding({ kind: "lifecycle", severity: "moderate" })])
    assert.equal(
      createRule({ findingId: "f", mode: "snooze", days: 7 }, other, now, "r11").scope.severity,
      undefined,
    );
});

test("a rule for a finding of an unknown kind covers that finding only", () => {
  const unknown = finding({
    id: "x1",
    kind: "other",
    name: "Future signal",
    packageName: "left-pad",
  });
  const rule = createRule({ findingId: "x1", mode: "snooze", days: 30 }, unknown, now, "r8");
  assert.deepEqual(rule.scope, {
    subjectId: "project",
    kind: "other",
    packageName: "left-pad",
    detail: "x1",
  });
  assert.equal(hidden([rule], unknown), "r8");
  assert.equal(
    hidden([rule], { ...unknown, id: "x2", name: "Another future signal" }),
    null,
    "Another unknown kind of the same package shows",
  );
});

test("rule requests need a reason to ignore, exactly one end to snooze, and never ignore incomplete checks", () => {
  for (const [request, message] of [
    [{ findingId: "f", mode: "ignore" }, /at least 3 characters/],
    [{ findingId: "f", mode: "ignore", reason: "  ok " }, /at least 3 characters/],
    [{ findingId: "f", mode: "ignore", reason: "x".repeat(201) }, /200 characters/],
    [{ findingId: "f", mode: "ignore", reason: "Pinned", days: 7 }, /no end date/],
    [{ findingId: "f", mode: "snooze" }, /7, 30, or 90 days/],
    [{ findingId: "f", mode: "snooze", days: 7, untilNewerVersion: true }, /7, 30, or 90 days/],
  ])
    assert.throws(() => createRule(request, finding(), now, "x"), message);
  assert.throws(
    () =>
      createRule(
        { findingId: "f", mode: "ignore", reason: "Known gap" },
        finding({ kind: "coverage", packageName: null }),
        now,
        "x",
      ),
    /snoozed but not ignored/,
  );
  const ignored = createRule(
    { findingId: "f", mode: "ignore", reason: "  Pinned for compatibility  " },
    finding(),
    now,
    "r6",
  );
  assert.equal(ignored.reason, "Pinned for compatibility");
  assert.equal(ignored.until, undefined);
});

test("rules that hide nothing are expired: a passed date, a newer candidate, a resolved finding, a removed target", () => {
  const other = { packageName: "other", name: "other" };
  const dated = createRule({ findingId: "f", mode: "snooze", days: 7 }, finding(), now, "dated");
  const versioned = createRule(
    { findingId: "f", mode: "snooze", untilNewerVersion: true },
    finding(other),
    now,
    "versioned",
  );
  const gone = createRule(
    { findingId: "f", mode: "ignore", reason: "Removed project" },
    finding({ subjectId: "removed" }),
    now,
    "gone",
  );
  const rules = [dated, versioned, gone];
  const subjects = new Set(["project"]);
  const expired = (findings, at = now) => [...expiredRuleIds(rules, findings, subjects, at)].sort();
  const current = [finding(), finding(other)];
  assert.deepEqual(expired(current), ["gone"], "Only the removed target's rule hides nothing");
  assert.deepEqual(expired(current, now + 7 * day - 1), ["gone"]);
  assert.deepEqual(expired(current, now + 7 * day), ["dated", "gone"], "The date passed");
  assert.deepEqual(
    expired([finding(), finding({ ...other, availableVersion: "1.3.1" })]),
    ["gone", "versioned"],
    "A newer candidate than the snoozed version",
  );
  assert.deepEqual(expired([finding({ ...other, availableVersion: "1.3.1" })], now + 7 * day), [
    "dated",
    "gone",
    "versioned",
  ]);
  assert.deepEqual(expired([finding(other)]), ["dated", "gone"], "The snoozed finding is resolved");
  assert.deepEqual(expired([]), ["dated", "gone", "versioned"]);
});

test("a rule is also expired once its advisory is fixed or its lifecycle severity moves", () => {
  const advisory = finding({
    kind: "advisory",
    severity: "high",
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-aaaa",
  });
  const lifecycle = finding({
    kind: "lifecycle",
    name: "Node.js 20",
    packageName: null,
    severity: "moderate",
    availableVersion: null,
  });
  const ignored = createRule(
    { findingId: "f", mode: "ignore", reason: "Not reachable" },
    advisory,
    now,
    "advisory",
  );
  const quiet = createRule({ findingId: "f", mode: "snooze", days: 90 }, lifecycle, now, "runtime");
  const expired = (findings) =>
    [...expiredRuleIds([ignored, quiet], findings, new Set(["project"]), now)].sort();
  assert.deepEqual(expired([advisory, lifecycle]), []);
  assert.deepEqual(expired([advisory, { ...lifecycle, severity: "high" }]), ["runtime"]);
  assert.deepEqual(
    expired([lifecycle]),
    ["advisory"],
    "A fixed advisory leaves its rule with nothing to hide",
  );
  assert.deepEqual(
    expired([{ ...advisory, advisoryUrl: "https://osv.dev/vulnerability/GHSA-bbbb" }, lifecycle]),
    ["advisory"],
  );
});

test("a version snooze on one copy of a package survives another copy of it in the same project", () => {
  const oneX = finding({ id: "1x", installedVersion: "1.0.0", availableVersion: "1.3.0" });
  const twoX = finding({ id: "2x", installedVersion: "2.0.0", availableVersion: "2.1.0" });
  const rule = createRule(
    { findingId: "1x", mode: "snooze", untilNewerVersion: true },
    oneX,
    now,
    "v",
  );
  const subjects = new Set(["project"]);
  assert.equal(rule.untilVersion, "1.3.0");
  assert.equal(hidden([rule], oneX), "v");
  assert.equal(hidden([rule], twoX), null, "The 2.x copy has a newer candidate and still shows");
  assert.deepEqual([...expiredRuleIds([rule], [oneX, twoX], subjects, now)], []);
  assert.deepEqual([...expiredRuleIds([rule], [twoX, oneX], subjects, now)], []);
  assert.deepEqual(
    [...expiredRuleIds([rule], [twoX], subjects, now)],
    ["v"],
    "With the 1.x copy gone the rule hides nothing",
  );
});

test("rule contracts reject malformed requests and stored rules, and keep at most 500 rules", () => {
  const request = Schema.decodeUnknownSync(CreateFindingRule);
  assert.deepEqual(request({ findingId: "f", mode: "snooze", days: 30 }), {
    findingId: "f",
    mode: "snooze",
    days: 30,
  });
  assert.deepEqual(request({ findingId: "f", mode: "ignore", reason: "Pinned" }), {
    findingId: "f",
    mode: "ignore",
    reason: "Pinned",
  });
  for (const body of [
    {},
    { findingId: "f" },
    { findingId: "f", mode: "pause" },
    { findingId: "f", mode: "snooze", days: 8 },
    { findingId: "f", mode: "snooze", days: "7" },
    { findingId: "f", mode: "snooze", untilNewerVersion: "yes" },
    { findingId: "f".repeat(101), mode: "snooze", days: 7 },
    { findingId: "f", mode: "ignore", reason: "x".repeat(201) },
  ])
    assert.throws(() => request(body), Error, JSON.stringify(body));
  const stored = {
    id: "r",
    scope: { subjectId: "project", kind: "update", packageName: "left-pad" },
    mode: "ignore",
    reason: "Pinned",
    createdAt: "2026-10-08T12:00:00.000Z",
  };
  assert.deepEqual(decodeFindingRule(stored), stored);
  const rated = { ...stored, scope: { ...stored.scope, kind: "advisory", severity: "high" } };
  assert.deepEqual(
    decodeFindingRule(rated),
    rated,
    "The rating an advisory rule was made at is kept",
  );
  assert.equal(
    decodeFindingRule({ ...stored, scope: { ...stored.scope, kind: "drift" } }).scope.kind,
    "other",
    "A kind a newer version adds decodes as other",
  );
  for (const broken of [
    { ...stored, mode: "forever" },
    { ...stored, reason: "x".repeat(201) },
    { ...stored, scope: { subjectId: "project", kind: "update" } },
    { ...stored, scope: { ...stored.scope, severity: "severe" } },
    { ...stored, createdAt: 1 },
  ])
    assert.throws(() => decodeFindingRule(broken), Error, JSON.stringify(broken));
  const rules = Schema.decodeUnknownSync(MonitoringSnapshot.fields.findingRules);
  assert.equal(rules(Array.from({ length: 500 }, () => stored)).length, 500);
  assert.throws(() => rules(Array.from({ length: 501 }, () => stored)), Error);
});

async function temporary() {
  const path = await selectDirectory(await mkdtemp(join(tmpdir(), "versionstead-rules-")));
  directories.push(path);
  return path;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function finishScan(coordinator, projectId) {
  const previous = coordinator.snapshot().history[0]?.id;
  coordinator.requestScan({ target: "projects", projectId });
  await waitFor(() => {
    const latest = coordinator.snapshot().history[0];
    return latest?.id !== previous && latest?.status !== "scanning";
  });
}
async function aliasFixture(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", dependencies: { alias: "npm:public-example@^1.0.0" } },
        "node_modules/alias": {
          name: "public-example",
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/public-example/-/public-example-1.0.0.tgz",
        },
      },
    }),
  );
}
const withUpdate =
  (version, errors = []) =>
  async (dependencies) => ({
    dependencies: dependencies.map((d) => ({
      ...d,
      availableVersion: d.name === "alias" ? version : null,
      versionStatus: "checked",
      advisoryStatus: "checked",
    })),
    versionChecked: new Set(dependencies.map((d) => d.id)),
    advisories: new Map(),
    coverage: [],
    errors,
  });

test("a snooze hides its finding until it expires, survives a restart, and is then removed", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  const options = {
    dataDir: join(root, "state"),
    dependencyLookup: withUpdate("1.5.0"),
    now: () => clock,
  };
  let coordinator = new MonitoringCoordinator(options);
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, project.id);
  const update = coordinator.snapshot().findings.find((f) => f.kind === "update");
  const rule = coordinator.addFindingRule({
    findingId: update.id,
    mode: "snooze",
    days: 7,
    reason: "Waiting for the audit sign-off",
  });
  assert.equal(rule.until, "2026-10-15T12:00:00.000Z");
  assert.equal(coordinator.snapshot().findings.find((f) => f.id === update.id).ruleId, rule.id);
  assert.equal(
    JSON.parse(coordinator.snapshotJson()).findings.find((f) => f.id === update.id).ruleId,
    rule.id,
  );
  // Paired PCs: a v10 client sees the annotation; an older client gets the finding without it, and
  // keeps everything else it can read (rulings 7 and 12). The rules, with the owner's reasons, never
  // leave this PC (D7).
  const v10 = "settings-repositories-connections-v10";
  const sharedWith = (features) => sharedEvidence(coordinator.snapshot(), features);
  const shared = (features) => sharedWith(features).findings.find((f) => f.id === update.id);
  assert.equal(shared(v10).ruleId, rule.id);
  assert.equal("ruleId" in shared(undefined), false, "Older paired clients never receive ruleId");
  for (const features of [v10, undefined]) {
    assert.equal("findingRules" in sharedWith(features), false, "Rules stay on this PC");
    assert.equal(JSON.stringify(sharedWith(features)).includes("audit sign-off"), false);
  }
  const live = coordinator.snapshot();
  assert.deepEqual(
    sharedEvidence(live, undefined).scanProgress,
    live.scanProgress,
    "Older paired clients still receive live scan progress",
  );
  // The rule is stored with the evidence: it still hides the finding after a restart.
  await coordinator.close();
  coordinator = new MonitoringCoordinator(options);
  assert.deepEqual(coordinator.snapshot().findingRules, [rule]);
  assert.equal(coordinator.snapshot().findings.find((f) => f.id === update.id).ruleId, rule.id);
  await coordinator.close();
  clock = Date.parse("2026-10-20T12:00:00.000Z");
  coordinator = new MonitoringCoordinator(options);
  assert.equal(coordinator.snapshot().findings.find((f) => f.id === update.id).ruleId, undefined);
  await waitFor(() => coordinator.snapshot().findingRules.length === 0);
});

test("a version snooze ends when a newer candidate appears, and rules leave with their project", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  let candidate = "1.5.0";
  const coordinator = new MonitoringCoordinator({
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => withUpdate(candidate)(dependencies),
  });
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, project.id);
  const update = coordinator.snapshot().findings.find((f) => f.kind === "update");
  const rule = coordinator.addFindingRule({
    findingId: update.id,
    mode: "snooze",
    untilNewerVersion: true,
  });
  assert.equal(rule.untilVersion, "1.5.0");
  candidate = "1.6.0";
  await finishScan(coordinator, project.id);
  const newer = coordinator.snapshot().findings.find((f) => f.kind === "update");
  assert.equal(newer.availableVersion, "1.6.0");
  assert.equal(newer.ruleId, undefined, "A newer version than the snoozed one shows again");
  await waitFor(() => coordinator.snapshot().findingRules.length === 0);
  coordinator.addFindingRule({
    findingId: newer.id,
    mode: "ignore",
    reason: "Pinned for compatibility",
  });
  coordinator.removeProject(project.id);
  await waitFor(() => coordinator.snapshot().findingRules.length === 0);
});

test("an advisory hidden at one rating shows again when it is rated higher, also after a restart", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  let severity = "moderate";
  const options = {
    dataDir: join(root, "state"),
    dependencyLookup: async (dependencies) => ({
      ...(await withUpdate(null)(dependencies)),
      advisories: new Map(
        dependencies.map((d) => [
          d.id,
          [
            {
              id: "GHSA-test",
              summary: "Prototype pollution",
              severity,
              url: "https://osv.dev/vulnerability/GHSA-test",
              fixed: "1.0.1",
              detailsUnavailable: false,
            },
          ],
        ]),
      ),
    }),
  };
  let coordinator = new MonitoringCoordinator(options);
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, project.id);
  const advisory = () => coordinator.snapshot().findings.find((f) => f.kind === "advisory");
  const rule = coordinator.addFindingRule({
    findingId: advisory().id,
    mode: "ignore",
    reason: "Not reachable in our build",
  });
  assert.equal(rule.scope.severity, "moderate");
  assert.equal(advisory().ruleId, rule.id);
  await coordinator.close();
  coordinator = new MonitoringCoordinator(options);
  severity = "low";
  await finishScan(coordinator, project.id);
  assert.equal(advisory().severity, "low");
  assert.equal(advisory().ruleId, rule.id, "A lower rating stays hidden");
  severity = "high";
  await finishScan(coordinator, project.id);
  assert.equal(advisory().severity, "high");
  assert.equal(advisory().ruleId, undefined, "A higher rating shows the advisory again");
  await waitFor(() => coordinator.snapshot().findingRules.length === 0);
});

test("rule routes validate requests, change nothing on rejection, and require the capability", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const dataDir = join(root, "state");
  const coordinator = new MonitoringCoordinator({
    dataDir,
    dependencyLookup: withUpdate("1.5.0", ["Injected incomplete check."]),
  });
  coordinator.changeSettings({ paused: true });
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({ port: 0, monitoring: coordinator, authToken: token });
  t.after(async () => {
    await server.close();
    await coordinator.close();
  });
  const call = (path, method, body) =>
    fetch(`${server.origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, project.id);
  const update = coordinator.snapshot().findings.find((f) => f.kind === "update");
  const gap = coordinator.snapshot().findings.find((f) => f.kind === "coverage");
  for (const body of [
    {},
    { findingId: update.id, mode: "snooze" },
    { findingId: update.id, mode: "snooze", days: 8 },
    { findingId: update.id, mode: "snooze", days: 7, untilNewerVersion: true },
    { findingId: update.id, mode: "ignore" },
    { findingId: update.id, mode: "ignore", reason: "  " },
    { findingId: update.id, mode: "ignore", reason: "\u200b\u200b\u200b" },
    { findingId: update.id, mode: "ignore", reason: "x".repeat(201) },
    { findingId: "missing", mode: "snooze", days: 7 },
    { findingId: gap.id, mode: "ignore", reason: "Known gap" },
  ]) {
    const rejected = await call("/api/findings/rules", "POST", body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal((await rejected.text()).includes(root), false, "An error never names a path");
  }
  assert.deepEqual(coordinator.snapshot().findingRules, [], "Rejected requests change nothing");
  const anonymous = await fetch(`${server.origin}/api/findings/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ findingId: update.id, mode: "snooze", days: 7 }),
  });
  assert.equal(anonymous.status, 401);
  const anonymousDelete = await fetch(
    `${server.origin}/api/findings/rules/00000000-0000-4000-8000-000000000000`,
    { method: "DELETE" },
  );
  assert.equal(anonymousDelete.status, 401, "Removing a rule needs the capability too");
  const created = await call("/api/findings/rules", "POST", {
    findingId: update.id,
    mode: "ignore",
    reason: "Pinned for compatibility",
  });
  assert.equal(created.status, 201);
  const rule = await created.json();
  assert.equal(rule.reason, "Pinned for compatibility");
  // A snoozed gap leaves the attention list, but its project keeps the status of the incomplete check.
  assert.equal(coordinator.snapshot().projects[0].evidence.status, "partial");
  const snoozed = await call("/api/findings/rules", "POST", {
    findingId: gap.id,
    mode: "snooze",
    days: 30,
  });
  assert.equal(snoozed.status, 201);
  const hiddenGap = coordinator.snapshot().findings.find((f) => f.id === gap.id);
  assert.equal(hiddenGap.ruleId, (await snoozed.json()).id);
  const evidence = coordinator.snapshot().projects[0].evidence;
  assert.equal(evidence.status, "partial", "Snoozing a gap never turns it into clean");
  assert.deepEqual(evidence.errors, ["Injected incomplete check."]);
  assert.equal((await call(`/api/findings/rules/${rule.id}`, "DELETE")).status, 200);
  assert.equal((await call(`/api/findings/rules/${rule.id}`, "DELETE")).status, 400);
  assert.equal((await call("/api/findings/rules/not%20an%20id!", "DELETE")).status, 400);
  assert.equal(coordinator.snapshot().findings.find((f) => f.id === update.id).ruleId, undefined);
});

test("at most 500 rules are kept", async (t) => {
  const root = await temporary();
  const projectRoot = join(root, "project");
  await aliasFixture(projectRoot);
  const options = { dataDir: join(root, "state"), dependencyLookup: withUpdate("1.5.0") };
  let coordinator = new MonitoringCoordinator(options);
  t.after(() => coordinator.close());
  coordinator.changeSettings({ paused: true });
  const project = await coordinator.addProject({ path: projectRoot, mode: "maintained" });
  await finishScan(coordinator, project.id);
  const update = coordinator.snapshot().findings.find((f) => f.kind === "update");
  await coordinator.close();
  const storage = new MonitoringStorage(options.dataDir);
  try {
    const stored = storage.read();
    stored.snapshot.findingRules = Array.from({ length: 500 }, (_, index) => ({
      id: `rule-${index}`,
      scope: { subjectId: project.id, kind: "update", packageName: `package-${index}` },
      mode: "ignore",
      reason: "Bounded fixture",
      createdAt: "2026-10-08T12:00:00.000Z",
    }));
    storage.write(stored);
  } finally {
    storage.close();
  }
  coordinator = new MonitoringCoordinator(options);
  assert.throws(
    () => coordinator.addFindingRule({ findingId: update.id, mode: "snooze", days: 30 }),
    /At most 500/,
  );
  // A rule for a scope that already has one replaces it, so the cap never blocks changing a rule.
  coordinator.removeFindingRule("rule-0");
  const first = coordinator.addFindingRule({ findingId: update.id, mode: "snooze", days: 30 });
  const second = coordinator.addFindingRule({ findingId: update.id, mode: "snooze", days: 90 });
  const kept = coordinator.snapshot().findingRules;
  assert.equal(kept.length, 500);
  assert.deepEqual(
    kept.filter((rule) => rule.id === first.id || rule.id === second.id).map((rule) => rule.id),
    [second.id],
    "One rule per scope",
  );
});

test("an ignore reason is real text: control, zero-width and bidirectional characters are neither counted nor kept", () => {
  for (const reason of [
    "\u200b\u200b\u200b",
    "\u202e\u2066\u2069",
    "\u0007\u0007\u0007",
    "  \t\n  ",
    "ab\u200b\u200b",
  ])
    assert.throws(
      () => createRule({ findingId: "f", mode: "ignore", reason }, finding(), now, "x"),
      /at least 3 characters/,
      JSON.stringify(reason),
    );
  const rule = createRule(
    { findingId: "f", mode: "ignore", reason: "  Pinned\u200b for\u0007\tcompat \u202e" },
    finding(),
    now,
    "x",
  );
  assert.equal(rule.reason, "Pinned for compat");
});

test("a snooze with neither a date nor a version hides nothing and is expired, while an ignore needs neither", () => {
  const open = {
    id: "open",
    scope: ruleScope(finding()),
    mode: "snooze",
    createdAt: "2026-10-08T12:00:00.000Z",
  };
  assert.equal(hidden([open], finding()), null);
  assert.deepEqual([...expiredRuleIds([open], [finding()], new Set(["project"]), now)], ["open"]);
  assert.equal(
    hidden([{ ...open, id: "ignore", mode: "ignore", reason: "Pinned" }], finding()),
    "ignore",
  );
});

test("createRule re-checks the snooze length for a caller that bypasses the request schema", () => {
  for (const days of [0, 1, 8, -7, 1e9, Number.NaN, "7"])
    assert.throws(
      () => createRule({ findingId: "f", mode: "snooze", days }, finding(), now, "x"),
      /7, 30, or 90 days/,
      String(days),
    );
  assert.equal(
    createRule({ findingId: "f", mode: "snooze", days: 30 }, finding(), now, "x").mode,
    "snooze",
  );
});

test("paired PCs never receive the owner's quiet hours or digest time", async (t) => {
  const root = await temporary();
  const coordinator = new MonitoringCoordinator({ dataDir: join(root, "state"), lookup: false });
  t.after(() => coordinator.close());
  coordinator.changeSettings({
    paused: true,
    quietHours: { start: "22:13", end: "06:47" },
    digestAt: "17:41",
    notificationScope: "advisories",
  });
  const live = coordinator.snapshot();
  assert.deepEqual(
    live.settings.quietHours,
    { start: "22:13", end: "06:47" },
    "the owner's own snapshot keeps them",
  );
  for (const features of [
    undefined,
    "settings-repositories-connections-v9",
    "settings-repositories-connections-v10",
  ]) {
    const shared = sharedEvidence(live, features);
    assert.equal("quietHours" in shared.settings, false, String(features));
    assert.equal("digestAt" in shared.settings, false, String(features));
    assert.equal(shared.settings.paused, true, "everything else a receiving PC reads stays");
    assert.equal(shared.settings.notificationScope, "advisories");
    assert.equal(/22:13|06:47|17:41/.test(JSON.stringify(shared)), false, "no copy of the times");
  }
});
