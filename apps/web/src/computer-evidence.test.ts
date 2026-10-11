import assert from "node:assert/strict";
import test from "node:test";
import { latestEvidence, staleEvidence } from "./computer-evidence.ts";

const computer = (id: string, snapshotDigest: string | null) => ({ id, snapshotDigest });
const held = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, digest]) => [id, { digest }]));
const none = new Map<string, string>();

test("evidence is fetched for each PC whose latest digest the page does not hold", () => {
  const computers = [
    computer("a", "d1"),
    computer("b", "d2"),
    computer("c", null),
    computer("d", "d4"),
  ];
  const stale = (entries: Record<string, string>) =>
    staleEvidence(computers, held(entries), none).map(({ id }) => id);
  assert.deepEqual(stale({}), ["a", "b", "d"]);
  assert.deepEqual(stale({ a: "d1", b: "old" }), ["b", "d"]);
  assert.deepEqual(stale({ a: "d1", b: "d2", d: "d4" }), []);
  // A PC that has sent nothing has nothing to fetch, whatever the page holds for its id.
  assert.deepEqual(staleEvidence([computer("c", null)], held({ c: "d1" }), none), []);
  // A PC that is no longer connected is never fetched, and its held evidence is never read.
  assert.deepEqual(stale({ gone: "d9", a: "d1", b: "d2", d: "d4" }), []);
});

test("a failed read waits for Retry or newer evidence, and older evidence held meanwhile is superseded", () => {
  const pc = computer("a", "d2");
  const failed = new Map([["a", "d2"]]);
  assert.equal(latestEvidence(computer("a", null), held({}), none), "none");
  assert.equal(latestEvidence(pc, held({}), none), "loading");
  assert.equal(latestEvidence(pc, held({}), failed), "failed");
  assert.deepEqual(staleEvidence([pc], held({}), failed), [], "a failed read is not repeated");
  // Retry forgets the failure, so the read happens again.
  assert.deepEqual(staleEvidence([pc], held({}), none), [pc]);
  // Newer evidence is read although the previous read failed.
  assert.deepEqual(staleEvidence([computer("a", "d3")], held({}), failed), [computer("a", "d3")]);
  // Evidence from an earlier digest is not the latest while the latest loads or failed to load.
  assert.equal(latestEvidence(pc, held({ a: "d1" }), none), "loading");
  assert.equal(latestEvidence(pc, held({ a: "d1" }), failed), "failed");
  // Once the latest arrives (after a Retry), the earlier failure no longer counts.
  assert.equal(latestEvidence(pc, held({ a: "d2" }), failed), "current");
});
