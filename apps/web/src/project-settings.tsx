import "./project-settings.css";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Info,
  Plus,
  Settings2,
  Trash2,
  Play,
  Terminal,
  FlaskConical,
  Hammer,
  Server,
  Package,
  RotateCcw,
} from "lucide-react";
import {
  decodeProject,
  decodeAcceptedResponse,
  type Project,
} from "@versionstead/contracts/monitoring";
import {
  projectIconNames,
  projectIconColors,
  validateProjectChanges,
  decodeActionRun,
  decodeActionShell,
  type ProjectIcon,
  type ProjectAction,
  type ActionRun,
} from "@versionstead/contracts/project-settings";
import { useMonitoring } from "./monitoring";
import { actionKeys } from "./monitoring-actions";
import { useApplication } from "./application";
import { useAppearance } from "./theme";
import { commandModifiers, formatShortcut, isMac, keyChord } from "./keybindings";
import { Button, Dialog, Input, EmptyState, hasOpenModal, useFailure } from "./ui";
import { cn } from "./lib/utils";
import { Choice, SettingGroup, SettingRow } from "./components/settings-controls";
import { ProjectBadge, projectIdentity, iconComponents, readProjectIcon } from "./project-icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./components/ui/menu";
import {
  commandRunnerNote,
  commandSyntaxNote,
  commandsNote,
  groupSettingsProjects,
  actionForChord,
  actionShortcutConflict,
  actionShortcutProblem,
  type ProjectSettingsMember as Member,
} from "./project-settings.logic";

const actionGlyphs = {
  play: Play,
  terminal: Terminal,
  test: FlaskConical,
  build: Hammer,
  server: Server,
  package: Package,
};

// The desktop app runs commands on every platform; a browser has no bridge.
const canRunCommands = () => Boolean(window.versionstead?.runProjectAction);

export function ProjectCommands({ project }: { project: Project }) {
  const [running, setRunning] = useState<ProjectAction | null>(null);
  const { bindings } = useAppearance();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        hasOpenModal() ||
        !canRunCommands() ||
        !(event.target instanceof HTMLElement) ||
        event.target.closest('input,textarea,select,[contenteditable="true"]') ||
        event.target.closest("[data-project-id]")?.getAttribute("data-project-id") !== project.id
      )
        return;
      const action = actionForChord(project.actions ?? [], keyChord(event, isMac()), bindings);
      if (action) {
        event.preventDefault();
        setRunning(action);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [project, bindings]);
  return (
    <>
      <Link
        className="text-link"
        to="/settings/project"
        search={{
          project: project.repository
            ? `${project.repository.provider}:${project.repository.repositoryId}`
            : `local:${project.id}`,
          environment: "local",
        }}
      >
        Project settings
      </Link>
      {!project.repository && !!project.actions?.length && (
        <>
          <Menu>
            <MenuTrigger render={<Button size="compact" />}>Actions</MenuTrigger>
            <MenuPopup>
              {project.actions.map((action) => (
                <MenuItem
                  key={action.id}
                  disabled={!canRunCommands()}
                  onClick={() => setRunning(action)}
                >
                  <Play size={13} />
                  {action.name}
                  {action.shortcut && <kbd>{formatShortcut(action.shortcut)}</kbd>}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          {!canRunCommands() && <span className="muted small">{commandsNote}</span>}
        </>
      )}
      {running && (
        <ProjectActionOutput project={project} action={running} close={() => setRunning(null)} />
      )}
    </>
  );
}

export function ProjectActionOutput({
  project,
  action,
  close,
}: {
  project: Project;
  action: ProjectAction;
  close: () => void;
}) {
  const [run, setRun] = useState<ActionRun | null>(null);
  const [pending, setPending] = useState(canRunCommands());
  const [error, setError] = useState<string | null>(null);
  const bridge = window.versionstead;
  const [shell, setShell] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void bridge
      ?.projectActionShell?.()
      .then((value) => {
        if (!cancelled) setShell(decodeActionShell(value));
      })
      .catch(() => {
        // The dialog then says "your login shell" without naming it.
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  useEffect(() => {
    let cancelled = false;
    void bridge
      ?.projectActionStatus?.({ projectId: project.id, actionId: action.id })
      .then((value) => {
        if (!cancelled && value) setRun(decodeActionRun(value));
      })
      .catch(() => {
        if (!cancelled) setError("The command status could not be read.");
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, project.id, action.id]);
  const runId = run?.id;
  const running = run?.status === "running";
  const runner = canRunCommands() ? commandRunnerNote(bridge?.platform, shell) : "";
  useEffect(() => {
    if (!runId || !running || !bridge) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void bridge
        .projectActionStatus?.(runId)
        .then((value) => {
          if (!cancelled) setRun(decodeActionRun(value));
        })
        .catch(() => {
          if (!cancelled)
            setError("Command status is unavailable. Reopen this dialog to reconnect.");
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bridge, runId, running]);
  const perform = async (stop: boolean) => {
    if (!bridge?.runProjectAction || !bridge.stopProjectAction) return;
    setPending(true);
    setError(null);
    try {
      const result =
        stop && run
          ? await bridge.stopProjectAction(run.id)
          : await bridge.runProjectAction(project.id, action.id, action.command);
      setRun(decodeActionRun(result));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The command could not run.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title={action.name}
      description={`Manual command in ${project.name}.${runner}`}
      className="project-output-dialog"
      onClose={close}
    >
      <code className="project-action-command">{action.command}</code>
      {run && run.command !== action.command && (
        <p className="muted small">
          The saved command changed since this output was collected. Run again uses the command
          shown above.
        </p>
      )}
      <p className="muted small">{project.path}</p>
      <p role="status">
        {run
          ? `${run.status}${run.exitCode !== null ? ` · Exit ${run.exitCode}` : ""}`
          : "Ready to run"}
      </p>
      {run && (
        <pre className="project-command-output" aria-label="Command output">
          {run.output || "Waiting for output…"}
        </pre>
      )}
      {(error || run?.error) && (
        <p role="alert" className="error-text">
          {error || run?.error}
        </p>
      )}
      <div className="row-actions">
        <Button onClick={close}>Close</Button>
        {running ? (
          <Button variant="danger" disabled={pending} onClick={() => void perform(true)}>
            Stop command
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={pending || !bridge?.runProjectAction}
            onClick={() => void perform(false)}
          >
            <Play size={14} />
            {pending ? "Starting…" : run ? "Run again" : "Run command"}
          </Button>
        )}
      </div>
      <p className="muted small">
        Commands run only when you launch them. Output stays in this desktop session. Stop, output
        limits, the ten-minute deadline, and Quit UI end tracked commands.
      </p>
    </Dialog>
  );
}

function IconPicker({
  project,
  save,
  close,
}: {
  project: Project;
  // Resolves to null once saved, else to why not.
  save: (icon: ProjectIcon) => Promise<string | null>;
  close: () => void;
}) {
  const existing = project.icon;
  const generated = projectIdentity(project.name);
  const [kind, setKind] = useState<"lucide" | "emoji" | "monogram">(
    existing && existing.kind !== "image" ? existing.kind : "lucide",
  );
  const [color, setColor] = useState(
    "color" in (existing ?? {})
      ? (existing as Extract<ProjectIcon, { color: string }>).color
      : generated.color,
  );
  const [name, setName] = useState<Extract<ProjectIcon, { kind: "lucide" }>["name"]>(
    existing?.kind === "lucide" ? existing.name : "folder",
  );
  const [letters, setLetters] = useState(
    existing?.kind === "monogram" ? existing.text : generated.monogram,
  );
  const [emoji, setEmoji] = useState(existing?.kind === "emoji" ? existing.emoji : "💻");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidate: ProjectIcon =
    kind === "lucide"
      ? { kind, name, color }
      : kind === "emoji"
        ? { kind, emoji }
        : { kind, text: letters.normalize("NFKC").trim().toUpperCase(), color };
  return (
    <Dialog
      title="Choose project icon"
      description="Choose an icon, emoji, or monogram."
      onClose={close}
      dismissible={!pending}
    >
      <div role="group" aria-label="Icon type" className="project-icon-types">
        {(["lucide", "emoji", "monogram"] as const).map((k) => (
          <Button
            key={k}
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setError(null);
            }}
          >
            {k === "lucide" ? "Icons" : k === "emoji" ? "Emoji" : "Monogram"}
          </Button>
        ))}
      </div>
      {kind !== "emoji" && (
        <div className="project-icon-colors" role="group" aria-label="Icon color">
          {projectIconColors.map((c) => (
            <button
              type="button"
              key={c}
              aria-label={c}
              aria-pressed={color === c}
              className={`project-color-swatch project-color-${c}`}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      )}
      {kind === "lucide" ? (
        <>
          <Input
            type="search"
            aria-label="Search project icons"
            placeholder="Search icons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="project-icon-grid">
            {projectIconNames
              .filter((n) => n.includes(query.toLowerCase()))
              .map((n) => {
                const Glyph = iconComponents[n];
                return (
                  <button
                    type="button"
                    key={n}
                    aria-label={n}
                    aria-pressed={name === n}
                    onClick={() => setName(n)}
                  >
                    <Glyph size={19} />
                    <span>{n.replaceAll("-", " ")}</span>
                  </button>
                );
              })}
          </div>
        </>
      ) : kind === "emoji" ? (
        <>
          <div className="project-emoji-grid">
            {["💻", "🚀", "📦", "🛠️", "🌐", "🧪", "🎮", "📚", "🧠", "🌱", "❤️", "⭐"].map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                aria-pressed={emoji === e}
                onClick={() => setEmoji(e)}
              >
                {e}
              </button>
            ))}
          </div>
          <Input
            aria-label="Custom emoji"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            maxLength={32}
          />
        </>
      ) : (
        <Input
          aria-label="Monogram"
          value={letters}
          onChange={(e) => setLetters(e.target.value)}
          maxLength={8}
          placeholder="One to three characters"
        />
      )}
      <div className="row-actions">
        <ProjectBadge project={{ name: project.name, icon: candidate }} />
        <span>{project.name}</span>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="row-actions">
        <Button disabled={pending} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => {
            void (async () => {
              try {
                validateProjectChanges({ icon: candidate });
                setPending(true);
                const failure = await save(candidate);
                if (failure === null) close();
                else setError(failure);
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : "Choose a valid icon.");
              } finally {
                setPending(false);
              }
            })();
          }}
        >
          {pending ? "Saving…" : "Use icon"}
        </Button>
      </div>
    </Dialog>
  );
}

function ActionEditor({
  project,
  action,
  save,
  close,
}: {
  project: Project;
  action: ProjectAction | null;
  // Resolves to null once saved, else to why not.
  save: (actions: readonly ProjectAction[]) => Promise<string | null>;
  close: () => void;
}) {
  const { bindings } = useAppearance();
  const [id] = useState(action?.id ?? crypto.randomUUID());
  const [name, setName] = useState(action?.name ?? "");
  const [command, setCommand] = useState(action?.command ?? "");
  const [icon, setIcon] = useState<ProjectAction["icon"]>(action?.icon ?? "play");
  const [shortcut, setShortcut] = useState(action?.shortcut ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const persist = async (remove: boolean) => {
    setError(null);
    try {
      const others = (project.actions ?? []).filter((a) => a.id !== id);
      const edited = {
        id,
        name: name.trim(),
        command: command.trim(),
        icon,
        shortcut: shortcut || null,
      };
      const next = remove
        ? others
        : action
          ? (project.actions ?? []).map((a) => (a.id === id ? edited : a))
          : [...others, edited];
      if (!remove) {
        const conflict = actionShortcutConflict(others, id, shortcut, bindings);
        if (conflict) throw new Error(conflict);
      }
      validateProjectChanges({ actions: next });
      setPending(true);
      const failure = await save(next);
      if (failure === null) close();
      else setError(`${failure} Your edits are still here.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check the action fields.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title={action ? "Edit Action" : "Add Action"}
      description="Project commands you launch manually, with optional shortcuts."
      onClose={close}
      dismissible={!pending}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void persist(false);
        }}
        className="project-action-form"
      >
        <label className="field-label">
          Name
          <Input
            value={name}
            maxLength={80}
            placeholder="Test"
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
          />
        </label>
        <Choice
          label="Action icon"
          value={icon}
          items={Object.keys(actionGlyphs).map((value) => ({ value, label: value }))}
          onChange={(value) => setIcon(value as ProjectAction["icon"])}
          disabled={pending}
        />
        <label className="field-label">
          Keybinding
          <Input
            aria-label="Action keybinding"
            aria-describedby="action-keybinding-help"
            readOnly
            value={formatShortcut(shortcut)}
            placeholder="Press shortcut"
            disabled={pending}
            onKeyDown={(e) => {
              // Tab and Escape keep their usual job, so the field never traps keyboard focus.
              if (e.key === "Tab" || e.key === "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Backspace" || e.key === "Delete") {
                setShortcut("");
                setError(null);
                return;
              }
              const chord = keyChord(e, isMac());
              if (chord) {
                const problem = actionShortcutProblem(project.actions ?? [], id, chord, bindings);
                setError(problem);
                if (!problem) setShortcut(chord);
              }
            }}
          />
        </label>
        <p id="action-keybinding-help" className="muted small">
          Shortcuts open the command panel for this project. Press {commandModifiers(isMac())} with
          a key. Backspace clears a shortcut; Tab and Escape leave the field.
        </p>
        <label className="field-label">
          Command
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            maxLength={4096}
            rows={4}
            placeholder="pnpm test"
            disabled={pending}
          />
        </label>
        <p className="muted small">{commandSyntaxNote(window.versionstead?.platform)}</p>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {deleting && <p role="alert">Delete this saved action? This cannot be undone.</p>}
        <div className="row-actions">
          {action && (
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => (deleting ? void persist(true) : setDeleting(true))}
            >
              {deleting ? "Confirm delete action" : "Delete"}
            </Button>
          )}
          <Button type="button" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || deleting}>
            {pending ? "Saving…" : action ? "Save changes" : "Save action"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ProjectDetail({ members }: { members: Member[] }) {
  const project = members[0]!.project;
  const { mutate, pending, connection } = useMonitoring();
  // Why the last change failed. If this page is gone when the answer arrives, a toast says it.
  const [error, fail, clearError] = useFailure();
  const [iconOpen, setIconOpen] = useState(false);
  const [editing, setEditing] = useState<{ action: ProjectAction | null } | null>(null);
  const [running, setRunning] = useState<ProjectAction | null>(null);
  const [removing, setRemoving] = useState(false);
  // Removal is a loop over the entries; the dialog is held for all of it, not entry by entry.
  const [deleting, setDeleting] = useState(false);
  const [removeError, failRemove, clearRemoveError] = useFailure(removing);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const remote = members.some((m) => m.environment !== "local");
  // Only this project's own removal holds its controls; saving already has its own state.
  const removalRunning = members.some((m) => pending.has(actionKeys.removeProject(m.project.id)));
  const disabled = remote || removalRunning || saving || connection !== "connected";
  // Where commands cannot run, Run says so instead of acting.
  const noRunner = !remote && !canRunCommands();
  const { bindings } = useAppearance();
  // Saves a change on every selected entry. It resolves to null once saved, else to why not: the
  // page shows that, and so does a dialog that asked, beside its own form.
  const change = async (body: unknown): Promise<string | null> => {
    const refuse = (message: string) => {
      fail(message);
      return message;
    };
    if (remote) return refuse("Edit this project on its own PC.");
    if (savingRef.current) return "Another change is still saving.";
    savingRef.current = true;
    setSaving(true);
    clearError();
    try {
      validateProjectChanges(body);
      for (const member of members) {
        const cause = { message: "" };
        const result = await mutate(
          `/api/projects/${encodeURIComponent(member.project.id)}`,
          body,
          decodeProject,
          "Project settings saved.",
          "PATCH",
          {
            onError: (message) => {
              cause.message = message;
            },
          },
        );
        if (!result)
          return refuse(
            `Could not save ${member.project.name} on ${member.label}${cause.message ? `: ${cause.message}` : "."}`,
          );
      }
      return null;
    } catch (failure) {
      return refuse(
        failure instanceof Error ? failure.message : "Project settings could not save.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    if (remote || project.repository || !canRunCommands()) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        hasOpenModal() ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      const action = actionForChord(project.actions ?? [], keyChord(event, isMac()), bindings);
      if (action) {
        event.preventDefault();
        setRunning(action);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [project, remote, bindings]);
  const chooseFile = async (file: File) => {
    try {
      const icon = await readProjectIcon(file);
      await change({ icon });
    } catch (failure) {
      fail(failure instanceof Error ? failure.message : "The icon file could not be read.");
    }
  };
  return (
    <>
      <div className="project-settings-hint" role="note">
        <Info size={16} />
        <span>
          {remote
            ? "Paired projects are read-only here. Choose This PC to edit local entries, or open Settings on the other PC."
            : "Changes apply to the selected project entries. Scans and project files keep their existing identity."}
        </span>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {/* The rows below are h3s, so they need a heading above them, though no title is shown. */}
      <h2 className="sr-only">Name and icon</h2>
      <div className="setting-group project-overview">
        <SettingRow
          label="Name"
          description="The shared name for these project entries in monitoring views."
        >
          <Input
            key={project.name}
            aria-label="Project name"
            defaultValue={project.name}
            maxLength={160}
            disabled={disabled}
            onBlur={(e) => {
              if (e.currentTarget.value !== project.name && !disabled)
                void change({ name: e.currentTarget.value });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") e.currentTarget.value = project.name;
            }}
          />
        </SettingRow>
        <SettingRow
          label="Project icon"
          description={
            project.icon?.kind === "lucide"
              ? `${project.icon.name} · ${project.icon.color}`
              : project.icon?.kind === "monogram"
                ? `${project.icon.text} · ${project.icon.color}`
                : project.icon?.kind === "emoji"
                  ? project.icon.emoji
                  : project.icon?.kind === "image"
                    ? "Custom image"
                    : "Automatic"
          }
        >
          <ProjectBadge project={project} />
          {project.icon && (
            <Button
              variant="ghost"
              aria-label="Reset project icon"
              disabled={disabled}
              onClick={() => void change({ icon: null })}
            >
              <RotateCcw size={14} />
            </Button>
          )}
          <Button disabled={disabled} onClick={() => setIconOpen(true)}>
            Choose icon
          </Button>
          <Button disabled={disabled} onClick={() => fileInput.current?.click()}>
            Choose file
          </Button>
          <input
            type="file"
            hidden
            ref={fileInput}
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void chooseFile(file);
            }}
          />
        </SettingRow>
      </div>
      <SettingGroup title="Actions">
        <SettingRow
          label="Actions"
          description="Commands that run in this project's local checkout, with optional shortcuts."
        >
          <Button
            size="compact"
            disabled={disabled || !!project.repository}
            onClick={() => setEditing({ action: null })}
          >
            <Plus size={14} />
            Add action
          </Button>
        </SettingRow>
        {project.repository ? (
          <p className="project-actions-empty muted">
            This repository is monitored through its provider. Add a local checkout to run custom
            commands.
          </p>
        ) : (project.actions ?? []).length === 0 ? (
          <p className="project-actions-empty muted">No actions configured.</p>
        ) : (
          (project.actions ?? []).map((action) => {
            const Glyph = actionGlyphs[action.icon];
            return (
              <SettingRow
                key={action.id}
                label={action.name}
                searchable={false}
                mark={<Glyph size={15} />}
                description={action.command}
              >
                {action.shortcut && <kbd>{formatShortcut(action.shortcut)}</kbd>}
                {/* Without the bridge Run stays focusable and names its reason; it never starts. */}
                <Button
                  size="compact"
                  disabled={disabled}
                  aria-disabled={noRunner || undefined}
                  aria-describedby={noRunner ? "project-commands-note" : undefined}
                  aria-label={`Run ${action.name}`}
                  onClick={() => {
                    if (!noRunner) setRunning(action);
                  }}
                >
                  <Play size={13} />
                  Run
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Edit ${action.name}`}
                  disabled={disabled}
                  onClick={() => setEditing({ action })}
                >
                  <Settings2 size={15} />
                </Button>
              </SettingRow>
            );
          })
        )}
        {noRunner && !project.repository && (
          <p id="project-commands-note" className="project-actions-empty muted small">
            {commandsNote} Saved actions can be edited here.
          </p>
        )}
      </SettingGroup>
      <SettingGroup title="Danger">
        <SettingRow
          label={members.length > 1 ? "Remove this project everywhere" : "Remove project"}
          description="Deletes selected project entries and current evidence. Files on disk are not touched."
        >
          <Button
            variant="danger"
            disabled={disabled}
            onClick={() => {
              clearRemoveError();
              setRemoving(true);
            }}
          >
            <Trash2 size={14} />
            {members.length > 1 ? "Remove all entries" : "Remove project"}
          </Button>
        </SettingRow>
      </SettingGroup>
      {iconOpen && (
        <IconPicker
          project={project}
          close={() => setIconOpen(false)}
          save={async (icon) => change({ icon })}
        />
      )}
      {editing && (
        <ActionEditor
          project={project}
          action={editing.action}
          close={() => setEditing(null)}
          save={async (actions) => change({ actions })}
        />
      )}
      {running && (
        <ProjectActionOutput project={project} action={running} close={() => setRunning(null)} />
      )}
      {removing && (
        <Dialog
          title="Remove project?"
          description={`Remove ${members.length === 1 ? project.name : `all ${members.length} selected entries`}, its current dependencies, findings, icon, and actions? Project files remain on disk. Historical scan records retain their observed labels.`}
          onClose={() => setRemoving(false)}
          dismissible={!deleting}
        >
          {removeError && (
            <p role="alert" className="error-text">
              {removeError}
            </p>
          )}
          <div className={cn("row-actions", removeError && "mt-3")}>
            <Button disabled={deleting} onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleting}
              onClick={() => {
                clearRemoveError();
                setDeleting(true);
                void (async () => {
                  try {
                    for (const member of members) {
                      const removed = await mutate(
                        `/api/projects/${encodeURIComponent(member.project.id)}`,
                        {},
                        decodeAcceptedResponse,
                        "Project removed.",
                        "DELETE",
                        { key: actionKeys.removeProject(member.project.id), onError: failRemove },
                      );
                      if (!removed) return;
                    }
                    setRemoving(false);
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}
            >
              Remove project
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function ProjectSettings() {
  const { snapshot } = useMonitoring();
  const { snapshot: app, computerEvidence } = useApplication();
  const search = useSearch({ from: "/settings/project" });
  const navigate = useNavigate();
  if (!snapshot || !app) return null;
  const environments = [
    { value: "all", label: "All environments" },
    { value: "local", label: "This PC" },
    ...app.computers.map((c) => ({ value: c.id, label: c.label })),
  ];
  const environment = environments.some((e) => e.value === search.environment)
    ? (search.environment ?? "all")
    : "all";
  const members: Member[] = [
    ...snapshot.projects.map((project) => ({
      environment: "local",
      label: snapshot.device.label,
      project,
    })),
    ...app.computers.flatMap((c) =>
      (computerEvidence.get(c.id)?.snapshot.projects ?? []).map((project) => ({
        environment: c.id,
        label: c.label,
        project,
      })),
    ),
  ].filter((m) => environment === "all" || m.environment === environment);
  const groups = groupSettingsProjects(members);
  const selected = groups.find((g) => g.key === search.project) || groups[0];
  const choose = (project: string | undefined, env: string) =>
    void navigate({
      to: "/settings/project",
      search: { ...(project === undefined ? {} : { project }), environment: env },
      replace: true,
    });
  return (
    <div className="project-settings">
      <div className="project-settings-scope">
        <span>Applying settings for</span>
        <Choice
          label="Settings project"
          value={selected?.key ?? ""}
          items={groups.map((g) => ({ value: g.key, label: g.name }))}
          onChange={(value) => choose(value, environment)}
          disabled={!selected}
        />
        <span>across</span>
        <Choice
          label="Project environment"
          value={environment}
          items={environments}
          onChange={(value) => choose(search.project, value)}
        />
      </div>
      {selected ? (
        <ProjectDetail key={`${selected.key}:${environment}`} members={selected.members} />
      ) : (
        <EmptyState title="No projects in this environment">
          Add a project from Projects to configure its name, icon, and actions here.
        </EmptyState>
      )}
    </div>
  );
}
