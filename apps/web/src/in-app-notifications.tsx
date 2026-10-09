import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  decodeNotificationSummary,
  type NotificationSummary,
} from "@versionstead/contracts/monitoring";
import { useMonitoring } from "./monitoring";
import { useApplication } from "./application";
import { NotificationHistory } from "./notification-history";
import { toast } from "./components/ui/toast";

const historyKey = "versionstead.in-app-notifications";
function readHistory() {
  try {
    return new NotificationHistory(JSON.parse(localStorage.getItem(historyKey) ?? "[]"));
  } catch {
    return new NotificationHistory();
  }
}
// A lost connection is reported by its banner, and an unauthorized one by the access-code prompt, so
// neither gets a toast; a failed action is reported by `mutate` itself.
export function InAppNotifications() {
  const { snapshot, connection, notice } = useMonitoring();
  const { error: applicationError } = useApplication();
  const navigate = useNavigate();
  const history = useRef<NotificationHistory | null>(null);
  if (history.current === null) history.current = readHistory();
  useEffect(() => {
    if (notice) toast.add({ id: "action-feedback", title: notice, type: "success" });
  }, [notice]);
  useEffect(() => {
    if (applicationError)
      toast.add({
        id: "application-error",
        title: "Settings could not refresh",
        description: applicationError,
        type: "error",
        timeout: 8000,
      });
  }, [applicationError]);
  useEffect(() => {
    const show = (summary: NotificationSummary) => {
      if (snapshot?.settings.notifyNewFindings === false || !history.current!.remember(summary.id))
        return;
      toast.add({
        id: `summary-${summary.id}`,
        title: summary.title,
        description: summary.body,
        type: summary.newAdvisoryCount ? "warning" : "info",
        timeout: 12000,
        actionProps: {
          children: "Review",
          onClick: () => {
            toast.close(`summary-${summary.id}`);
            void navigate({ to: "/", search: { filter: summary.filter } });
          },
        },
      });
      try {
        localStorage.setItem(historyKey, JSON.stringify(history.current!.read()));
      } catch {
        /* Session deduplication still works. */
      }
    };
    if (connection === "connected" && snapshot?.notificationSummary)
      show(snapshot.notificationSummary);
    return window.versionstead?.onNotificationSummary?.((input) => {
      try {
        show(decodeNotificationSummary(input));
      } catch {
        /* Ignore invalid desktop messages. */
      }
    });
  }, [snapshot, connection, navigate]);
  return null;
}
