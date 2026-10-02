import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";

const { values } = parseArgs({
  options: { port: { type: "string", default: "4318" }, help: { type: "boolean", short: "h" } },
});
if (values.help) {
  console.log(
    "Versionstead coordinator\nUsage: pnpm start [--port 4318]\nLocal access only. Remote enrollment is not implemented.",
  );
} else {
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  const server = await startServer({
    port,
    webRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  });
  console.log(`Versionstead coordinator: ${server.origin}`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void server.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
