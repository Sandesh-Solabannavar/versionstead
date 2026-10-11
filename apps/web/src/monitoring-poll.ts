import type { MonitoringProgress, MonitoringSnapshot } from "@versionstead/contracts/monitoring";

/** The bare snapshot revision from an ETag header such as `"<revision>"`. */
export function etagRevision(header: string | null): string | null {
  return /^(?:W\/)?"([^"]*)"$/.exec(header ?? "")?.[1] ?? null;
}

/**
 * Headers for the full snapshot read a poll needs, or null when the snapshot matches the progress
 * revision. Explicit refreshes revalidate with the ETag; older coordinators without progress
 * (or an ETag) read unconditionally, as before revisions existed.
 */
export function snapshotRequest(
  current: { snapshot: MonitoringSnapshot | null; etag: string | null },
  progress: MonitoringProgress | null,
  forced: boolean,
): Record<string, string> | null {
  if (!current.snapshot || !progress || !current.etag) return {};
  if (!forced && progress.revision === current.etag) return null;
  return { "If-None-Match": `"${current.etag}"` };
}

/** The displayed snapshot; the revision excludes these live fields, so progress supplies them. */
export function withProgress(
  snapshot: MonitoringSnapshot | null,
  progress: MonitoringProgress | null,
): MonitoringSnapshot | null {
  return snapshot && progress
    ? {
        ...snapshot,
        scanProgress: progress.scanProgress,
        notificationSummary: progress.notificationSummary,
        notificationNextAt: progress.notificationNextAt,
      }
    : snapshot;
}
