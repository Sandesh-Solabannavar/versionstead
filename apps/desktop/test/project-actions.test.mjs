import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectActionRunner } from "../dist/project-actions.js";
async function fixture(t, timeout) {
  const root = await mkdtemp(join(tmpdir(), "versionstead-manual-action-"));
  const path = await realpath(root);
  const runner = new ProjectActionRunner(timeout);
  t.after(async () => {
    await runner.close();
    assert(root.startsWith(join(tmpdir(), "versionstead-manual-action-")));
    await rm(root, { recursive: true, force: true });
  });
  const project = {
    id: "local-project",
    name: "Local",
    path,
    actions: [
      {
        id: "test",
        name: "Test",
        icon: "test",
        shortcut: null,
        command:
          "'Versionstead λ'; (Get-Location).Path; Set-Content -LiteralPath result.txt -Value 'manual-only'; exit 7",
      },
    ],
  };
  return { runner, project, path };
}
async function waitRun(runner, id) {
  for (let i = 0; i < 200; i++) {
    const run = runner.read(id);
    if (run.status !== "running") return run;
    await delay(25);
  }
  throw new Error("Command did not finish");
}
test(
  "manual Windows actions run only saved local commands and retain output/exit codes",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { runner, project, path } = await fixture(t);
    await assert.rejects(readFile(join(path, "result.txt")), { code: "ENOENT" });
    await assert.rejects(runner.start({ ...project, repository: {} }, "test"), /local project/);
    await assert.rejects(runner.start(project, "missing"), /no longer exists/);
    const started = await runner.start(project, "test");
    const done = await waitRun(runner, started.id);
    assert.equal(done.status, "failed");
    assert.equal(done.exitCode, 7);
    assert.match(done.output, /Versionstead λ/);
    assert(done.output.includes(path));
    assert.equal((await readFile(join(path, "result.txt"), "utf8")).trim(), "manual-only");
    assert.equal(runner.latest(project.id, "test").id, done.id);
    assert.equal(done.command, project.actions[0].command);
  },
);
test(
  "Windows action stop, deadline, output bounds, removal and shutdown terminate tracked commands",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { runner, project } = await fixture(t, 700);
    project.actions[0].command = "Start-Sleep -Seconds 30";
    const first = await runner.start(project, "test");
    await assert.rejects(runner.start(project, "test"), /Stop the running/);
    const stopped = await runner.stop(first.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(runner.active, false);
    const timed = await runner.start(project, "test");
    assert.equal((await waitRun(runner, timed.id)).status, "stopped");
    assert.match(runner.read(timed.id).error, /runtime limit/);
    const removed = await runner.start(project, "test");
    await runner.reconcile([]);
    assert.equal(runner.read(removed.id).status, "stopped");
    const deletedAction = await runner.start(project, "test");
    await runner.reconcile([{ ...project, actions: [] }]);
    assert.equal(runner.read(deletedAction.id).status, "stopped");
    project.actions[0].command = "[Console]::Write('x' * 70000)";
    const large = await runner.start(project, "test");
    const limited = await waitRun(runner, large.id);
    assert(limited.output.length <= 65536);
    assert.match(limited.error, /64 KiB/);
    project.actions[0].command = "Start-Sleep -Seconds 30";
    const quitting = await runner.start(project, "test");
    await runner.close();
    assert.equal(runner.read(quitting.id).status, "stopped");
    assert.equal(runner.active, false);
    await assert.rejects(runner.start(project, "test"), /shutting down/);
  },
);
