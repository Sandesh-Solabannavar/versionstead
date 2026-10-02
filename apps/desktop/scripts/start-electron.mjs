delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = await import("node:child_process");
const { default: electron } = await import("electron");
const child = spawn(electron, process.argv.slice(2), { stdio: "inherit", windowsHide: false });
child.once("error", () => {
  console.error("Electron could not start. Run install-electron and retry.");
  process.exit(1);
});
// Windows descendants can retain inherited pipe handles. UI lifetime follows exit, not stream close.
child.once("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
