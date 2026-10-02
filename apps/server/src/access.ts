import { readRuntime, resolveDataDir } from "./runtime.ts";

const runtime = await readRuntime(resolveDataDir());
if (!runtime) {
  console.error("Start Versionstead before requesting a browser access code.");
  process.exitCode = 1;
} else {
  // This explicit owner command is the only place the local capability is printed.
  console.log(`Open ${runtime.origin} and enter this session access code:\n${runtime.token}`);
}
