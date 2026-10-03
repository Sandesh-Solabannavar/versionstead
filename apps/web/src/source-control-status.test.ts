import assert from "node:assert/strict";
import test from "node:test";
import { providerPresentation } from "./source-control-status.ts";
import { redactedPlaceholder } from "./redacted-text.ts";
import { repositoryLocation, repositoryMatches } from "./project-sources.ts";

test("provider rows distinguish tool discovery, connected accounts, paused scans, and retained errors", () => {
  const provider = {
    kind: "github" as const,
    enabled: false,
    account: null,
    checkedAt: null,
    error: null,
  };
  const tool = { available: true, version: "gh version 2.92.0" };
  assert.equal(providerPresentation(provider, tool).badge, "Not authenticated");
  assert.match(providerPresentation(provider, tool).description, /signed-in gh CLI/);
  assert.match(
    providerPresentation(provider, { available: false, version: null }).description,
    /read-only token/,
  );
  assert.match(providerPresentation({ ...provider, kind: "gitlab" }, tool).description, /glab/);
  const connected = { ...provider, account: "example", enabled: true };
  assert.equal(
    providerPresentation(connected, { available: false, version: null }).status,
    "available",
  );
  assert.equal(providerPresentation({ ...connected, enabled: false }, tool).badge, "Paused");
  const failed = providerPresentation({ ...connected, error: "Token expired" }, tool);
  assert.equal(failed.status, "attention");
  assert.equal(failed.description, "Token expired");
  assert.equal(failed.badge, "Needs attention");
});

// The concealed DOM must contain a scrambled placeholder, never the account text.
test("account placeholders and pasted repository URLs preserve privacy and source identity", () => {
  const account = "fixture-owner.name@example.com";
  const hidden = redactedPlaceholder(account);
  assert.notEqual(hidden, account);
  assert.equal(hidden.length, account.length);
  assert.equal(hidden, redactedPlaceholder(account));
  for (let i = 0; i < account.length; i++)
    if ("@.-_".includes(account[i]!)) assert.equal(hidden[i], account[i]);
  assert.deepEqual(repositoryLocation("https://github.com/owner/repo.git"), {
    kind: "github",
    name: "owner/repo",
  });
  assert.deepEqual(repositoryLocation("git@gitlab.com:group/subgroup/repo.git"), {
    kind: "gitlab",
    name: "group/subgroup/repo",
  });
  assert.deepEqual(repositoryLocation("https://gitlab.com/group/subgroup/repo/"), {
    kind: "gitlab",
    name: "group/subgroup/repo",
  });
  for (const url of [
    "https://user:secret@github.com/owner/repo",
    "http://github.com/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "https://github.com/owner/repo/issues",
    "https://gitlab.com/group/repo?token=secret",
    "https://gitlab.com/group/repo#ref",
    "git@gitlab.com:group/../repo.git",
    "file:///D:/repo",
    "owner/repo",
  ])
    assert.equal(repositoryLocation(url), null, url);
  assert(
    repositoryMatches(
      {
        id: "1",
        name: "Owner/Repo",
        url: "https://github.com/Owner/Repo",
        defaultBranch: "main",
        private: true,
      },
      "https://github.com/owner/repo.git",
    ),
  );
});
