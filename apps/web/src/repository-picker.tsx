import { useEffect, useState } from "react";
import { ArrowLeft, LockKeyhole, Search } from "lucide-react";
import {
  decodeRepositoryList,
  type ProviderKind,
  type Repository,
} from "@versionstead/contracts/application";
import { decodeProject, type Project } from "@versionstead/contracts/monitoring";
import { useApplication } from "./application";
import { useMonitoring, request } from "./monitoring";
import { actionKeys } from "./monitoring-actions";
import { repositoryMatches } from "./project-sources";
import { Choice } from "./components/settings-controls";
import { RefreshIcon } from "./components/ui/refresh-icon";
import { Badge, Button, Input, useFailure } from "./ui";

export function RepositorySelection({
  kind,
  onBack,
  onDone,
  onAdded,
  repositoryName,
}: {
  kind: ProviderKind;
  onBack: () => void;
  onDone: () => void;
  onAdded: (id: string) => void;
  repositoryName?: string;
}) {
  const { snapshot: app, refresh } = useApplication();
  const { mutate, connection } = useMonitoring();
  const [repositories, setRepositories] = useState<readonly Repository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addError, failAdd, clearAddError] = useFailure();
  const [query, setQuery] = useState(repositoryName ?? "");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<Project["mode"]>("maintained");
  const [generation, setGeneration] = useState(0);
  const name = kind === "github" ? "GitHub" : "GitLab";
  const provider = app?.providers.find((p) => p.kind === kind);
  const available = !!provider?.account && provider.enabled;
  useEffect(() => {
    const current = new AbortController();
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await request(`/api/application/repositories/${kind}`, decodeRepositoryList, {
          signal: AbortSignal.any([current.signal, AbortSignal.timeout(30000)]),
        });
        if (current.signal.aborted) return;
        setRepositories(rows);
        if (repositoryName && generation === 0) {
          const target = rows.find(
            (repo) => repo.name.toLowerCase() === repositoryName.toLowerCase(),
          );
          if (target) {
            setSelected({ [target.id]: target.defaultBranch });
            setConfirming(true);
          } else
            setError(
              "This repository was not found among the account's accessible repositories. Check its URL and token access.",
            );
        }
      } catch (failure) {
        if (!current.signal.aborted)
          setError(failure instanceof Error ? failure.message : "Repository discovery failed.");
      }
      if (!current.signal.aborted) {
        setLoading(false);
        void refresh();
      }
    };
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      current.abort();
    };
  }, [kind, repositoryName, refresh, generation]);
  const count = Object.keys(selected).length;
  const disabled = submitting || connection !== "connected" || !available;
  const add = async () => {
    setSubmitting(true);
    setError(null);
    clearAddError();
    try {
      for (const [repositoryId, ref] of Object.entries(selected)) {
        const project = await mutate(
          "/api/application/repositories",
          { kind, repositoryId, ref, mode },
          decodeProject,
          "Repository selected for monitoring.",
          "POST",
          {
            key: actionKeys.addProject,
            // The cause, then what it left behind; the dialog stays open on both.
            onError: (message) =>
              failAdd(
                `${message} Selection stopped. Completed repositories remain selected for monitoring; retry the remaining ones.`,
              ),
          },
        );
        if (!project) return;
        onAdded(project.id);
        setSelected((previous) => {
          const next = { ...previous };
          delete next[repositoryId];
          return next;
        });
      }
      await refresh();
      onDone();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className="repository-selection"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!submitting) {
            if (confirming) setConfirming(false);
            else onBack();
          }
        }
      }}
    >
      <div className="project-picker-toolbar">
        <Button
          variant="ghost"
          size="sm"
          disabled={submitting}
          onClick={() => {
            if (confirming) setConfirming(false);
            else onBack();
          }}
        >
          <ArrowLeft size={14} aria-hidden />
          {confirming ? "Repositories" : "Sources"}
        </Button>
        {!confirming && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Refresh ${name} repositories`}
            disabled={loading || submitting}
            onClick={() => {
              setGeneration((value) => value + 1);
            }}
          >
            <RefreshIcon refreshing={loading} size="sm" />
          </Button>
        )}
      </div>
      <p className="muted small">
        {confirming
          ? "Confirm the repositories and refs to monitor. Only this selection will be scanned."
          : `Choose from the repositories your connected ${name} account can read.`}
      </p>
      {!available && (
        <p className="error-text" role="alert">
          This provider is disconnected or paused. Enable it in Source Control before adding
          repositories.
        </p>
      )}
      {confirming ? (
        <>
          <div className="repository-list">
            {repositories
              ?.filter((repo) => repo.id in selected)
              .map((repo) => (
                <div className="repository-confirmation" key={repo.id}>
                  <div>
                    <strong>{repo.name}</strong>
                    <span className="table-subtext">
                      {repo.private ? "Private" : "Public"} · {name}
                    </span>
                  </div>
                  <label className="field-label">
                    Branch or ref
                    <Input
                      autoFocus={count === 1}
                      aria-label={`Branch or ref for ${repo.name}`}
                      value={selected[repo.id]}
                      maxLength={200}
                      disabled={submitting}
                      onChange={(event) =>
                        setSelected((previous) => ({ ...previous, [repo.id]: event.target.value }))
                      }
                    />
                  </label>
                </div>
              ))}
          </div>
          <label className="field-label">
            Maintenance intent
            <Choice
              label="Repository maintenance intent"
              value={mode}
              disabled={submitting}
              items={[
                { value: "maintained", label: "Maintained by me" },
                { value: "watch", label: "Watch only" },
              ]}
              onChange={(value) => setMode(value as Project["mode"])}
            />
          </label>
          <p className="muted small">
            {app?.preferences.automaticRepositoryScans
              ? "A read-only scan follows your automatic-scanning and scheduling preferences."
              : "Automatic repository scans are off. Scan manually from Projects."}{" "}
            Files are read through the provider; packages and repository scripts are never executed.
          </p>
        </>
      ) : (
        <>
          <div className="repository-search">
            <Search size={15} aria-hidden />
            <Input
              autoFocus
              type="search"
              aria-label="Search repositories"
              placeholder="Search repositories or paste a repository URL…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {loading && (
            <p className="muted small" role="status">
              Loading accessible repositories…
            </p>
          )}
          <div className="repository-list">
            {repositories
              ?.filter((repo) => repositoryMatches(repo, query))
              .map((repo) => (
                <label className="repository-choice" key={repo.id}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${repo.name}`}
                    checked={repo.id in selected}
                    disabled={disabled}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = { ...previous };
                        if (event.target.checked) next[repo.id] = repo.defaultBranch;
                        else delete next[repo.id];
                        return next;
                      })
                    }
                  />
                  <span className="repository-choice-name">
                    <strong>{repo.name}</strong>
                    <span className="table-subtext">Default: {repo.defaultBranch}</span>
                  </span>
                  {repo.private && <LockKeyhole size={14} aria-label="Private repository" />}
                </label>
              ))}
          </div>
          {!loading &&
            repositories !== null &&
            !repositories.some((repo) => repositoryMatches(repo, query)) && (
              <p className="muted">
                {repositories.length
                  ? "No matching repositories. Try another name or URL."
                  : "No readable repositories found for this account."}
              </p>
            )}
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {addError && (
        <p className="error-text" role="alert">
          {addError}
        </p>
      )}
      <div className="project-picker-footer">
        <span className="muted small">{count} selected</span>
        <Button
          variant="primary"
          disabled={disabled || count === 0}
          onClick={() => {
            if (confirming) void add();
            else setConfirming(true);
          }}
        >
          {submitting
            ? "Adding…"
            : confirming
              ? `Monitor ${count} ${count === 1 ? "repository" : "repositories"}`
              : "Continue"}
        </Button>
      </div>
      {confirming && <Badge>{name} · Read-only monitoring</Badge>}
    </div>
  );
}
