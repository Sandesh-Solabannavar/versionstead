import assert from "node:assert/strict";
import test from "node:test";
import { versionCandidate } from "./versions.ts";

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
