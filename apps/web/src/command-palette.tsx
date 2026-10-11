import { useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  decodeAcceptedResponse,
  decodeMonitoringSettings,
} from "@versionstead/contracts/monitoring";
import { Input } from "./components/ui/input";
import { useMonitoring } from "./monitoring";
import { actionKeys } from "./monitoring-actions";
import {
  activeIndex,
  paletteItems,
  paletteKey,
  resultsNotice,
  type PaletteItem,
} from "./palette-items";
import { Dialog } from "./ui";

/**
 * Ctrl+K (⌘K): a combobox over one listbox of pages, settings, projects, packages, and actions. An
 * action that needs a dialog asks `open` for it after the palette has closed. Escape clears the
 * search, then closes it.
 */
export function CommandPalette({
  close,
  open,
}: {
  close: () => void;
  open: (dialog: "add-project" | "export") => void;
}) {
  const { snapshot, connection, mutate } = useMonitoring();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  // The option the owner moved to, by identity: a refresh can add or remove options before it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const items = useMemo(
    () => paletteItems(snapshot, deferredQuery, connection === "connected"),
    [snapshot, deferredQuery, connection],
  );
  const selected = activeIndex(items, activeId);
  // The list follows a deferred value, so for a moment it shows the previous query's options.
  const stale = query !== deferredQuery;
  useEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, selected]);
  const run = ({ action }: PaletteItem) => {
    close();
    // After the palette has closed and returned focus, so a dialog an action opens returns it there.
    window.setTimeout(() => {
      if (action.kind === "go") void navigate({ to: action.to, hash: action.hash ?? "" });
      else if (action.kind === "project")
        void navigate({
          to: "/projects",
          search: action.dependencyId
            ? { project: action.projectId, dependency: action.dependencyId }
            : { project: action.projectId },
        });
      else if (action.kind === "installation")
        void navigate({ to: "/pc", search: { item: action.installationId } });
      else if (action.kind === "scan")
        void mutate(
          "/api/scans",
          { target: action.target, ...(action.projectId ? { projectId: action.projectId } : {}) },
          decodeAcceptedResponse,
          // The same notice as the Retry failed checks button.
          action.target === "failed"
            ? "Retry requested. Targets that are already scanning or have recovered are skipped."
            : "Scan requested. Results will appear as collection finishes.",
          "POST",
          { key: actionKeys.scan(action.target, action.projectId) },
        );
      else if (action.kind === "cancel")
        void mutate(
          "/api/scans/cancel",
          { scanId: action.scanId },
          decodeAcceptedResponse,
          "Scan cancelled. The previous evidence is kept.",
          "POST",
          { key: actionKeys.cancelScan },
        );
      else if (action.kind === "pause")
        void mutate(
          "/api/settings",
          { paused: action.paused },
          decodeMonitoringSettings,
          action.paused ? "Scheduled scans paused." : "Scheduled scans resumed.",
          "PATCH",
          { key: actionKeys.setting("paused") },
        );
      else open(action.kind);
    });
  };
  return (
    <Dialog title="Command palette" onClose={close} className="command-palette">
      <div className="settings-search">
        <Search size={14} aria-hidden />
        <Input
          type="search"
          role="combobox"
          aria-label="Search or run a command: pages, settings, projects, packages, and actions"
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items.length ? `${listId}-${selected}` : undefined}
          placeholder="Search or run a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={(event) => {
            // keyCode 229 marks a composing key where isComposing arrives late (Safari).
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            // Chromium clears a search field on Escape by itself; clear it here too, as the settings
            // search does, so every browser reads the same. With nothing typed Escape closes the palette.
            if (event.key === "Escape" && query && !composing) {
              event.preventDefault();
              setQuery("");
              setActiveId(null);
              return;
            }
            const result = paletteKey(event.key, composing, selected, items.length, stale);
            if (!result) return;
            event.preventDefault();
            if ("choose" in result) run(items[result.choose]!);
            else setActiveId(items[result.active]!.id);
          }}
        />
      </div>
      {/* tabIndex -1: a scrolling list with no focusable options is otherwise a tab stop in Chromium. */}
      <div
        className="settings-search-results"
        id={listId}
        role="listbox"
        aria-label="Commands"
        tabIndex={-1}
      >
        {items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            id={`${listId}-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={index === selected}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
            <small>{item.detail}</small>
          </button>
        ))}
      </div>
      <p className={items.length ? "sr-only" : "muted small"} role="status">
        {resultsNotice(items.length)}
      </p>
    </Dialog>
  );
}
