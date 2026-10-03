const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("versionstead", {
  selectProjectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("versionstead:select-project-directory"),
  runProjectAction: (
    projectId: string,
    actionId: string,
    expectedCommand: string,
  ): Promise<unknown> =>
    ipcRenderer.invoke("versionstead:run-project-action", { projectId, actionId, expectedCommand }),
  projectActionStatus: (
    input: string | { projectId: string; actionId: string },
  ): Promise<unknown> => ipcRenderer.invoke("versionstead:project-action-status", input),
  stopProjectAction: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("versionstead:project-action-stop", id),
  updateGlobalTool: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("versionstead:global-tool-update-start", input),
  globalToolUpdateCommand: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("versionstead:global-tool-update-command", input),
  globalToolUpdateStatus: (): Promise<unknown> =>
    ipcRenderer.invoke("versionstead:global-tool-update-status"),
});
