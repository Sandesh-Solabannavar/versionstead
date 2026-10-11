import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SshTarget } from "@versionstead/contracts/application";
import { toolExecutable } from "./development-tools.ts";
import { peerOrigin } from "./paired-computers.ts";
import { InputError } from "./projects.ts";
import { noAutoInstall } from "./tool-paths.ts";

const hostPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;
const userPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/;
export function validateSshTarget(target: SshTarget): SshTarget {
  if (
    !hostPattern.test(target.host) ||
    (target.username !== undefined && !userPattern.test(target.username)) ||
    (target.port !== undefined &&
      (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535))
  )
    throw new InputError(
      "Enter an SSH host or alias, a valid username, and a port from 1 to 65535.",
    );
  return target;
}

type HostEntry = { patterns: string[]; values: Record<string, string> };
/** Read data only. Never evaluate Match exec, Include, or executable SSH directives. */
export function parseSshConfig(text: string): HostEntry[] {
  if (Buffer.byteLength(text) > 64 * 1024)
    throw new InputError("SSH configuration exceeds 64 KiB.");
  const entries: HostEntry[] = [{ patterns: ["*"], values: Object.create(null) }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\w+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!match) throw new InputError("This SSH configuration syntax is unsupported.");
    const key = match[1]!.toLowerCase();
    if (
      [
        "match",
        "include",
        "proxycommand",
        "proxyjump",
        "localcommand",
        "knownhostscommand",
        "identityagent",
        "pkcs11provider",
        "securitykeyprovider",
      ].includes(key)
    )
      throw new InputError(
        "SSH Include, Match, proxy, and executable directives are not supported. Use a simple Host entry or Remote link.",
      );
    const value = match[2]!
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      const patterns = value.split(/\s+/);
      if (
        patterns.some((p) => !/^[a-zA-Z0-9*?][a-zA-Z0-9.*?_-]{0,252}$/.test(p)) ||
        entries.length >= 200
      )
        throw new InputError("Unsupported SSH host pattern or too many hosts.");
      entries.push({ patterns, values: Object.create(null) });
    } else if (
      ["hostname", "user", "port", "identityfile", "userknownhostsfile", "hostkeyalias"].includes(
        key,
      )
    ) {
      const current = entries.at(-1)!;
      current.values[key] ??= value;
    }
  }
  return entries;
}

async function readConfig() {
  let file;
  try {
    file = await open(join(homedir(), ".ssh", "config"), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseSshConfig("");
    throw new InputError("The monitoring host cannot read its SSH configuration.");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024)
      throw new InputError("Invalid or oversized SSH configuration.");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return parseSshConfig(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

function configuredHost(entries: HostEntry[], host: string) {
  const values: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    if (
      !entry.patterns.some((pattern) =>
        new RegExp(
          "^" +
            pattern
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replaceAll("*", ".*")
              .replaceAll("?", ".") +
            "$",
          "i",
        ).test(host),
      )
    )
      continue;
    for (const [key, value] of Object.entries(entry.values)) values[key] ??= value;
  }
  return values;
}

export async function discoverSshHosts() {
  if (!(await toolExecutable("ssh")))
    return {
      available: false,
      hosts: [],
      error: "OpenSSH is not installed on this monitoring host.",
    };
  try {
    const entries = await readConfig();
    const aliases = [...new Set(entries.flatMap((e) => e.patterns).filter((p) => !/[?*]/.test(p)))];
    const hosts = aliases.map((host) => {
      const values = configuredHost(entries, host);
      return validateSshTarget({
        host,
        ...(values.user ? { username: values.user } : {}),
        ...(values.port ? { port: Number(values.port) } : {}),
      });
    });
    return { available: true, hosts, error: null };
  } catch (error) {
    return {
      available: true,
      hosts: [],
      error: error instanceof InputError ? error.message : "SSH configuration could not be read.",
    };
  }
}

function sshFile(value: string) {
  const path =
    value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
  if (
    !isAbsolute(path) ||
    /[%"$]/.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    path.length > 1024
  )
    throw new InputError("SSH key and known-host files must use absolute local paths or ~/ paths.");
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

export function sshTunnelArguments(
  target: SshTarget,
  origin: string,
  localPort: number,
  values: Record<string, string> = {},
) {
  validateSshTarget(target);
  const remote = new URL(peerOrigin(origin));
  const hostname = values.hostname ?? target.host;
  const username = target.username ?? values.user;
  const port = target.port ?? (values.port ? Number(values.port) : 22);
  validateSshTarget({ host: hostname, ...(username ? { username } : {}), port });
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535)
    throw new InputError("Invalid local tunnel port.");
  const args = [
    "-F",
    "none",
    "-N",
    "-T",
    "-n",
    "-a",
    "-x",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-p",
    String(port),
  ];
  if (username) args.push("-l", username);
  if (values.identityfile) args.push("-i", sshFile(values.identityfile));
  if (values.userknownhostsfile)
    args.push("-o", `UserKnownHostsFile="${sshFile(values.userknownhostsfile)}"`);
  if (values.hostkeyalias) {
    if (!hostPattern.test(values.hostkeyalias)) throw new InputError("Invalid SSH host key alias.");
    args.push("-o", `HostKeyAlias=${values.hostkeyalias}`);
  }
  args.push("-L", `127.0.0.1:${localPort}:${remote.hostname}:${remote.port || "443"}`, hostname);
  return args;
}

export async function startSshTunnel(target: SshTarget, origin: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const executable = await toolExecutable("ssh");
  if (!executable)
    throw new InputError("Install OpenSSH on this monitoring host before using SSH.");
  const values = configuredHost(await readConfig(), target.host);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new InputError("No local SSH port is available.");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(executable, sshTunnelArguments(target, origin, port, values), {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    // Evidence polling restarts a dead tunnel, so ssh found as a shim must not install either.
    env: {
      ...process.env,
      ...noAutoInstall,
      NODE_OPTIONS: "",
      SSH_ASKPASS: undefined,
      SSH_ASKPASS_REQUIRE: "never",
      DISPLAY: undefined,
    },
  });
  let exited = false;
  let bytes = 0;
  const close = () => {
    if (!exited) child.kill();
  };
  const done = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      signal.removeEventListener("abort", close);
      resolve();
    });
  });
  child.once("error", () => {
    exited = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) close();
  });
  signal.addEventListener("abort", close, { once: true });
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      if (exited) break;
      signal.throwIfAborted();
      const ready = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const finish = (ok: boolean) => {
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(250, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });
      if (ready && !exited)
        return {
          port,
          alive: () => !exited,
          close: async () => {
            close();
            await done;
          },
        };
      await delay(100, undefined, { signal });
    }
    throw new InputError(
      "SSH could not connect. Verify the host in known_hosts and configure key or agent authentication in your terminal first.",
    );
  } catch (error) {
    close();
    await done;
    throw error;
  }
}
