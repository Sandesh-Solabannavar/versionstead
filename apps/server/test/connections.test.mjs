import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { MonitoringCoordinator } from "../dist/monitoring.js";
import { ApplicationService } from "../dist/application.js";
import { startServer } from "../dist/server.js";
import {
  createPeerCertificate,
  peerRequest,
  startPeerServer,
} from "../dist/adapters/paired-computers.js";
import {
  parseSshConfig,
  sshTunnelArguments,
  validateSshTarget,
  startSshTunnel,
} from "../dist/adapters/ssh-connections.js";
import {
  parsePairingInvitation,
  remotePairingFields,
  decodeApplicationSnapshot,
} from "@versionstead/contracts/application";

const encode = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
const identity = () => ({
  version: 1,
  origin: "https://100.64.1.2:4389",
  fingerprint: "a".repeat(64),
  deviceId: randomUUID(),
  label: "Studio · 电脑",
  code: randomBytes(32).toString("base64url"),
});
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "versionstead-connections-"));
  const core = new MonitoringCoordinator({ dataDir: path, lookup: false });
  core.changeSettings({ paused: true });
  const app = await ApplicationService.create(core);
  t.after(async () => {
    await app.close();
    await core.close();
    assert(path.startsWith(join(tmpdir(), "versionstead-connections-")));
    await rm(path, { recursive: true, force: true });
  });
  return { app, core };
}

test("pairing URL autofill and separate host/code preserve the original certificate and device identity", () => {
  const data = identity();
  const code = encode(data);
  const parsed = parsePairingInvitation(code);
  assert.deepEqual(parsed.identity, data);
  assert.equal(parsed.pairingCode, code);
  assert.equal(parsePairingInvitation(parsed.url).host, data.origin);
  assert.equal(remotePairingFields("100.64.1.2:4389", code), parsed.url);
  assert.throws(() => remotePairingFields("100.64.1.3:4389", code), /does not match/);
  assert.throws(
    () => parsePairingInvitation(`https://100.64.1.3:4389/#pair=${code}`),
    /valid Versionstead/,
  );
  for (const patch of [
    { fingerprint: "" },
    { code: "abc" },
    { deviceId: "1".repeat(36) },
    { origin: "https://public.example.com" },
    { label: "Unsafe\nlabel" },
    { version: 2 },
  ])
    assert.throws(() => parsePairingInvitation(encode({ ...data, ...patch })));
  for (const value of [
    "",
    "not a code",
    "a".repeat(4097),
    `${data.origin}/#token=${code}`,
    `${data.origin}/?pair=${code}`,
    `${data.origin}/path#pair=${code}`,
  ])
    assert.throws(() => parsePairingInvitation(value));
});

test("SSH parsing and tunnel arguments never evaluate config programs or execute a remote command", () => {
  const entries = parseSshConfig(
    'Host studio\n  HostName pc.example.com\n  User owner\n  Port 2222\n  IdentityFile "~/my key"\nHost *\n  ServerAliveInterval 99\n',
  );
  assert.equal(entries[1].values.hostname, "pc.example.com");
  const args = sshTunnelArguments({ host: "studio" }, identity().origin, 54321, entries[1].values);
  assert(args.includes("-N"));
  assert.deepEqual(args.slice(-3), ["-L", "127.0.0.1:54321:100.64.1.2:4389", "pc.example.com"]);
  assert(args.includes("StrictHostKeyChecking=yes"));
  assert(args.includes("BatchMode=yes"));
  assert(args.includes("ProxyCommand=none"));
  // `-F none` already leaves KnownHostsCommand unset, and OpenSSH before 8.5 rejects the option.
  assert(!args.some((arg) => /^KnownHostsCommand/i.test(arg)));
  assert.equal(args[args.indexOf("-F") + 1], "none");
  assert.equal(args[args.indexOf("-l") + 1], "owner");
  assert.equal(args[args.indexOf("-p") + 1], "2222");
  assert(!args.includes("-A"));
  for (const directive of [
    "Match exec test",
    "Include ~/.ssh/other",
    "ProxyCommand unsafe",
    "KnownHostsCommand unsafe",
    "LocalCommand unsafe",
    "PKCS11Provider unsafe",
    "IdentityAgent unsafe",
  ])
    assert.throws(() => parseSshConfig(directive), /not supported/);
  for (const target of [
    { host: "-oProxyCommand=unsafe" },
    { host: "pc;unsafe" },
    { host: "pc", username: "owner&unsafe" },
    { host: "pc", port: 0 },
    { host: "pc", port: 22.5 },
  ])
    assert.throws(() => validateSshTarget(target));
  assert.throws(() =>
    sshTunnelArguments({ host: "studio" }, identity().origin, 54321, { hostname: "-unsafe" }),
  );
  assert.throws(() =>
    sshTunnelArguments({ host: "studio" }, identity().origin, 54321, {
      identityfile: "relative-key",
    }),
  );
  for (const path of [
    "//server/secret",
    "\\\\server\\secret",
    '~/bad"key',
    "~/bad\tkey",
    "~/${KEY}",
  ])
    assert.throws(() =>
      sshTunnelArguments({ host: "studio" }, identity().origin, 54321, {
        identityfile: path,
      }),
    );
  const files = sshTunnelArguments({ host: "studio" }, identity().origin, 54321, {
    userknownhostsfile: "~/known hosts",
  });
  assert(files.some((arg) => /^UserKnownHostsFile=".+\/known hosts"$/.test(arg)));
});

test("an aborted SSH attempt creates no subprocess or forwarding listener", async () => {
  await assert.rejects(
    startSshTunnel({ host: "unused.invalid" }, identity().origin, AbortSignal.abort()),
    /abort/i,
  );
});

test(
  "real HTTPS pairing links persist enable switches and keep last evidence while disabled",
  { skip: process.platform !== "win32" },
  async (t) => {
    const host = await fixture(t);
    const client = await fixture(t);
    await host.app.changeSharing(true, "127.0.0.1", await freePort());
    const link = parsePairingInvitation(host.app.createInvitation().invitation).url;
    const state = await client.app.pairComputer(link);
    const computer = state.computers[0];
    assert.equal(computer.enabled, true);
    const evidence = client.app.computerSnapshot(computer.id).snapshot;
    assert.equal(evidence.device.id, host.core.snapshot().device.id);
    await client.app.changeComputer(computer.id, false);
    assert.equal(client.core.readApplication().computers[0].enabled, false);
    assert.deepEqual(client.app.computerSnapshot(computer.id).snapshot, evidence);
    await assert.rejects(client.app.scanComputer(computer.id), /Enable this environment/);
    await assert.rejects(client.app.refreshComputer(computer.id), /Enable this environment/);
    await host.app.changeSharing(false);
    await client.app.changeComputer(computer.id, true);
    assert.match(client.app.snapshot().computers[0].error, /retained/);
    assert.deepEqual(client.app.computerSnapshot(computer.id).snapshot, evidence);
    await client.app.changeComputer(computer.id, false);
    await client.app.close();
    const reopened = await ApplicationService.create(client.core);
    t.after(() => reopened.close());
    assert.equal(reopened.snapshot().computers[0].enabled, false);
    assert.deepEqual(reopened.computerSnapshot(computer.id).snapshot, evidence);
  },
);

test(
  "forwarded HTTPS preserves peer authority and validates the pin before credentials cross the tunnel",
  { skip: process.platform !== "win32" },
  async (t) => {
    const host = await fixture(t);
    await host.app.changeSharing(true, "127.0.0.1", await freePort());
    const invitation = parsePairingInvitation(host.app.createInvitation().invitation).identity;
    const sockets = new Set();
    const forward = createServer((socket) => {
      const upstream = connect({ host: "127.0.0.1", port: host.app.snapshot().sharing.port });
      for (const stream of [socket, upstream]) {
        sockets.add(stream);
        stream.on("close", () => sockets.delete(stream));
        stream.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise((resolve) => forward.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => forward.close(resolve));
    });
    const tunnelPort = forward.address().port;
    await assert.rejects(
      peerRequest(invitation.origin, "b".repeat(64), "/pair", {
        tunnelPort,
        body: { code: invitation.code, label: "Tunnel fixture", deviceId: randomUUID() },
      }),
      /verify its certificate/,
    );
    assert.equal(host.app.snapshot().sharing.clients.length, 0);
    const paired = await peerRequest(invitation.origin, invitation.fingerprint, "/pair", {
      tunnelPort,
      body: { code: invitation.code, label: "Tunnel fixture", deviceId: randomUUID() },
    });
    assert.equal(
      host.app.snapshot().sharing.clients.length,
      1,
      "A failed pin must not consume the one-time code",
    );
    const nonce = randomBytes(32).toString("base64url");
    const evidence = await peerRequest(invitation.origin, invitation.fingerprint, "/evidence", {
      tunnelPort,
      token: paired.token,
      nonce,
    });
    assert.equal(evidence.nonce, nonce);
    assert.equal(evidence.snapshot.device.id, host.core.snapshot().device.id);
  },
);

test(
  "a scan requested again within the peer's cooldown reads as recent, not as an unreachable or revoked PC",
  { skip: process.platform !== "win32" },
  async (t) => {
    const certificate = await createPeerCertificate();
    let scans = 0;
    const peer = await startPeerServer({
      address: "127.0.0.1",
      port: 0,
      certificate,
      snapshot: () => {
        throw new Error("unused");
      },
      pair: () => {
        throw new Error("unused");
      },
      authenticate: (token) => (token === "fixture-token" ? "fixture-client" : null),
      scan: () => {
        scans++;
      },
      revoke: () => {},
    });
    t.after(() => peer.close());
    const scan = () =>
      peerRequest(`https://127.0.0.1:${peer.port}`, certificate.fingerprint, "/scan", {
        token: "fixture-token",
        body: {},
      });
    assert.deepEqual(await scan(), { accepted: true });
    await assert.rejects(scan(), {
      message: "This PC was asked to scan recently. Try again in a minute.",
    });
    assert.equal(scans, 1, "The cooldown must not start a second scan");
    await assert.rejects(
      peerRequest(`https://127.0.0.1:${peer.port}`, certificate.fingerprint, "/scan", {
        token: "revoked-token",
        body: {},
      }),
      /rejected access or is unavailable/,
    );
  },
);

test("environment endpoints require local authentication and validate fields", async (t) => {
  const { app, core } = await fixture(t);
  const token = randomBytes(32).toString("base64url");
  const server = await startServer({
    monitoring: core,
    application: app,
    authToken: token,
    port: 0,
  });
  t.after(() => server.close());
  const call = (path, body, authenticated = true, method = "POST") =>
    fetch(server.origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await call("/api/application/ssh-hosts", undefined, false, "GET")).status, 401);
  assert.equal(
    (
      await call(
        "/api/application/computers/enabled",
        { id: randomUUID(), enabled: "yes" },
        true,
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/api/application/computers", {
        invitation: "invalid",
        ssh: { host: "pc", port: "22" },
      })
    ).status,
    400,
  );
  const state = decodeApplicationSnapshot(
    await (await call("/api/application", undefined, true, "GET")).json(),
  );
  assert.equal(state.localOrigin, server.origin);
});
