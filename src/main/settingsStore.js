const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_CHART_DAYS } = require("./codexStats");

const DEFAULT_SETTINGS = {
  activeProvider: "codex",
  codexHome: "",
  claudeHome: "",
  theme: "system",
  accentColor: "blue",
  chartDays: DEFAULT_CHART_DAYS
};
const ACCENT_COLORS = ["blue", "turquoise", "green", "purple", "red", "orange", "graphite"];
const PROVIDERS = ["codex", "claude"];

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeSettings(settings = {}) {
  return {
    activeProvider: PROVIDERS.includes(settings.activeProvider) ? settings.activeProvider : DEFAULT_SETTINGS.activeProvider,
    codexHome: typeof settings.codexHome === "string" ? settings.codexHome : DEFAULT_SETTINGS.codexHome,
    claudeHome: typeof settings.claudeHome === "string" ? settings.claudeHome : DEFAULT_SETTINGS.claudeHome,
    theme: ["system", "light", "dark"].includes(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
    accentColor: ACCENT_COLORS.includes(settings.accentColor)
      ? settings.accentColor
      : DEFAULT_SETTINGS.accentColor,
    chartDays: Math.round(clampNumber(settings.chartDays, DEFAULT_SETTINGS.chartDays, 7, 365))
  };
}

function createSettingsStore(userDataPath) {
  const filePath = path.join(userDataPath, "settings.json");
  let current = DEFAULT_SETTINGS;

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        current = normalizeSettings(JSON.parse(fs.readFileSync(filePath, "utf8")));
      }
    } catch {
      current = DEFAULT_SETTINGS;
    }

    return current;
  }

  function save(nextSettings) {
    current = normalizeSettings({ ...current, ...nextSettings });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
    return current;
  }

  load();

  return {
    get: () => current,
    save,
    filePath
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  ACCENT_COLORS,
  PROVIDERS,
  createSettingsStore,
  normalizeSettings
};
