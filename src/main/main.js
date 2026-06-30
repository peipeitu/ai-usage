const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { readClaudeStats } = require("./claudeStats");
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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
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

function readStatsForProvider(settings, provider = settings.activeProvider) {
  if (provider === "claude") {
    return readClaudeStats({
      claudeHome: settings.claudeHome || undefined,
      chartDays: settings.chartDays
    });
  }

  return readCodexStats({
    codexHome: settings.codexHome || undefined,
    chartDays: settings.chartDays
  });
}

async function chooseProviderHome(provider) {
  const isClaude = provider === "claude";
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isClaude ? "Select Claude Code data directory" : "Select Codex data directory",
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const settings = settingsStore.save({
    activeProvider: provider,
    [isClaude ? "claudeHome" : "codexHome"]: result.filePaths[0]
  });
  const stats = await readStatsForProvider(settings, provider);

  return { settings, stats };
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
    return readStatsForProvider(settings, "codex");
  });

  ipcMain.handle("usage:getStats", async (_event, provider) => {
    const settings = settingsStore.get();
    return readStatsForProvider(settings, provider || settings.activeProvider);
  });

  ipcMain.handle("codex:chooseHome", async () => {
    return chooseProviderHome("codex");
  });

  ipcMain.handle("usage:chooseHome", async (_event, provider) => {
    return chooseProviderHome(provider === "claude" ? "claude" : "codex");
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
