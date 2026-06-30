const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiUsage", {
  platform: process.platform,
  getCodexStats: () => ipcRenderer.invoke("codex:getStats"),
  chooseCodexHome: () => ipcRenderer.invoke("codex:chooseHome"),
  getStats: (provider) => ipcRenderer.invoke("usage:getStats", provider),
  chooseHome: (provider) => ipcRenderer.invoke("usage:chooseHome", provider),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url)
});
