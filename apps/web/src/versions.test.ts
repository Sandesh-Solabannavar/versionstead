import assert from "node:assert/strict";
import test from "node:test";
import { updateBadge, updateKind, versionAtLeast, versionCandidate } from "./versions.ts";

test("version lookup status distinguishes current evidence from missing or stale candidates", () => {
  const noCandidates = { availableVersion: null, latestVersion: null };
  assert.equal(
    versionCandidate({ ...noCandidates, versionStatus: "checked" }),
    "No newer release found",
  );
  assert.equal(versionCandidate({ ...noCandidates, versionStatus: "failed" }), "Lookup failed");
  assert.equal(versionCandidate({ ...noCandidates, versionStatus: "unsupported" }), "Not covered");
  assert.equal(versionCandidate({ ...noCandidates, versionStatus: "not-checked" }), "Not checked");
  assert.equal(versionCandidate(noCandidates), "Not checked");
  assert.equal(
    versionCandidate({
      availableVersion: "2.1.0",
      latestVersion: "3.0.0",
      versionStatus: "failed",
    }),
    "2.1.0 · previous, unverified",
  );
  assert.equal(
    versionCandidate({ availableVersion: "2.1.0", latestVersion: null }),
    "2.1.0 · unverified",
  );
  const majorOnly = {
    availableVersion: null,
    latestVersion: "3.0.0",
    versionStatus: "checked" as const,
  };
  assert.equal(versionCandidate(majorOnly), "Latest 3.0.0");
  assert.equal(versionCandidate(majorOnly, "compatible"), "No compatible update found");
  assert.equal(versionCandidate(majorOnly, "latest"), "3.0.0");
});

test("update kinds follow caret semantics, so 0.x minors and 0.0.x patches are major", () => {
  const cases: [string, string, ReturnType<typeof updateKind>][] = [
    ["1.2.3", "2.0.0", "major"],
    ["1.2.3", "5.9.9", "major"],
    ["1.2.3", "1.3.0", "minor"],
    ["1.2.3", "1.9.9", "minor"],
    ["1.2.3", "1.2.4", "patch"],
    ["0.2.3", "0.3.0", "major"],
    ["0.2.3", "0.2.4", "patch"],
    ["0.2.3", "1.0.0", "major"],
    ["0.0.3", "0.0.4", "major"],
    ["0.0.3", "0.1.0", "major"],
    ["1.2.3+build.5", "1.2.4", "patch"],
    // A prerelease target keeps the kind of its numeric jump; the badge adds the marker.
    ["1.2.3", "2.0.0-rc.1", "major"],
    ["1.2.3", "1.3.0-beta.1", "minor"],
    ["1.2.3", "1.2.4-beta.1", "patch"],
    ["0.2.3", "0.3.0-rc.1", "major"],
    ["1.0.0-rc.1", "2.0.0", "major"],
    ["1.0.0-rc.1", "1.1.0", "minor"],
    ["2.0.0-rc.1", "2.0.1", "patch"],
    // Only the prerelease tag differs: still a prerelease while the target is one, and the
    // stable release of the same version (inside the prerelease's caret range) is a patch.
    ["2.0.0-rc.1", "2.0.0-rc.2", "prerelease"],
    ["2.0.0-alpha.9", "2.0.0-alpha.10", "prerelease"],
    ["2.0.0-rc.1", "2.0.0", "patch"],
    ["0.0.3-rc.1", "0.0.3", "patch"],
    // Nothing newer is no kind of update.
    ["1.2.3", "1.2.3", null],
    ["1.2.3", "1.2.3+other", null],
    ["1.2.3", "1.2.2", null],
    ["2.0.0", "1.9.9", null],
    ["2.0.0", "2.0.0-rc.1", null],
    ["2.0.0-rc.2", "2.0.0-rc.1", null],
    // Only strict SemVer is classified.
    ["1.2", "1.2.4", null],
    ["1.2.3", "latest", null],
    ["v1.2.3", "1.2.4", null],
    ["1.2.3", "01.2.4", null],
    ["", "1.0.0", null],
    ["1.0.0", "99999999999999999999.0.0", null],
  ];
  for (const [installed, candidate, kind] of cases)
    assert.equal(updateKind(installed, candidate), kind, `${installed} -> ${candidate}`);
  assert.equal(updateKind(null, "1.0.0"), null);
  assert.equal(updateKind("1.0.0", null), null);
});

test("update badges label the kind and explain a 0.x major only when caret rules made it one", () => {
  assert.deepEqual(updateBadge("1.2.3", "2.0.0"), { label: "Major", tone: "warning" });
  assert.deepEqual(updateBadge("0.9.0", "1.0.0"), { label: "Major", tone: "warning" });
  assert.deepEqual(updateBadge("0.2.3", "0.3.0"), {
    label: "Major",
    tone: "warning",
    title: "0.x releases can include breaking changes",
  });
  assert.deepEqual(updateBadge("0.0.3", "0.0.4"), {
    label: "Major",
    tone: "warning",
    title: "0.x releases can include breaking changes",
  });
  assert.deepEqual(updateBadge("1.2.3", "1.3.0"), { label: "Minor", tone: "neutral" });
  assert.deepEqual(updateBadge("0.2.3", "0.2.4"), { label: "Patch", tone: "neutral" });
  // A prerelease target keeps its kind and says so; a stable target of a prerelease is not marked.
  assert.deepEqual(updateBadge("1.2.3", "2.0.0-rc.1"), {
    label: "Major",
    tone: "warning",
    prerelease: true,
  });
  assert.deepEqual(updateBadge("1.2.3", "1.2.4-beta.1"), {
    label: "Patch",
    tone: "neutral",
    prerelease: true,
  });
  assert.deepEqual(updateBadge("0.2.3", "0.3.0-rc.1"), {
    label: "Major",
    tone: "warning",
    title: "0.x releases can include breaking changes",
    prerelease: true,
  });
  assert.deepEqual(updateBadge("2.0.0-rc.1", "2.0.0-rc.2"), {
    label: "Prerelease",
    tone: "neutral",
  });
  assert.deepEqual(updateBadge("2.0.0-rc.1", "2.0.0"), { label: "Patch", tone: "neutral" });
  assert.equal(updateBadge("1.2.3", "1.2.3"), null);
  assert.equal(updateBadge("not-a-version", "1.2.3"), null);
  assert.equal(updateBadge(null, null), null);
});

test("version comparison is SemVer precedence and refuses anything that is not SemVer", () => {
  assert.equal(versionAtLeast("1.1.0", "1.1.0"), true);
  assert.equal(versionAtLeast("1.2.0", "1.1.9"), true);
  assert.equal(versionAtLeast("10.0.0", "9.9.9"), true);
  assert.equal(versionAtLeast("1.0.9", "1.1.0"), false);
  assert.equal(versionAtLeast("2.0.0-rc.1", "2.0.0"), false);
  assert.equal(versionAtLeast("2.0.0", "2.0.0-rc.1"), true);
  assert.equal(versionAtLeast("1.1.0+build", "1.1.0"), true);
  for (const [version, minimum] of [
    ["latest", "1.0.0"],
    ["1.0.0", "1.x"],
    ["", "1.0.0"],
    [null, "1.0.0"],
    ["1.0.0", null],
  ] as const)
    assert.equal(versionAtLeast(version, minimum), false, `${version} >= ${minimum}`);
});
