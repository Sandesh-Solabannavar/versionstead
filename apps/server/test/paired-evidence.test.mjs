import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Schema from "effect/Schema";
import {
  ActiveScan,
  Finding,
  MonitoringSnapshot,
  ScanProgress,
  ScanStage,
} from "@versionstead/contracts/monitoring";
import { features, MonitoringCoordinator } from "../dist/monitoring.js";
import {
  createPeerCertificate,
  peerRequest,
  sharedEvidence,
  startPeerServer,
} from "../dist/adapters/paired-computers.js";

const v10 = "settings-repositories-connections-v10";
// What a build before Wave 4 knew: a finding's fields and kinds, and the steps of a scan.
const legacyKeys = [
  "advisoryUrl",
  "availableVersion",
  "description",
  "detectedAt",
  "id",
  "installedVersion",
  "kind",
  "lastSeenAt",
  "name",
  "packageName",
  "severity",
  "source",
  "subjectId",
  "subjectLabel",
];
const legacyKinds = ["update", "advisory", "coverage"];
const legacyStages = [
  "inventory",
  "pc-updates",
  "project-inputs",
  "advisories",
  "advisory-details",
  "native-versions",
  "versions",
  "saving",
];
// The strict decoder of such a build (it refuses a value it does not know), from the contract's own fields.
const beforeWave4 = Schema.decodeUnknownSync(
  Schema.Struct({
    ...MonitoringSnapshot.fields,
    features: Schema.optional(
      Schema.Literals(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
          (version) => `settings-repositories-connections-v${version}`,
        ),
      ),
    ),
    findings: Schema.Array(
      Schema.Struct({
        ...Object.fromEntries(legacyKeys.map((key) => [key, Finding.fields[key]])),
        kind: Schema.Literals(legacyKinds),
      }),
    ),
    scanProgress: Schema.optional(
      Schema.Struct({
        ...ScanProgress.fields,
        active: Schema.NullOr(
          Schema.Struct({ ...ActiveScan.fields, stage: Schema.Literals(legacyStages) }),
        ),
      }),
    ),
  }),
);
const wire = (evidence) => JSON.parse(JSON.stringify(evidence));

// A snapshot as this build serves it, with every Wave 4 addition present at once.
async function wave4Snapshot() {
  const dataDir = await mkdtemp(join(tmpdir(), "versionstead-paired-evidence-"));
  const coordinator = new MonitoringCoordinator({ dataDir, lookup: false });
  let base;
  try {
    base = coordinator.snapshot();
  } finally {
    await coordinator.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  const finding = (kind, extra = {}) => ({
    id: kind,
    kind,
    subjectId: base.device.id,
    subjectLabel: base.device.label,
    name: "tsx",
    packageName: "tsx",
    installedVersion: "4.0.0",
    availableVersion: "4.1.0",
    severity: "info",
    source: "npm global",
    description: "A fixture finding.",
    advisoryUrl: null,
    detectedAt: "2026-10-08T00:00:00.000Z",
    lastSeenAt: "2026-10-08T00:00:00.000Z",
    ...extra,
  });
  return {
    ...base,
    findings: [
      finding("update", {
        installScript: true,
        candidateDeprecated: null,
        publishedAt: "2026-10-08T06:00:00.000Z",
        license: "MIT",
        provenance: true,
      }),
      finding("advisory", { severity: "high", advisoryUrl: "https://osv.dev/GHSA-0000" }),
      finding("coverage", { packageName: null, severity: "unknown" }),
      finding("lifecycle", {
        name: "Node.js 20",
        packageName: null,
        installedVersion: "20.11.1",
        availableVersion: null,
        severity: "high",
        source: "endoflife.date",
        effectiveDate: "2026-04-30",
      }),
      finding("other"),
    ],
    resolvedFindings: [
      { ...finding("update", { id: "resolved" }), resolvedAt: "2026-10-09T00:00:00.000Z" },
    ],
    scanProgress: {
      active: {
        scanId: "scan",
        targetId: base.device.id,
        targetLabel: base.device.label,
        kind: "pc",
        stage: "release-facts",
        completed: 1,
        total: 2,
        startedAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:01.000Z",
      },
      queued: [{ targetId: "queued-project", targetLabel: "Queued project", kind: "project" }],
    },
  };
}

test("a client that declares no marker of v10 or later receives only what a build before Wave 4 can read", async () => {
  const snapshot = await wave4Snapshot();
  const notMarkers = [
    undefined,
    "",
    "settings-repositories-connections-v9",
    "not-a-marker",
    "Settings-Repositories-Connections-V10",
    "settings-repositories-connections-v010",
    "settings-repositories-connections-v10000",
    `x${v10}`,
    `${v10}x`,
    `${v10} `,
    `${v10}, ${v10}`,
  ];
  for (const declared of notMarkers) {
    const shared = sharedEvidence(snapshot, declared);
    assert.deepEqual(
      shared.findings.map((f) => f.kind),
      legacyKinds,
      String(declared),
    );
    for (const f of shared.findings)
      assert.deepEqual(Object.keys(f).sort(), legacyKeys, `${f.kind} for ${declared}`);
    assert.equal("features" in shared, false);
    assert.deepEqual(
      shared.scanProgress,
      { active: null, queued: snapshot.scanProgress.queued },
      "Older clients still receive live progress; only the release-facts step they cannot read is left out",
    );
    const serialized = JSON.stringify(shared);
    for (const text of [
      "lifecycle",
      "connections-v10",
      "release-facts",
      "effectiveDate",
      "installScript",
      "candidateDeprecated",
      "publishedAt",
      "license",
      "provenance",
    ])
      assert.ok(!serialized.includes(text), `${text} for ${declared}`);
  }
  // Every step and kind the contract has now, not a list kept here: a client older than Wave 4 reads
  // the ones it knew, and anything added since must reach it as nothing, or fail here until
  // sharedEvidence and this fixture decide.
  for (const stage of ScanStage.literals) {
    const scanProgress = {
      ...snapshot.scanProgress,
      active: { ...snapshot.scanProgress.active, stage },
    };
    const shared = sharedEvidence({ ...snapshot, scanProgress });
    const known = legacyStages.includes(stage);
    assert.deepEqual(
      shared.scanProgress,
      known ? scanProgress : { ...scanProgress, active: null },
      known
        ? `Older clients keep live scan progress in the ${stage} step`
        : `Older clients read no active step for ${stage}`,
    );
    assert.doesNotThrow(
      () => beforeWave4(wire(shared)),
      `${stage}: a build before Wave 4 reads it`,
    );
  }
  for (const kind of Finding.fields.kind.to.literals) {
    const fixture = snapshot.findings.find((f) => f.kind === kind);
    assert.ok(fixture, `The fixture needs a ${kind} finding`);
    const shared = sharedEvidence({ ...snapshot, findings: [fixture] });
    assert.deepEqual(
      shared.findings.map((f) => f.kind),
      legacyKinds.includes(kind) ? [kind] : [],
      kind,
    );
    assert.doesNotThrow(() => beforeWave4(wire(shared)), `${kind}: a build before Wave 4 reads it`);
  }
  const { scanProgress: _unreported, ...withoutProgress } = snapshot;
  assert.equal(sharedEvidence(withoutProgress).scanProgress, undefined);
});

test("a client that declares v10 or later receives everything except the marker", async () => {
  const snapshot = await wave4Snapshot();
  for (const declared of [
    v10,
    features,
    "settings-repositories-connections-v11",
    "settings-repositories-connections-v9999",
  ]) {
    const shared = sharedEvidence(snapshot, declared);
    assert.deepEqual(shared.findings, snapshot.findings, declared);
    assert.deepEqual(shared.scanProgress, snapshot.scanProgress, declared);
    assert.equal(
      "features" in shared,
      false,
      "The marker is never shared, so a newer host cannot send a value that this client rejects",
    );
    assert.equal(
      "resolvedFindings" in shared,
      false,
      "The resolved history stays on this PC; no receiving PC reads it",
    );
  }
});

test("a build before Wave 4 refuses the full evidence and decodes the reduced evidence", async () => {
  const snapshot = await wave4Snapshot();
  // Either Wave 4 addition alone is enough for that build to refuse the evidence.
  const lifecycleKind = { ...snapshot, scanProgress: { active: null, queued: [] } };
  const releaseFactsStep = { ...snapshot, findings: snapshot.findings.slice(0, 3) };
  assert.throws(
    () => beforeWave4(wire(sharedEvidence(lifecycleKind, v10))),
    /\["findings"\]\[3\]\["kind"\]/,
  );
  assert.throws(
    () => beforeWave4(wire(sharedEvidence(releaseFactsStep, v10))),
    /\["active"\]\["stage"\]/,
  );
  const decoded = beforeWave4(wire(sharedEvidence(snapshot)));
  assert.deepEqual(
    decoded.findings.map((f) => f.kind),
    legacyKinds,
  );
  assert.equal(decoded.scanProgress.active, null);
  assert.deepEqual(decoded.scanProgress.queued, snapshot.scanProgress.queued);
});

test("the evidence endpoint reads the client's declared marker; an undeclared client gets the older shape", async (t) => {
  const snapshot = await wave4Snapshot();
  const certificate = await createPeerCertificate();
  const peer = await startPeerServer({
    address: "127.0.0.1",
    port: 0,
    certificate,
    snapshot: () => snapshot,
    pair: () => {
      throw new Error("unused");
    },
    authenticate: (token) => (token === "fixture-token" ? "fixture-client" : null),
    scan: () => {},
    revoke: () => {},
  });
  t.after(() => peer.close());
  const evidence = async (marker) =>
    (
      await peerRequest(`https://127.0.0.1:${peer.port}`, certificate.fingerprint, "/evidence", {
        token: "fixture-token",
        nonce: "n".repeat(43),
        ...(marker ? { features: marker } : {}),
      })
    ).snapshot;
  for (const declared of [undefined, "not-a-marker", `${v10}x`, "x".repeat(5000)]) {
    const older = await evidence(declared);
    assert.deepEqual(
      older.findings.map((f) => f.kind),
      legacyKinds,
      String(declared).slice(0, 40),
    );
    assert.deepEqual(
      older.scanProgress,
      { active: null, queued: snapshot.scanProgress.queued },
      "Through the endpoint an older client still receives live progress",
    );
    assert.doesNotThrow(() => beforeWave4(older));
  }
  const current = await evidence(features);
  assert.deepEqual(
    current.findings.map((f) => f.kind),
    ["update", "advisory", "coverage", "lifecycle", "other"],
  );
  assert.equal(current.findings[0].publishedAt, "2026-10-08T06:00:00.000Z");
  assert.equal(current.scanProgress.active.stage, "release-facts");
  assert.equal("features" in current, false);

  // The header's name on the wire, spelled out and sent without peerRequest: renaming the constant
  // that the client and the host share must fail here, not only change both sides at once.
  const raw = (headers) =>
    new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port: peer.port,
          path: "/evidence",
          agent: false,
          rejectUnauthorized: false,
          headers: {
            Authorization: "Bearer fixture-token",
            "X-Versionstead-Nonce": "n".repeat(43),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")).snapshot.findings),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
  assert.deepEqual(
    (await raw({ "X-Versionstead-Features": features })).map((f) => f.kind),
    ["update", "advisory", "coverage", "lifecycle", "other"],
  );
  assert.deepEqual(
    (await raw({})).map((f) => f.kind),
    legacyKinds,
  );
});
