const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("versionstead", {
  selectProjectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("versionstead:select-project-directory"),
});
