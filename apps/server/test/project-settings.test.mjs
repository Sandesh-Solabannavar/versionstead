import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { startServer } from "../dist/server.js";
import { sharedEvidence } from "../dist/adapters/paired-computers.js";
import { validateProjectChanges } from "@versionstead/contracts/project-settings";
import { setTimeout as delay } from "node:timers/promises";

const action = {
  id: "inspect",
  name: "Inspect",
  command: "Set-Content -LiteralPath action-ran.txt -Value secret-do-not-share",
  icon: "terminal",
  shortcut: "mod+alt+i",
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "versionstead-project-settings-"));
  const path = join(root, "checkout");
  await mkdir(path);
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: { example: "^1.0.0" },
      scripts: { postinstall: action.command },
    }),
  );
  await writeFile(
    join(path, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { example: "^1.0.0" } },
        "node_modules/example": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        },
      },
    }),
  );
  let core = new MonitoringCoordinator({ dataDir: join(root, "state"), lookup: false });
  core.changeSettings({ paused: true });
  t.after(async () => {
    await core.close();
    assert(root.startsWith(join(tmpdir(), "versionstead-project-settings-")));
    await rm(root, { recursive: true, force: true });
  });
  const project = await core.addProject({ path, mode: "maintained" });
  return {
    root,
    path,
    project,
    get core() {
      return core;
    },
    restart: async () => {
      await core.close();
      core = new MonitoringCoordinator({ dataDir: join(root, "state"), lookup: false });
    },
  };
}
test("project metadata and actions persist without changing identity, executing scripts, or losing evidence", async (t) => {
  const f = await fixture(t);
  const lock = await readFile(join(f.path, "package-lock.json"));
  const changed = f.core.changeProject(f.project.id, {
    name: "  Health monitor  ",
    icon: { kind: "monogram", text: "HM", color: "blue" },
    actions: [action],
  });
  assert.equal(changed.name, "Health monitor");
  assert.equal(changed.id, f.project.id);
  assert.equal(changed.path, f.project.path);
  assert.equal(changed.createdAt, f.project.createdAt);
  f.core.requestScan({ target: "projects", projectId: f.project.id });
  for (let i = 0; i < 400 && f.core.snapshot().scanProgress.active; i++) await delay(10);
  const before = f.core.snapshot();
  assert.equal(before.projects[0].dependencies.length, 1);
  await assert.rejects(readFile(join(f.path, "action-ran.txt")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.path, "package-lock.json")), lock);
  await f.restart();
  assert.deepEqual(f.core.snapshot().projects, before.projects);
  assert.deepEqual(f.core.snapshot().history, before.history);
  f.core.changeProject(f.project.id, { name: "Renamed again", mode: "watch", icon: null });
  assert(
    f.core
      .snapshot()
      .findings.filter((x) => x.subjectId === f.project.id)
      .every((x) => x.subjectLabel === "Renamed again"),
  );
  assert.deepEqual(f.core.snapshot().projects[0].dependencies, before.projects[0].dependencies);
  assert.deepEqual(f.core.snapshot().history, before.history);
  f.core.removeProject(f.project.id);
  assert.equal(f.core.snapshot().projects.length, 0);
  assert.deepEqual(await readFile(join(f.path, "package-lock.json")), lock);
});
test("project changes reject invalid names, icons, actions and shortcuts and never share command text", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { name: " " },
    { name: "bad\nname" },
    { icon: { kind: "monogram", text: "LONG", color: "blue" } },
    { icon: { kind: "image", data: "data:text/html;base64,AAAA" } },
    { icon: { kind: "image", data: "data:image/png;base64,AAAA" } },
    { actions: [action, action] },
    { actions: [{ ...action, command: "\0" }] },
    { actions: [{ ...action, shortcut: "i" }] },
    {
      actions: Array.from({ length: 21 }, (_, i) => ({
        ...action,
        id: `a-${i}`,
        name: `Action ${i}`,
        shortcut: null,
      })),
    },
  ]) {
    assert.throws(() => validateProjectChanges(changes));
    assert.throws(() => f.core.changeProject(f.project.id, changes));
  }
  f.core.changeProject(f.project.id, { actions: [action], icon: { kind: "emoji", emoji: "🚀" } });
  const shared = sharedEvidence(f.core.snapshot());
  assert.deepEqual(shared.projects[0].actions, []);
  assert(!JSON.stringify(shared).includes("secret-do-not-share"));
  assert(!JSON.stringify(shared).includes(f.path));
  assert.deepEqual(shared.projects[0].icon, { kind: "emoji", emoji: "🚀" });
});
test("authenticated project updates accept partial settings and reject malformed or oversized commands", async (t) => {
  const f = await fixture(t);
  const token = "p".repeat(43);
  const server = await startServer({ port: 0, monitoring: f.core, authToken: token });
  t.after(() => server.close());
  const url = `${server.origin}/api/projects/${f.project.id}`;
  const patch = (body) =>
    fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"Unauthorized"}',
      })
    ).status,
    401,
  );
  const updated = await patch({ name: "HTTP name" });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, "HTTP name");
  assert.equal((await patch({ actions: [{ ...action, command: "a".repeat(4097) }] })).status, 400);
  assert.equal(f.core.snapshot().projects[0].name, "HTTP name");
  assert.equal(f.core.snapshot().projects[0].actions, undefined);
  assert.equal(
    (
      await fetch(`${server.origin}/api/projects/${f.project.id}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    404,
  );
});
