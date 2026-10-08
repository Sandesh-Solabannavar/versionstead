import assert from "node:assert/strict";
import test from "node:test";
import {
  externalApplicationUrl,
  externalPackageUrl,
  externalRepositoryUrl,
} from "../dist/navigation.js";

test("package pages open only for valid package names on npmjs.com", () => {
  for (const url of [
    "https://www.npmjs.com/package/lodash",
    "https://www.npmjs.com/package/@types/node",
    "https://www.npmjs.com/package/JSONStream",
  ])
    assert.equal(externalPackageUrl(url), url);
  for (const url of [
    "http://www.npmjs.com/package/lodash",
    "https://npmjs.com/package/lodash",
    "https://www.npmjs.com.evil.example/package/lodash",
    "https://owner@www.npmjs.com/package/lodash",
    "https://www.npmjs.com:444/package/lodash",
    "https://www.npmjs.com/package/lodash?activeTab=versions",
    "https://www.npmjs.com/package/lodash#readme",
    "https://www.npmjs.com/package/lodash?",
    "https://www.npmjs.com/package/lodash/v/4.17.21",
    "https://www.npmjs.com/package/@scope",
    "https://www.npmjs.com/package/../settings",
    "https://www.npmjs.com/package/%2e%2e",
    "https://www.npmjs.com/package/a%2fb",
    "https://www.npmjs.com/package/",
    "https://www.npmjs.com/settings/profile",
    `https://www.npmjs.com/package/${"a".repeat(215)}`,
    "javascript:alert(1)",
    "file:///C:/Windows/notepad.exe",
    "invalid",
  ])
    assert.equal(externalPackageUrl(url), null, url);
});

test("repository pages open only for plain GitHub and GitLab repository URLs", () => {
  for (const url of [
    "https://github.com/Sandesh-Solabannavar/versionstead",
    "https://github.com/octo_org/repo.name",
    "https://gitlab.com/group/project",
    "https://gitlab.com/group/subgroup/deep/project",
    "https://github.com/a/b",
    "https://github.com/Owner-1/repo_name.v2",
    "https://gitlab.com/g1/s-2/p.3",
  ])
    assert.equal(externalRepositoryUrl(url), url);
  for (const url of [
    "http://github.com/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "https://www.github.com/owner/repo",
    "https://token@github.com/owner/repo",
    "https://github.com:444/owner/repo",
    "https://github.com/owner/repo?tab=readme",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner",
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/../settings",
    "https://github.com/owner/%2e%2e",
    "https://github.com/owner/re%70o",
    "https://gitlab.com/project",
    "https://gitlab.com/group/../admin",
    // Every segment starts with a letter or digit, so GitLab's /-/ routes and dot or underscore
    // pages are not repositories.
    "https://gitlab.com/group/project/-/issues",
    "https://gitlab.com/group/project/-/merge_requests/1",
    "https://gitlab.com/-/profile",
    "https://gitlab.com/group/-/project",
    "https://gitlab.com/group/.hidden/project",
    "https://gitlab.com/group/_internal/project",
    "https://github.com/-/profile",
    "https://github.com/owner/-repo",
    "https://github.com/owner/.github",
    "https://github.com/_owner/repo",
    "https://bitbucket.org/owner/repo",
    "javascript:alert(1)",
    "invalid",
  ])
    assert.equal(externalRepositoryUrl(url), null, url);
});

test("the window-open allowlist combines advisories, packages, repositories and the release page", () => {
  for (const url of [
    "https://osv.dev/vulnerability/GHSA-abcd-1234-wxyz",
    "https://www.npmjs.com/package/@types/node",
    "https://github.com/owner/repo",
    "https://gitlab.com/group/subgroup/project",
    "https://github.com/Sandesh-Solabannavar/versionstead/releases/tag/v0.2.0",
  ])
    assert.equal(externalApplicationUrl(url), url);
  for (const url of [
    "https://example.com/",
    "https://github.com/other/app/releases/tag/v0.2.0",
    "https://osv.dev/vulnerability/CVE-2026-1?next=elsewhere",
  ])
    assert.equal(externalApplicationUrl(url), null, url);
});
