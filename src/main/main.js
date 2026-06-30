const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { readCodexStats } = require("./codexStats");
const { createSettingsStore, normalizeSettings } = require("./settingsStore");

let mainWindow;
let settingsStore;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "AI Usage",
    backgroundColor: "#f7f8f5",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  settingsStore = createSettingsStore(app.getPath("userData"));

  ipcMain.handle("settings:get", async () => {
    return settingsStore.get();
  });

  ipcMain.handle("settings:update", async (_event, nextSettings) => {
    return settingsStore.save(normalizeSettings(nextSettings));
  });

  ipcMain.handle("codex:getStats", async () => {
    const settings = settingsStore.get();
    return readCodexStats({
      codexHome: settings.codexHome || undefined,
      chartDays: settings.chartDays
    });
  });

  ipcMain.handle("codex:chooseHome", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Codex data directory",
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const settings = settingsStore.save({ codexHome: result.filePaths[0] });
    const stats = await readCodexStats({
      codexHome: settings.codexHome,
      chartDays: settings.chartDays
    });

    return { settings, stats };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
