import assert from "node:assert/strict";
import test from "node:test";
import { searchSettings, settingTargetId, workspaceHref } from "./settings-navigation.ts";

test("settings search finds actual controls across sections, ignores case, and matches every word", () => {
  assert.deepEqual(searchSettings("  "), []);
  assert.equal(searchSettings("CONTRAST")[0]?.target, "setting-contrast");
  assert.equal(searchSettings("appearance font").length, 2);
  assert.deepEqual(searchSettings("connections scan"), []);
  assert.equal(
    searchSettings("source control automatically")[0]?.target,
    "setting-automatically-scan",
  );
  assert.equal(searchSettings("local environment")[0]?.path, "/settings/connections");
  assert.equal(searchSettings("github")[0]?.path, "/settings/source-control");
  assert.equal(searchSettings("ssh")[0]?.path, "/settings/connections");
  assert.equal(searchSettings("shortcuts")[0]?.path, "/settings/keybindings");
  assert.equal(settingTargetId("Glass opacity"), "setting-glass-opacity");
});

test("Back keeps the last workspace filter and remote PC while rejecting utility and external URLs", () => {
  for (const href of [
    "/",
    "/pc",
    "/projects",
    "/service",
    "/?status=updates#findings",
    "/computers/pc-123",
  ])
    assert.equal(workspaceHref(href), href);
  for (const href of [
    "/settings/general",
    "/unknown",
    "//example.com/pc",
    "https://example.com/pc",
    "/\\example.com/pc",
    "/computers/",
    "/computers/pc/extra",
  ])
    assert.equal(workspaceHref(href), null);
});
