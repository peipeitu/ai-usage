const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiUsage", {
  getCodexStats: () => ipcRenderer.invoke("codex:getStats"),
  chooseCodexHome: () => ipcRenderer.invoke("codex:chooseHome"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings)
});
