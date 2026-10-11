import assert from "node:assert/strict";
import test, { after } from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The coordinator module resolves its data directory on import; never touch the owner's monitoring.
const data = await mkdtemp(join(tmpdir(), "versionstead-node-data-"));
process.env.VERSIONSTEAD_DATA_DIR = join(data, "coordinator");
const { nodeExecutable } = await import("../dist/coordinator.js");
after(() => rm(data, { recursive: true, force: true }));

const windows = process.platform === "win32";
async function withEnvironment(changes, action) {
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
async function scripts(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "versionstead-node-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "shims"));
  return base;
}
async function executableFile(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test("the desktop starts the coordinator with a Node 24 that it verified by running it", async () => {
  assert.equal(
    await withEnvironment({ VERSIONSTEAD_NODE_EXECUTABLE: process.execPath }, nodeExecutable),
    process.execPath,
  );
  await assert.rejects(
    withEnvironment({ VERSIONSTEAD_NODE_EXECUTABLE: "relative/node" }, nodeExecutable),
    /must be absolute/,
  );
  await assert.rejects(
    withEnvironment(
      { VERSIONSTEAD_NODE_EXECUTABLE: join(tmpdir(), "versionstead-no-such-node") },
      nodeExecutable,
    ),
    /Node\.js 24/,
  );
});

test(
  "a version-manager shim is run by its own name and the real Node behind it is what starts",
  { skip: windows },
  async (t) => {
    const base = await scripts(t);
    // Dispatches on the name it was invoked by, like Volta, mise and snap; its real name does nothing.
    const program = join(base, "multi-call");
    await executableFile(
      program,
      `#!/bin/sh
case "$(basename "$0")" in
  node) exec "${process.execPath}" "$@" ;;
  *) echo "dispatched on $0" >&2; exit 1 ;;
esac
`,
    );
    await symlink(program, join(base, "shims", "node"));
    const shim = join(base, "shims", "node");
    assert.equal(
      await withEnvironment({ VERSIONSTEAD_NODE_EXECUTABLE: shim }, nodeExecutable),
      process.execPath,
    );
    // The same shim found through PATH, the way a version manager is normally installed.
    assert.equal(
      await withEnvironment(
        {
          VERSIONSTEAD_NODE_EXECUTABLE: undefined,
          PATH: `${join(base, "shims")}${delimiter}${process.env.PATH}`,
        },
        nodeExecutable,
      ),
      process.execPath,
    );
  },
);

test("a working Node that is not version 24 is not started", { skip: windows }, async (t) => {
  const base = await scripts(t);
  const stub = join(base, "shims", "node-22");
  const reply = JSON.stringify({ version: "22.12.0", execPath: join(base, "node-22") });
  await executableFile(stub, `#!/bin/sh\nprintf '%s' '${reply}'\n`);
  await assert.rejects(
    withEnvironment({ VERSIONSTEAD_NODE_EXECUTABLE: stub }, nodeExecutable),
    /Node\.js 24/,
  );
});
