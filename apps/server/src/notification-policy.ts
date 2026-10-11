import type { Finding, MonitoringSettings } from "@versionstead/contracts/monitoring";

/**
 * Whether a finding may produce a notification: only updates and advisories, never one a snooze or
 * ignore rule hides, a watch-only project's only when the owner asked, and within "Notify about".
 * "High and critical" also takes an advisory without a rating: a missing rating is not evidence of
 * safety.
 */
export function notificationEligible(
  finding: Pick<Finding, "kind" | "severity">,
  settings: Pick<MonitoringSettings, "notificationScope" | "notifyWatchOnly">,
  projectMode: "maintained" | "watch" | null,
  suppressed: boolean,
): boolean {
  if ((finding.kind !== "update" && finding.kind !== "advisory") || suppressed) return false;
  if (projectMode === "watch" && settings.notifyWatchOnly !== true) return false;
  const scope = settings.notificationScope ?? "all";
  return (
    scope === "all" ||
    (finding.kind === "advisory" &&
      (scope === "advisories" ||
        finding.severity === "high" ||
        finding.severity === "critical" ||
        finding.severity === "unknown"))
  );
}

const minuteOfDay = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
};

/**
 * Whether `now` falls in a quiet-hours window, judged by the local wall clock: the start is inside, the
 * end is not, a window may cross midnight, and equal ends mean no window. Only the clock reading counts,
 * so a window over a repeated hour holds both times, and one over a skipped hour has no readings there.
 * Times are `HH:MM` that the settings schema has already checked.
 */
export function inQuietHours(
  quiet: { readonly start: string; readonly end: string } | null | undefined,
  now: Date,
): boolean {
  if (!quiet) return false;
  const start = minuteOfDay(quiet.start);
  const end = minuteOfDay(quiet.end);
  if (start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/**
 * The most recent local HH:MM at or before `now`: today's once it has passed, otherwise an earlier
 * day's. Days step by calendar date, not by 24 hours, so a daylight-saving change never moves the
 * wall-clock time. A time the clock skips is read with the offset from before the change (02:30 on the
 * night 02:00 jumps to 03:00 falls at 03:30), and a repeated time counts at its first occurrence, so
 * there is one per local day. `at` is `HH:MM` that the settings schema has already checked.
 */
export function latestDailyTime(at: string, now: Date): Date {
  const [hours, minutes] = at.split(":").map(Number) as [number, number];
  // A zone that skipped a whole day maps that day's time onto the next one, which can lie after `now`,
  // so keep stepping back until it does not. `!(a > b)` also ends the loop for an invalid time.
  for (let daysBack = 0; ; daysBack++) {
    const time = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysBack,
      hours,
      minutes,
    );
    if (!(time.getTime() > now.getTime())) return time;
  }
}
