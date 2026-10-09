import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { copilot } from "e2e/oauth/copilot";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Isolated test data directory so this coordinator never conflicts with production.
const testDataDir = resolve(".e2e/coordinator-data");

function readAccessToken(dataDir?: string): string {
  const env = dataDir ? { ...process.env, VERSIONSTEAD_DATA_DIR: dataDir } : { ...process.env };
  const out = execFileSync(process.execPath, ["apps/server/src/access.ts"], {
    encoding: "utf8",
    cwd: process.cwd(),
    env,
  });
  const token = out.trim().split("\n").at(-1)?.trim() ?? "";
  // access.ts prints the 43-char base64url token as the last line.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`Unexpected output: ${out.trim()}`);
  return token;
}

export default {
  agents: {
    default: {
      model: copilot("claude-sonnet-4.6"),
      system: "You are a thorough QA agent. Verify every outcome.",
    },
  },
  secrets: {
    // Lazily read the coordinator access token at fill time (the server is already up by then).
    // Tries the isolated test data dir first, then the default dir, then the env-var fallback for CI.
    accessToken: () => {
      for (const dir of [testDataDir, undefined]) {
        try {
          return readAccessToken(dir);
        } catch {
          // try next
        }
      }
      return process.env.VERSIONSTEAD_ACCESS_TOKEN ?? "";
    },
  },
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:4317",
        command:
          process.platform === "win32"
            ? {
                executable: "cmd",
                args: ["/c", "pnpm", "dev"],
                env: { VERSIONSTEAD_DATA_DIR: testDataDir },
                log: ".e2e/logs/app.log",
                reuseExisting: true,
              }
            : {
                executable: "pnpm",
                args: ["dev"],
                env: { VERSIONSTEAD_DATA_DIR: testDataDir },
                log: ".e2e/logs/app.log",
                reuseExisting: true,
              },
      },
    },
  ],
} satisfies E2EConfig;
