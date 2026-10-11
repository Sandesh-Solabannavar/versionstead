/**
 * Where the page stands with the evidence a paired PC last sent: it sent none, the page holds it,
 * it is being read, or reading it failed. Evidence the page holds from an earlier digest is
 * superseded unless this is "current".
 */
export function latestEvidence(
  computer: { id: string; snapshotDigest: string | null },
  held: ReadonlyMap<string, { digest: string }>,
  unreadable: ReadonlyMap<string, string>,
): "none" | "current" | "loading" | "failed" {
  if (computer.snapshotDigest === null) return "none";
  if (held.get(computer.id)?.digest === computer.snapshotDigest) return "current";
  return unreadable.get(computer.id) === computer.snapshotDigest ? "failed" : "loading";
}

/**
 * The paired PCs whose evidence the page has to fetch. The polled application read carries only the
 * digest of what each PC last sent, so a PC is fetched when its digest is one the page does not hold.
 * A digest whose read failed (`unreadable`) waits for Retry or newer evidence.
 */
export function staleEvidence<T extends { id: string; snapshotDigest: string | null }>(
  computers: readonly T[],
  held: ReadonlyMap<string, { digest: string }>,
  unreadable: ReadonlyMap<string, string>,
): (T & { snapshotDigest: string })[] {
  return computers.filter(
    (computer): computer is T & { snapshotDigest: string } =>
      latestEvidence(computer, held, unreadable) === "loading",
  );
}
