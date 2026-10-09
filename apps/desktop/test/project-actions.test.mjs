import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectActionRunner, actionEnvironment, loginShell } from "../dist/project-actions.js";

async function fixture(t, timeout, grace) {
  const root = await mkdtemp(join(tmpdir(), "versionstead-manual-action-"));
  const path = await realpath(root);
  const runner = new ProjectActionRunner(timeout, grace);
  // The POSIX commands below are plain sh; never run them in an owner's fish or nu.
  const shell = process.env.SHELL;
  if (process.platform !== "win32") process.env.SHELL = "/bin/sh";
  t.after(async () => {
    await runner.close();
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
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
// Commands print a marker once they are ready; tests poll for it instead of sleeping and hoping.
async function until(check, what, limit = 5_000) {
  const end = performance.now() + limit;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}
const printed = (runner, id, pattern) => () => runner.read(id).output.match(pattern);
// A killed process still answers signal 0 until its parent reaps it, and a Node or pnpm that is PID 1
// in a container never does: the zombie state in /proc counts as gone. macOS has no /proc; launchd reaps.
const gone = (pid) => async () => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat.replace(/^.*\) /s, "")[0] === "Z";
};
const kill = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
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

test("the login shell is $SHELL only when /etc/shells lists it, never csh or a relative path", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "versionstead-shells-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shells = join(base, "shells");
  const zsh = join(base, "zsh");
  const tcsh = join(base, "tcsh");
  for (const file of [zsh, tcsh]) {
    await writeFile(file, "");
    await chmod(file, 0o755);
  }
  await writeFile(shells, `# /etc/shells\n/bin/sh\n${zsh}\n${tcsh}\n`);
  assert.equal(await loginShell({ SHELL: zsh }, shells), zsh);
  assert.equal(await loginShell({ SHELL: join(base, "unlisted") }, shells), "/bin/sh");
  assert.equal(await loginShell({ SHELL: "zsh" }, shells), "/bin/sh");
  assert.equal(await loginShell({ SHELL: tcsh }, shells), "/bin/sh");
  assert.equal(await loginShell({}, shells), "/bin/sh");
  assert.equal(await loginShell({ SHELL: zsh }, join(base, "missing")), "/bin/sh");
});

test("commands get the tool directories on PATH and never Node or Electron overrides", () => {
  const env = actionEnvironment(
    { PATH: "/custom/bin", NODE_OPTIONS: "--require x", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" },
    "darwin",
  );
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  const path = String(env.PATH).split(":");
  assert.equal(path[0], "/custom/bin");
  assert(path.includes("/usr/local/bin") && path.includes("/opt/homebrew/bin"));
  assert.equal(actionEnvironment({ Path: "C:\\x" }, "win32").Path, "C:\\x");
});

test(
  "manual POSIX actions run only saved local commands in a login shell and retain output/exit codes",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, project, path } = await fixture(t);
    project.actions[0].command =
      "printf 'Versionstead λ\\n'; pwd; printf manual-only > result.txt; exit 7";
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

// start() must run the owner's shell as a login shell and strip Node overrides from its environment.
const bash =
  process.platform !== "win32" && (await loginShell({ SHELL: "/bin/bash" })) === "/bin/bash";
test(
  "POSIX actions start the owner's shell as a login shell without Node overrides",
  { skip: !bash },
  async (t) => {
    const { runner, project, path } = await fixture(t);
    // The fixture restores SHELL. A scratch HOME keeps the owner's own profile out of the result.
    const saved = { HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS };
    t.after(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    process.env.SHELL = "/bin/bash";
    process.env.HOME = path;
    process.env.NODE_OPTIONS = "--no-warnings";
    project.actions[0].command =
      'shopt -q login_shell && echo login-shell; echo "shell=$0"; echo "node-options=${NODE_OPTIONS-unset}"';
    const done = await waitRun(runner, (await runner.start(project, "test")).id);
    assert.equal(done.status, "completed");
    assert.match(done.output, /^login-shell$/m);
    assert.match(done.output, /^shell=\/bin\/bash$/m);
    assert.match(done.output, /^node-options=unset$/m);
  },
);

test(
  "POSIX action stop, deadline, output bounds, removal and shutdown terminate the process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, project } = await fixture(t, 700, 200);
    project.actions[0].command = "sleep 30";
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
    project.actions[0].command = "yes | head -c 70000";
    const large = await runner.start(project, "test");
    const limited = await waitRun(runner, large.id);
    assert(limited.output.length <= 65536);
    assert.match(limited.error, /64 KiB/);
    project.actions[0].command = "sleep 30";
    const quitting = await runner.start(project, "test");
    await runner.close();
    assert.equal(runner.read(quitting.id).status, "stopped");
    assert.equal(runner.active, false);
    await assert.rejects(runner.start(project, "test"), /shutting down/);
  },
);

test(
  "POSIX Stop ends a background job too, by SIGTERM and by SIGKILL when the command ignores SIGTERM",
  { skip: process.platform === "win32", timeout: 20_000 },
  async (t) => {
    const { runner, project } = await fixture(t, 30_000, 200);
    const jobs = [];
    t.after(() => jobs.forEach((pid) => kill(pid)));
    for (const command of [
      "sleep 30 & echo $!; wait",
      // The job inherits the ignored SIGTERM, so only the SIGKILL after the grace period ends it.
      "trap '' TERM; sleep 30 & echo $!; wait",
    ]) {
      project.actions[0].command = command;
      const run = await runner.start(project, "test");
      const [, pid] = await until(printed(runner, run.id, /^(\d+)$/m), `the pid from ${command}`);
      jobs.push(Number(pid));
      assert.equal((await runner.stop(run.id)).status, "stopped");
      // A signal to the shell alone would leave the job running.
      await until(gone(Number(pid)), `the background job of "${command}" to end`);
    }
  },
);

test(
  "POSIX stop finishes when a command ignores SIGTERM or leaves a detached child holding its output",
  { skip: process.platform === "win32", timeout: 20_000 },
  async (t) => {
    const { runner, project } = await fixture(t, 30_000, 200);
    let detachedPid;
    t.after(() => detachedPid && kill(detachedPid));
    project.actions[0].command = "trap '' TERM; echo ready; sleep 30";
    const ignoring = await runner.start(project, "test");
    await until(printed(runner, ignoring.id, /^ready$/m), "the command to ignore SIGTERM");
    assert.equal((await runner.stop(ignoring.id)).status, "stopped");
    // A child in its own session keeps the output pipes open after the whole group is gone.
    project.actions[0].command = `"${process.execPath}" -e "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:['ignore','inherit','inherit']});console.log('detached='+c.pid);c.unref()"; sleep 30`;
    const detached = await runner.start(project, "test");
    const [, pid] = await until(
      printed(runner, detached.id, /^detached=(\d+)$/m),
      "its child's pid",
    );
    detachedPid = Number(pid);
    const stopping = performance.now();
    assert.equal((await runner.stop(detached.id)).status, "stopped");
    assert(
      performance.now() - stopping < 5_000,
      "Stop must not wait for a detached child holding the output pipes",
    );
  },
);
