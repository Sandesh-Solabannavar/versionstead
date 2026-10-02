import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { startServer } from "../dist/server.js";
import { decodeStatus } from "@versionstead/contracts/status";

test("live coordinator reports its environment without claiming scanner coverage", async () => {
  const server = await startServer({ port: 0 });
  try {
    const response = await fetch(`${server.origin}/api/status`);
    assert.equal(response.status, 200);
    const status = decodeStatus(await response.json());
    assert.equal(status.environment.platform, process.platform);
    assert.equal(status.capabilities.inventory, false);
    assert.equal(status.capabilities.vulnerabilities, false);
    assert.throws(() => decodeStatus({ ...status, protocolVersion: 2 }));
    assert.throws(() =>
      decodeStatus({ ...status, capabilities: { ...status.capabilities, inventory: true } }),
    );
    assert.equal((await fetch(`${server.origin}/api/status`, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(`${server.origin}/api/status`, { method: "POST" })).status, 405);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      get(
        `${server.origin}/api/status`,
        { headers: { Host: "attacker.invalid" } },
        (hostileResponse) => {
          hostileResponse.resume();
          resolve(hostileResponse.statusCode);
        },
      ).on("error", reject);
    });
    assert.equal(hostileHostStatus, 403);
  } finally {
    await server.close();
  }
});

test("static serving exposes built routes/assets, never arbitrary workspace paths", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "versionstead-test-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"), "<main>Versionstead</main>");
  await writeFile(join(webRoot, "assets", "app.js"), "export {};");
  await writeFile(join(webRoot, "secret.txt"), "not public");
  const server = await startServer({ port: 0, webRoot });
  try {
    assert.equal(
      await (await fetch(`${server.origin}/coverage`)).text(),
      "<main>Versionstead</main>",
    );
    assert.equal((await fetch(`${server.origin}/assets/app.js`)).status, 200);
    for (const path of [
      "/secret.txt",
      "/api/unknown",
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/missing.js",
    ]) {
      assert.equal((await fetch(`${server.origin}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${server.origin}/%zz`)).status, 400);
    assert.match(
      (await fetch(server.origin)).headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
  } finally {
    await server.close();
    assert.ok(webRoot.startsWith(join(tmpdir(), "versionstead-test-")));
    await rm(webRoot, { recursive: true, force: true });
  }
});
