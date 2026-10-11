import assert from "node:assert/strict";
import test from "node:test";
import type { Dependency, Finding } from "@versionstead/contracts/monitoring";
import {
  candidateDeprecationText,
  installScriptText,
  licenseText,
  provenanceText,
  releaseAge,
  updateWarnings,
  youngDependencies,
} from "./release-signals.ts";

const now = Date.parse("2026-10-08T18:00:00.000Z");
// A day is written in the viewer's time zone, so the expected labels are too: these tests hold in any zone.
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const dayOf = (instant: string) => shortDate.format(Date.parse(instant));

test("install-script and candidate evidence read as added, deprecated, or not checked", () => {
  assert.equal(installScriptText(true), "Adds an install script");
  assert.equal(installScriptText(false), "No new install script");
  assert.equal(installScriptText(undefined), "Not checked");
  assert.equal(candidateDeprecationText(null), "Not deprecated");
  assert.equal(candidateDeprecationText(undefined), "Not checked");
  assert.equal(candidateDeprecationText("Use 2.0.1."), "Deprecated: Use 2.0.1.");
});

test("a missing license or provenance reads Unknown, never as a negative signal", () => {
  assert.equal(licenseText("MIT"), "MIT");
  assert.equal(licenseText(undefined), "Unknown");
  assert.equal(licenseText(""), "Unknown", "A blank license from another build is unknown too");
  assert.equal(provenanceText(true), "Provenance attested");
  assert.equal(provenanceText(undefined), "Unknown");
  assert.equal(provenanceText(false), "Unknown", "Not attested is not the same as unattested");
});

test("a release younger than the cooldown says when it is old enough, and an unknown age is never too new", () => {
  const until = dayOf("2026-10-11T12:00:00.000Z");
  assert.deepEqual(releaseAge("2026-10-08T12:00:00.000Z", 3, now), {
    kind: "too-new",
    label: `Released 6 hours ago — wait until ${until}`,
    untilLabel: until,
  });
  assert.equal(
    releaseAge("2026-10-05T18:00:00.000Z", 3, now),
    null,
    "Exactly the cooldown is old enough",
  );
  assert.equal(
    releaseAge("2026-10-05T18:00:00.001Z", 3, now)?.kind,
    "too-new",
    "A millisecond short of the cooldown is not",
  );
  assert.equal(releaseAge("2026-10-08T12:00:00.000Z", 0, now), null, "0 turns the cooldown off");
  assert.deepEqual(releaseAge(undefined, 3, now), {
    kind: "unknown",
    label: "Release age unknown",
  });
  assert.deepEqual(releaseAge("not a time", 3, now), {
    kind: "unknown",
    label: "Release age unknown",
  });
  assert.equal(releaseAge(undefined, 0, now), null, "With the cooldown off, age is not checked");
  assert.equal(
    releaseAge("2026-10-08T12:30:00.000Z", 1, Date.parse("2026-10-08T12:00:00.000Z"))?.label,
    `Released just now — wait until ${dayOf("2026-10-09T12:00:00.000Z")}`,
    "A publisher clock ahead of ours reads as just released",
  );
});

test("a release's age reads in whole units, and a publish time out of reach of our clock counts from now", () => {
  assert.equal(
    releaseAge("2026-10-06T19:00:00.000Z", 7, now)?.label,
    `Released 1 day ago — wait until ${dayOf("2026-10-13T19:00:00.000Z")}`,
    "47 hours is 1 day ago, never yesterday",
  );
  for (const published of ["2099-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"])
    assert.equal(
      releaseAge(published, 30, now)?.label,
      `Released just now — wait until ${dayOf("2026-11-07T18:00:00.000Z")}`,
      `${published}: the cooldown starts from our clock, and nothing throws`,
    );
});

test("the day a cooldown ends is written in the viewer's time zone as it is when asked", () => {
  // The cooldown ends at 12:00 UTC on October 11: the 12th in Kiritimati (UTC+14), the 11th in Pago Pago (UTC-11).
  // Deleting TZ would not bring the zone back (the runtime keeps the last one), so it is set to what it was.
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    for (const [tz, label] of [
      ["Pacific/Kiritimati", "Oct 12"],
      ["Pacific/Pago_Pago", "Oct 11"],
      ["Pacific/Kiritimati", "Oct 12"],
    ] as const) {
      process.env.TZ = tz;
      const age = releaseAge("2026-10-08T12:00:00.000Z", 3, now);
      assert.equal(age?.kind === "too-new" ? age.untilLabel : undefined, label, tz);
    }
  } finally {
    process.env.TZ = zone;
  }
});

test("Update now warns about an added install script, a release younger than the cooldown, and a deprecated candidate", () => {
  assert.deepEqual(
    updateWarnings(
      {
        installScript: true,
        publishedAt: "2026-10-08T12:00:00.000Z",
        candidateDeprecated: "Use 2.0.1.",
        availableVersion: "2.0.0",
      },
      3,
      now,
    ).map((warning) => warning.kind),
    ["install-script", "too-new", "deprecated-candidate"],
  );
  assert.equal(
    updateWarnings(
      { publishedAt: "2026-10-08T12:00:00.000Z", availableVersion: "2.0.0" },
      3,
      now,
    )[0]!.text,
    `Released 6 hours ago — wait until ${dayOf("2026-10-11T12:00:00.000Z")}.`,
  );
  assert.deepEqual(
    updateWarnings(
      {
        installScript: false,
        candidateDeprecated: null,
        publishedAt: "2026-09-01T00:00:00.000Z",
        availableVersion: "2.0.0",
      },
      3,
      now,
    ),
    [],
  );
  assert.deepEqual(
    updateWarnings({ availableVersion: "2.0.0" }, 3, now),
    [],
    "An unknown release age asks nothing",
  );
  assert.deepEqual(
    updateWarnings({ publishedAt: "not a time", availableVersion: "2.0.0" }, 3, now),
    [],
    "Neither does a release time that is not a time",
  );
  assert.deepEqual(
    updateWarnings({ publishedAt: "2026-10-08T17:59:00.000Z", availableVersion: "2.0.0" }, 0, now),
    [],
    "With the cooldown off, a new release asks nothing",
  );
  assert.deepEqual(updateWarnings(undefined, 3, now), []);
});

test("each warning stands alone, and a publisher's markup stays text", () => {
  assert.deepEqual(
    updateWarnings({ installScript: true, availableVersion: "2.0.0" }, 3, now).map(
      (warning) => warning.kind,
    ),
    ["install-script"],
  );
  assert.deepEqual(
    updateWarnings(
      {
        installScript: false,
        candidateDeprecated: "<b>Broken</b> & <script>alert(1)</script>",
        availableVersion: "2.0.0",
      },
      3,
      now,
    ),
    [
      {
        kind: "deprecated-candidate",
        text: "Version 2.0.0 is deprecated by its publisher: <b>Broken</b> & <script>alert(1)</script>",
      },
    ],
    "The message is carried verbatim as a string for a text node; nothing here interprets it",
  );
  assert.deepEqual(updateWarnings({ installScript: true, availableVersion: "2.0.0" }, 3, now), [
    {
      kind: "install-script",
      text: "This update adds an install script, which runs during installation.",
    },
  ]);
});

test("a bulk command holds back the release an update finding describes, only while it is inside the cooldown", () => {
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
  const young = "2026-10-08T12:00:00.000Z";
  const fresh = dep("fresh");
  const settled = dep("settled");
  const unknown = dep("unknown");
  const stale = dep("stale");
  const advisory = dep("advisory");
  const onlyLatest = dep("only-latest", { availableVersion: null, latestVersion: "2.0.0" });
  const findings = [
    update(fresh, { publishedAt: young }),
    update(settled),
    update(unknown, { publishedAt: undefined }),
    // A finding for another candidate than the dependency has now says nothing about this one.
    update(stale, { publishedAt: young, availableVersion: "1.0.5" }),
    update(advisory, { publishedAt: young, kind: "advisory" }),
    update(onlyLatest, { publishedAt: young }),
  ];
  const project = { dependencies: [fresh, settled, unknown, stale, advisory, onlyLatest] };
  assert.deepEqual(
    [...youngDependencies(project, findings, 3, now)],
    [
      ["hash-fresh", "1.1.0"],
      ["hash-only-latest", "2.0.0"],
    ],
    "Each is held by dependency id, with the release whose age is known",
  );
  assert.deepEqual([...youngDependencies(project, findings, 0, now)], [], "Off holds nothing back");
  assert.deepEqual([...youngDependencies(project, [], 3, now)], [], "No finding, no known age");
});
