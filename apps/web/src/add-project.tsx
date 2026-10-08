import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, FolderPlus, Link2, Search } from "lucide-react";
import type { ProviderKind } from "@versionstead/contracts/application";
import { decodeProject, type Project } from "@versionstead/contracts/monitoring";
import { useApplication } from "./application";
import { useMonitoring } from "./monitoring";
import { actionKeys } from "./monitoring-actions";
import { Button, Badge, Dialog, Input, useFailure } from "./ui";
import { Choice } from "./components/settings-controls";
import {
  GitHubIcon,
  GitLabIcon,
  AzureDevOpsIcon,
  BitbucketIcon,
  ForgejoIcon,
} from "./components/source-control-icons";
import { RepositorySelection } from "./repository-picker";
import { platformName } from "./keybindings";
import { folderPlaceholder, repositoryLocation } from "./project-sources";

const maintenanceItems = [
  { value: "maintained", label: "Maintained by me" },
  { value: "watch", label: "Watch only" },
];
type Source = "sources" | "local" | "url" | ProviderKind;
export function AddProjectDialog({
  close,
  added,
  initialSource,
}: {
  close: () => void;
  added: (id: string) => void;
  initialSource?: ProviderKind;
}) {
  const { snapshot: app } = useApplication();
  const { connection, pending } = useMonitoring();
  const navigate = useNavigate();
  // Adding a project, from a folder or a repository, is one action with one key.
  const adding = pending.has(actionKeys.addProject);
  const [source, setSource] = useState<Source>(initialSource ?? "sources");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [repositoryName, setRepositoryName] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const back = () => {
    setSource("sources");
    setRepositoryName(undefined);
    setError(null);
    setQuery("");
  };
  const setup = () => {
    close();
    void navigate({ to: "/settings/source-control" });
  };
  const disabled = connection !== "connected";
  const providers = (["github", "gitlab"] as const)
    .map((kind) => {
      const provider = app?.providers.find((p) => p.kind === kind);
      return {
        kind,
        name: kind === "github" ? "GitHub" : "GitLab",
        icon: kind === "github" ? <GitHubIcon /> : <GitLabIcon />,
        ready: !!provider?.account && provider.enabled && !provider.error,
      };
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready));
  const title =
    source === "local"
      ? "Select a project folder"
      : source === "github" || source === "gitlab"
        ? `Select ${source === "github" ? "GitHub" : "GitLab"} repositories`
        : source === "url"
          ? "Add from Git URL"
          : "Add project";
  return (
    // Closing mid-request would lose its error, so the dialog stays until the request settles.
    <Dialog title={title} onClose={close} dismissible={!adding}>
      {source === "sources" ? (
        <div className="project-source-picker">
          <div className="repository-search">
            <Search size={16} aria-hidden />
            <Input
              autoFocus
              aria-label="Search project sources"
              placeholder="Search project sources…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "Enter") {
                  const first = event.currentTarget
                    .closest(".project-source-picker")
                    ?.querySelector<HTMLButtonElement>(
                      ".project-source-option button:not(:disabled)",
                    );
                  if (first) {
                    event.preventDefault();
                    first.focus();
                    if (event.key === "Enter") first.click();
                  }
                }
              }}
            />
          </div>
          <p className="project-picker-group-label">Sources</p>
          <div
            className="project-source-list"
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              ];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault();
              items[
                (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
              ]?.focus();
            }}
          >
            {"local folder".includes(query.toLowerCase()) && (
              <div className="project-source-option">
                <Button variant="ghost" disabled={disabled} onClick={() => setSource("local")}>
                  <FolderPlus aria-hidden />
                  <span>
                    <strong>Local folder</strong>
                    <span className="table-subtext">Browse a folder on this PC</span>
                  </span>
                  <ChevronRight size={14} aria-hidden />
                </Button>
              </div>
            )}
            {"git url".includes(query.toLowerCase()) && (
              <div className="project-source-option">
                <Button variant="ghost" disabled={disabled} onClick={() => setSource("url")}>
                  <Link2 aria-hidden />
                  <span>
                    <strong>Git URL</strong>
                    <span className="table-subtext">Monitor a GitHub or GitLab repository URL</span>
                  </span>
                  <ChevronRight size={14} aria-hidden />
                </Button>
              </div>
            )}
            {providers
              .filter((p) => `${p.name} repository`.toLowerCase().includes(query.toLowerCase()))
              .map((provider) => (
                <div className="project-source-option" key={provider.kind}>
                  <Button
                    variant="ghost"
                    disabled={disabled || !provider.ready}
                    onClick={() => {
                      setSource(provider.kind);
                      setRepositoryName(undefined);
                    }}
                  >
                    {provider.icon}
                    <span>
                      <strong>{provider.name} repository</strong>
                      <span className="table-subtext">
                        {provider.ready
                          ? "Choose repositories from your connected account"
                          : "Connect and enable this provider in Source Control"}
                      </span>
                    </span>
                    {provider.ready && <ChevronRight size={14} aria-hidden />}
                  </Button>
                  {!provider.ready && (
                    <Button
                      size="sm"
                      aria-label={`Setup required for ${provider.name}`}
                      disabled={disabled}
                      onClick={setup}
                    >
                      Setup required
                    </Button>
                  )}
                </div>
              ))}
            {[
              { name: "Azure DevOps", icon: <AzureDevOpsIcon /> },
              { name: "Bitbucket", icon: <BitbucketIcon /> },
              { name: "Forgejo / Gitea", icon: <ForgejoIcon /> },
            ]
              .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
              .map((provider) => (
                <div className="project-source-option" key={provider.name}>
                  <Button variant="ghost" disabled>
                    {provider.icon}
                    <span>
                      <strong>{provider.name} repository</strong>
                      <span className="table-subtext">Repository monitoring is planned</span>
                    </span>
                  </Button>
                  <Badge tone="warning">Coming soon</Badge>
                </div>
              ))}
          </div>
          <div className="project-picker-footer">
            <span className="muted small">Choose a source before selecting a project.</span>
            <kbd>Esc to close</kbd>
          </div>
        </div>
      ) : source === "local" ? (
        <LocalProjectForm close={close} added={added} back={back} />
      ) : source === "url" ? (
        <form
          className="project-url-form"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = repositoryLocation(url);
            if (!parsed) {
              setError(
                "Enter a GitHub.com or GitLab.com repository URL, such as https://github.com/owner/repository.",
              );
              return;
            }
            if (!providers.find((p) => p.kind === parsed.kind)?.ready) {
              setError("Connect and enable this provider in Source Control first.");
              return;
            }
            setRepositoryName(parsed.name);
            setSource(parsed.kind);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              back();
            }
          }}
        >
          <Button variant="ghost" size="sm" onClick={back}>
            <ArrowLeft size={14} aria-hidden />
            Sources
          </Button>
          <label className="field-label">
            Repository URL
            <Input
              autoFocus
              aria-label="Repository URL"
              placeholder="https://github.com/owner/repository"
              value={url}
              maxLength={2048}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <p className="muted small">
            HTTPS and git@ SSH URLs identify the repository. Versionstead reads it through the
            connected provider and asks you to confirm its branch before monitoring.
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}{" "}
              <Button variant="ghost" size="sm" onClick={setup}>
                Source Control settings
              </Button>
            </p>
          )}
          <div className="form-actions">
            <Button variant="primary" type="submit" disabled={disabled || !url.trim()}>
              Continue
            </Button>
          </div>
        </form>
      ) : (
        <RepositorySelection
          key={`${source}:${repositoryName ?? ""}`}
          kind={source}
          onBack={back}
          onDone={close}
          onAdded={added}
          {...(repositoryName ? { repositoryName } : {})}
        />
      )}
    </Dialog>
  );
}

function LocalProjectForm({
  close,
  added,
  back,
}: {
  close: () => void;
  added: (id: string) => void;
  back: () => void;
}) {
  const { connection, pending, mutate } = useMonitoring();
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<Project["mode"]>("maintained");
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Why the last attempt failed. It belongs to this form, so it never outlives it or leaks elsewhere.
  const [error, fail, clearError] = useFailure();
  const adding = pending.has(actionKeys.addProject);
  return (
    <div
      className="local-project-form"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          // Going back mid-request would drop the form, and the message with it.
          if (!adding) back();
        }
      }}
    >
      <Button variant="ghost" size="sm" disabled={adding} onClick={back}>
        <ArrowLeft size={14} aria-hidden />
        Sources
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          clearError();
          void mutate(
            "/api/projects",
            { path: path.trim(), mode },
            decodeProject,
            "Project selected. A read-only scan is scheduled.",
            "POST",
            { key: actionKeys.addProject, onError: fail },
          ).then((project) => {
            if (project) {
              added(project.id);
              close();
            }
          });
        }}
      >
        <label className="field">
          <span>Local folder path</span>
          <Input
            autoFocus
            aria-label="Local folder path"
            required
            value={path}
            placeholder={folderPlaceholder(platformName())}
            onChange={(event) => setPath(event.target.value)}
            autoComplete="off"
          />
        </label>
        {window.versionstead && (
          <Button
            disabled={adding}
            onClick={() => {
              setPickerError(null);
              void window.versionstead
                ?.selectProjectDirectory()
                .then((selected) => {
                  if (selected) setPath(selected);
                })
                .catch(() =>
                  setPickerError(
                    "The folder picker could not be opened. Enter a local path instead.",
                  ),
                );
            }}
          >
            Browse folders…
          </Button>
        )}
        <label className="field">
          <span>Maintenance intent</span>
          <Choice
            label="Maintenance intent"
            value={mode}
            items={maintenanceItems}
            onChange={(value) => setMode(value as Project["mode"])}
          />
        </label>
        <p className="muted small">
          Only explicitly selected folders are inspected. Scans read manifests and supported
          lockfiles; they do not restore dependencies or execute project scripts.
        </p>
        {pickerError && (
          <p className="error-text" role="alert">
            {pickerError}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button onClick={close} disabled={adding}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!path.trim() || adding || connection !== "connected"}
          >
            {adding ? "Adding…" : "Add project"}
          </Button>
        </div>
      </form>
    </div>
  );
}
