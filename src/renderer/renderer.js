const tauriCore = window.__TAURI__?.core;
const tauriWindow = window.__TAURI__?.window;
const REPOSITORY_URL = "https://github.com/peipeitu/ai-usage";
const ISSUE_URL = "https://github.com/peipeitu/ai-usage/issues";
const MIN_CHART_DAYS = 7;
const DEFAULT_CHART_DAYS = 30;
const MAX_CHART_DAYS = 90;
const aiUsage = window.aiUsage || {
  platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : navigator.platform.toLowerCase(),
  getStats: (provider) => tauriCore.invoke("get_stats", { provider }),
  chooseHome: (provider) => tauriCore.invoke("choose_home", { provider }),
  getSettings: () => tauriCore.invoke("get_settings"),
  updateSettings: (settings) => tauriCore.invoke("update_settings", { settings }),
  checkUpdate: () => tauriCore.invoke("check_update"),
  installUpdate: () => tauriCore.invoke("install_update"),
  openExternal: (url) => tauriCore.invoke("open_external", { url }),
  startWindowDrag: async () => {
    const currentWindow = tauriWindow?.getCurrentWindow?.();
    if (currentWindow?.startDragging) {
      try {
        await currentWindow.startDragging();
        return;
      } catch {
        // Fall through to the local Rust command when the JS window API is unavailable or denied.
      }
    }
    return tauriCore.invoke("start_window_drag");
  }
};

document.body.dataset.platform = aiUsage.platform || "unknown";

let currentSettings = {
  activeProvider: "codex",
  enabledProviders: ["codex", "claude", "copilot", "cursor", "chatgpt"],
  codexHome: "",
  claudeHome: "",
  copilotHome: "",
  cursorHome: "",
  chatgptHome: "",
  language: "auto",
  theme: "system",
  accentColor: "blue",
  chartDays: DEFAULT_CHART_DAYS
};
let currentView = "home";
let activeSettingsSectionId = "settingsGeneralSection";
let lastStats = null;
let latestStatsRequestId = 0;
let currentLoading = false;
let updateInfo = { supported: false, available: false, version: null };
let updateInstalling = false;
const statsCache = new Map();

function normalizeChartDays(value, fallback = DEFAULT_CHART_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) {
    return fallback;
  }
  return Math.min(MAX_CHART_DAYS, Math.max(MIN_CHART_DAYS, Math.round(days)));
}

function defaultCopilotHome() {
  if (aiUsage.platform?.includes("win")) {
    return "%APPDATA%/Code/User/globalStorage/github.copilot-chat";
  }
  if (aiUsage.platform?.includes("linux")) {
    return "~/.config/Code/User/globalStorage/github.copilot-chat";
  }
  return "~/Library/Application Support/Code/User/globalStorage/github.copilot-chat";
}

function defaultCursorHome() {
  if (aiUsage.platform?.includes("win")) {
    return "%APPDATA%/Cursor/User/globalStorage";
  }
  if (aiUsage.platform?.includes("linux")) {
    return "~/.config/Cursor/User/globalStorage";
  }
  return "~/Library/Application Support/Cursor/User/globalStorage";
}

function defaultChatgptHome() {
  if (aiUsage.platform?.includes("win")) {
    return "%APPDATA%/com.openai.chat";
  }
  if (aiUsage.platform?.includes("linux")) {
    return "~/.config/com.openai.chat";
  }
  return "~/Library/Application Support/com.openai.chat";
}

const PROVIDERS = {
  codex: {
    label: "Codex",
    initials: "CD",
    defaultHome: "~/.codex"
  },
  claude: {
    label: "Claude Code",
    initials: "CC",
    defaultHome: "~/.claude"
  },
  copilot: {
    label: "GitHub Copilot",
    initials: "GH",
    defaultHome: defaultCopilotHome()
  },
  cursor: {
    label: "Cursor",
    initials: "CU",
    defaultHome: defaultCursorHome()
  },
  chatgpt: {
    label: "ChatGPT",
    initials: "CG",
    defaultHome: defaultChatgptHome()
  }
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

const I18N = {
  zh: {
    brandSubtitle: "用量监控",
    primaryNavigation: "主导航",
    overview: "概览",
    settings: "设置",
    preferences: "偏好设置",
    backToApp: "返回应用",
    personal: "个人",
    providers: "Providers",
    general: "常规",
    appearance: "个性化",
    chart: "图表",
    providerEnabled: "启用",
    repository: "仓库",
    feedback: "反馈",
    refresh: "刷新",
    usage: "用量",
    aiService: "AI 服务",
    remainingUsage: "剩余用量",
    periodUsage: "周期用量",
    dataSource: "数据源",
    localEstimate: "本地日志估算",
    todayCost: "今日费用",
    periodCost: "近 {days} 天费用",
    periodTokens: "近 {days} 天 token 用量",
    latestTokenUsage: "最近 token 用量",
    threadsTotal: "总会话",
    threadsActive: "活跃",
    tokensTotal: "总 token",
    updatedThisWeek: "近 7 天更新",
    activityTrend: "近 {days} 天趋势",
    models: "模型",
    sources: "运行来源",
    workspaces: "工作区",
    recentThreads: "最近会话",
    settingsSaved: "已保存",
    updateAvailable: "更新到 {version}",
    installingUpdate: "正在更新",
    installUpdateError: "无法安装更新",
    enabledProviders: "启用 AI 服务",
    atLeastOneProvider: "至少启用一个 AI 服务",
    dataFolder: "数据目录",
    chooseFolder: "选择目录",
    language: "语言",
    followSystem: "跟随系统",
    chinese: "中文",
    english: "English",
    theme: "主题",
    light: "浅色",
    dark: "深色",
    accentColor: "主题色",
    chartPeriod: "图表周期",
    chartPeriodPresets: "图表周期快捷选择",
    oneWeek: "一周",
    oneMonth: "一个月",
    threeMonths: "三个月",
    daysSuffix: "天",
    daysPeriod: "近 {days} 天",
    emptyData: "暂无数据",
    emptyRateLimits: "暂无剩余用量数据",
    emptyRecentThreads: "暂无最近会话",
    updatedAt: "更新于 {date}",
    percentUsage: "{percent}% {plan} 使用量",
    usageEstimated: "按本地日志估算",
    resetAt: "{label} · {time} 重置",
    waitingForLogs: "等待 {provider} 日志",
    readStatsError: "无法读取 {provider} 统计",
    switchHomeError: "无法切换 {provider} 目录",
    tokens: "tokens",
    subtask: "子任务",
    unknown: "Unknown",
    untitled: "Untitled"
  },
  en: {
    brandSubtitle: "Usage monitor",
    primaryNavigation: "Primary navigation",
    overview: "Overview",
    settings: "Settings",
    preferences: "Preferences",
    backToApp: "Back to app",
    personal: "Personal",
    providers: "Providers",
    general: "General",
    appearance: "Personalization",
    chart: "Chart",
    providerEnabled: "Enabled",
    repository: "GitHub",
    feedback: "Feedback",
    refresh: "Refresh",
    usage: "usage",
    aiService: "AI service",
    remainingUsage: "Remaining usage",
    periodUsage: "Period usage",
    dataSource: "Data source",
    localEstimate: "Local log estimate",
    todayCost: "Today cost",
    periodCost: "{days}-day cost",
    periodTokens: "{days}-day token usage",
    latestTokenUsage: "Latest token usage",
    threadsTotal: "Total threads",
    threadsActive: "Active",
    tokensTotal: "Total tokens",
    updatedThisWeek: "Updated in 7 days",
    activityTrend: "{days}-day trend",
    models: "Models",
    sources: "Sources",
    workspaces: "Workspaces",
    recentThreads: "Recent threads",
    settingsSaved: "Saved",
    updateAvailable: "Update to {version}",
    installingUpdate: "Updating",
    installUpdateError: "Unable to install update",
    enabledProviders: "Enabled AI services",
    atLeastOneProvider: "Keep at least one AI service enabled",
    dataFolder: "Data folder",
    chooseFolder: "Choose folder",
    language: "Language",
    followSystem: "Follow system",
    chinese: "中文",
    english: "English",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    accentColor: "Accent color",
    chartPeriod: "Chart period",
    chartPeriodPresets: "Chart period presets",
    oneWeek: "1 week",
    oneMonth: "1 month",
    threeMonths: "3 months",
    daysSuffix: "days",
    daysPeriod: "Last {days} days",
    emptyData: "No data",
    emptyRateLimits: "No remaining usage data",
    emptyRecentThreads: "No recent threads",
    updatedAt: "Updated {date}",
    percentUsage: "{percent}% {plan} usage",
    usageEstimated: "Estimated from local logs",
    resetAt: "{label} · resets {time}",
    waitingForLogs: "Waiting for {provider} logs",
    readStatsError: "Unable to read {provider} stats",
    switchHomeError: "Unable to switch {provider} folder",
    tokens: "tokens",
    subtask: "Subtask",
    unknown: "Unknown",
    untitled: "Untitled"
  }
};

const elements = {
  documentTitle: document.querySelector("title"),
  brandSubtitle: document.getElementById("brandSubtitle"),
  primaryNav: document.getElementById("primaryNav"),
  homeView: document.getElementById("homeView"),
  settingsView: document.getElementById("settingsView"),
  homeButton: document.getElementById("homeButton"),
  settingsButton: document.getElementById("settingsButton"),
  settingsBackButton: document.getElementById("settingsBackButton"),
  settingsBackLabel: document.getElementById("settingsBackLabel"),
  settingsPersonalLabel: document.getElementById("settingsPersonalLabel"),
  settingsProvidersLabel: document.getElementById("settingsProvidersLabel"),
  settingsGeneralNavLabel: document.getElementById("settingsGeneralNavLabel"),
  settingsAppearanceNavLabel: document.getElementById("settingsAppearanceNavLabel"),
  settingsChartNavLabel: document.getElementById("settingsChartNavLabel"),
  settingsCodexNavLabel: document.getElementById("settingsCodexNavLabel"),
  settingsClaudeNavLabel: document.getElementById("settingsClaudeNavLabel"),
  settingsCopilotNavLabel: document.getElementById("settingsCopilotNavLabel"),
  settingsCursorNavLabel: document.getElementById("settingsCursorNavLabel"),
  settingsChatgptNavLabel: document.getElementById("settingsChatgptNavLabel"),
  repositoryLink: document.getElementById("repositoryLink"),
  issueLink: document.getElementById("issueLink"),
  sidebarProviderSection: document.getElementById("sidebarProviderSection"),
  sidebarProviderLabel: document.getElementById("sidebarProviderLabel"),
  providerOptions: document.getElementById("providerOptions"),
  sidebarUsageSection: document.getElementById("sidebarUsageSection"),
  sidebarUsageLabel: document.getElementById("sidebarUsageLabel"),
  overviewSourceLabel: document.getElementById("overviewSourceLabel"),
  overviewEstimateLabel: document.getElementById("overviewEstimateLabel"),
  overviewPeriod: document.getElementById("overviewPeriod"),
  sidebarRemainingUsage: document.getElementById("sidebarRemainingUsage"),
  sidebarPeriodMeta: document.getElementById("sidebarPeriodMeta"),
  viewEyebrow: document.getElementById("viewEyebrow"),
  viewTitle: document.getElementById("viewTitle"),
  overviewProvider: document.getElementById("overviewProvider"),
  accountInitials: document.getElementById("accountInitials"),
  accountName: document.getElementById("accountName"),
  accountPlan: document.getElementById("accountPlan"),
  errorPanel: document.getElementById("errorPanel"),
  todayCost: document.getElementById("todayCost"),
  periodCost: document.getElementById("periodCost"),
  periodUsagePercent: document.getElementById("periodUsagePercent"),
  periodTokens: document.getElementById("periodTokens"),
  latestTokenUsage: document.getElementById("latestTokenUsage"),
  todayCostLabel: document.getElementById("todayCostLabel"),
  periodCostLabel: document.getElementById("periodCostLabel"),
  periodTokensLabel: document.getElementById("periodTokensLabel"),
  latestTokenUsageLabel: document.getElementById("latestTokenUsageLabel"),
  activityTitle: document.getElementById("activityTitle"),
  threadsTotalLabel: document.getElementById("threadsTotalLabel"),
  threadsActiveLabel: document.getElementById("threadsActiveLabel"),
  tokensTotalLabel: document.getElementById("tokensTotalLabel"),
  updatedThisWeekLabel: document.getElementById("updatedThisWeekLabel"),
  threadsTotal: document.getElementById("threadsTotal"),
  threadsActive: document.getElementById("threadsActive"),
  tokensTotal: document.getElementById("tokensTotal"),
  updatedThisWeek: document.getElementById("updatedThisWeek"),
  lastUpdated: document.getElementById("lastUpdated"),
  rateLimitUpdated: document.getElementById("rateLimitUpdated"),
  rateLimitTitle: document.getElementById("rateLimitTitle"),
  modelTitle: document.getElementById("modelTitle"),
  sourceTitle: document.getElementById("sourceTitle"),
  workspaceTitle: document.getElementById("workspaceTitle"),
  recentThreadsTitle: document.getElementById("recentThreadsTitle"),
  dailyChart: document.getElementById("dailyChart"),
  chartTooltip: document.getElementById("chartTooltip"),
  rateLimitList: document.getElementById("rateLimitList"),
  modelList: document.getElementById("modelList"),
  sourceList: document.getElementById("sourceList"),
  workspaceList: document.getElementById("workspaceList"),
  recentThreads: document.getElementById("recentThreads"),
  updateButton: document.getElementById("updateButton"),
  refreshButton: document.getElementById("refreshButton"),
  chooseCodexHomeButton: document.getElementById("chooseCodexHomeButton"),
  chooseClaudeHomeButton: document.getElementById("chooseClaudeHomeButton"),
  chooseCopilotHomeButton: document.getElementById("chooseCopilotHomeButton"),
  chooseCursorHomeButton: document.getElementById("chooseCursorHomeButton"),
  chooseChatgptHomeButton: document.getElementById("chooseChatgptHomeButton"),
  codexHomeValue: document.getElementById("codexHomeValue"),
  claudeHomeValue: document.getElementById("claudeHomeValue"),
  copilotHomeValue: document.getElementById("copilotHomeValue"),
  cursorHomeValue: document.getElementById("cursorHomeValue"),
  chatgptHomeValue: document.getElementById("chatgptHomeValue"),
  settingsPanelTitle: document.getElementById("settingsPanelTitle"),
  settingsGeneralTitle: document.getElementById("settingsGeneralTitle"),
  settingsProvidersContentTitle: document.getElementById("settingsProvidersContentTitle"),
  settingsCodexProviderTitle: document.getElementById("settingsCodexProviderTitle"),
  settingsClaudeProviderTitle: document.getElementById("settingsClaudeProviderTitle"),
  settingsCopilotProviderTitle: document.getElementById("settingsCopilotProviderTitle"),
  settingsCursorProviderTitle: document.getElementById("settingsCursorProviderTitle"),
  settingsChatgptProviderTitle: document.getElementById("settingsChatgptProviderTitle"),
  settingsAppearanceTitle: document.getElementById("settingsAppearanceTitle"),
  settingsChartTitle: document.getElementById("settingsChartTitle"),
  providerEnabledLabels: Array.from(document.querySelectorAll("[data-provider-enabled-label]")),
  providerToggleLabels: Array.from(document.querySelectorAll("[data-provider-toggle-label]")),
  codexHomeLabel: document.getElementById("codexHomeLabel"),
  claudeHomeLabel: document.getElementById("claudeHomeLabel"),
  copilotHomeLabel: document.getElementById("copilotHomeLabel"),
  cursorHomeLabel: document.getElementById("cursorHomeLabel"),
  chatgptHomeLabel: document.getElementById("chatgptHomeLabel"),
  languageLabel: document.getElementById("languageLabel"),
  languageSelect: document.getElementById("languageSelect"),
  languageAutoOption: document.getElementById("languageAutoOption"),
  languageZhOption: document.getElementById("languageZhOption"),
  languageEnOption: document.getElementById("languageEnOption"),
  themeLabel: document.getElementById("themeLabel"),
  themeSystemOption: document.getElementById("themeSystemOption"),
  themeLightOption: document.getElementById("themeLightOption"),
  themeDarkOption: document.getElementById("themeDarkOption"),
  accentLabel: document.getElementById("accentLabel"),
  accentOptions: document.getElementById("accentOptions"),
  chartPeriodLabel: document.getElementById("chartPeriodLabel"),
  periodPresets: document.getElementById("periodPresets"),
  period7Button: document.getElementById("period7Button"),
  period30Button: document.getElementById("period30Button"),
  period90Button: document.getElementById("period90Button"),
  daysSuffix: document.getElementById("daysSuffix"),
  providerButtons: Array.from(document.querySelectorAll(".sidebar-provider [data-provider]")),
  settingsProviderNavButtons: Array.from(document.querySelectorAll("[data-settings-provider]")),
  enabledProviderInputs: Array.from(document.querySelectorAll("[data-enabled-provider]")),
  settingsNavButtons: Array.from(document.querySelectorAll("[data-settings-section]")),
  themeSelect: document.getElementById("themeSelect"),
  accentButtons: Array.from(document.querySelectorAll("[data-accent]")),
  periodButtons: Array.from(document.querySelectorAll("[data-days]")),
  chartDaysInput: document.getElementById("chartDaysInput"),
  settingsStatus: document.getElementById("settingsStatus")
};

function systemLanguage() {
  const language = [navigator.language, ...(navigator.languages || [])].filter(Boolean).find(Boolean) || "en";
  return language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function currentLanguage() {
  return currentSettings.language === "zh" || currentSettings.language === "en"
    ? currentSettings.language
    : systemLanguage();
}

function enabledProviders(settings = currentSettings) {
  const enabled = Array.isArray(settings.enabledProviders) ? settings.enabledProviders : PROVIDER_IDS;
  const normalized = enabled.filter((provider) => PROVIDER_IDS.includes(provider));
  return normalized.length ? normalized : [...PROVIDER_IDS];
}

function isProviderEnabled(providerId, settings = currentSettings) {
  return enabledProviders(settings).includes(providerId);
}

function firstEnabledProvider(settings = currentSettings) {
  return enabledProviders(settings)[0] || "codex";
}

function localeForLanguage() {
  return currentLanguage() === "zh" ? "zh-CN" : "en-US";
}

function t(key, values = {}) {
  const dictionary = I18N[currentLanguage()] || I18N.en;
  const template = dictionary[key] || I18N.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

function formatNumber(value) {
  return new Intl.NumberFormat(localeForLanguage(), {
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatCompact(value) {
  const number = Math.abs(Number(value) || 0);
  const sign = Number(value) < 0 ? "-" : "";
  const units = [
    { suffix: "B", value: 1_000_000_000 },
    { suffix: "M", value: 1_000_000 },
    { suffix: "K", value: 1_000 }
  ];
  const unit = units.find((candidate) => number >= candidate.value);

  if (!unit) {
    return `${sign}${formatNumber(number)}`;
  }

  const scaled = number / unit.value;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
  return `${sign}${scaled.toFixed(digits).replace(/\.0$/, "")}${unit.suffix}`;
}

function formatCurrency(value) {
  return `$${new Intl.NumberFormat(localeForLanguage(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value || 0)}`;
}

function formatPercent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

function formatResetTime(limit) {
  if (!limit?.resetsAt) return "-";
  const resetDate = new Date(limit.resetsAt);
  if (Number.isNaN(resetDate.getTime())) return "-";

  if (Number(limit.windowMinutes) <= 24 * 60) {
    return new Intl.DateTimeFormat(localeForLanguage(), {
      hour: "2-digit",
      minute: "2-digit"
    }).format(resetDate);
  }

  return new Intl.DateTimeFormat(localeForLanguage(), {
    month: "short",
    day: "numeric"
  }).format(resetDate);
}

function primaryRateLimit(stats) {
  return stats.rateLimits?.windows?.[0] || null;
}

function formatLimitLabel(limit) {
  const minutes = Number(limit?.windowMinutes) || 0;
  if (minutes === 300) return currentLanguage() === "zh" ? "5 小时" : "5 hours";
  if (minutes === 10080) return currentLanguage() === "zh" ? "1 周" : "1 week";
  if (minutes >= 10080 && minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return currentLanguage() === "zh" ? `${weeks} 周` : `${weeks} weeks`;
  }
  if (minutes >= 1440 && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return currentLanguage() === "zh" ? `${days} 天` : `${days} days`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return currentLanguage() === "zh" ? `${hours} 小时` : `${hours} hours`;
  }
  return currentLanguage() === "zh" ? `${minutes} 分钟` : `${minutes} minutes`;
}

function formatLimitMeta(limit) {
  const label = formatLimitLabel(limit);
  return limit?.resetsAt ? t("resetAt", { label, time: formatResetTime(limit) }) : label;
}

function displaySourceName(name) {
  if (name === "子任务" || name === "Subtask") return t("subtask");
  if (!name || name === "Unknown") return t("unknown");
  return name;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(localeForLanguage(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function applyLanguage() {
  const lang = currentLanguage();
  const chartDays = currentSettings.chartDays || 30;

  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  elements.documentTitle.textContent = "AI Usage";
  elements.brandSubtitle.textContent = t("brandSubtitle");
  elements.primaryNav.setAttribute("aria-label", t("primaryNavigation"));
  elements.homeButton.textContent = t("overview");
  elements.settingsButton.textContent = t("settings");
  elements.settingsBackLabel.textContent = t("backToApp");
  elements.settingsPersonalLabel.textContent = t("personal");
  elements.settingsProvidersLabel.textContent = t("providers");
  elements.settingsGeneralNavLabel.textContent = t("general");
  elements.settingsAppearanceNavLabel.textContent = t("appearance");
  elements.settingsChartNavLabel.textContent = t("chart");
  elements.settingsCodexNavLabel.textContent = PROVIDERS.codex.label;
  elements.settingsClaudeNavLabel.textContent = PROVIDERS.claude.label;
  elements.settingsCopilotNavLabel.textContent = PROVIDERS.copilot.label;
  elements.settingsCursorNavLabel.textContent = PROVIDERS.cursor.label;
  elements.settingsChatgptNavLabel.textContent = PROVIDERS.chatgpt.label;
  elements.repositoryLink.setAttribute("aria-label", t("repository"));
  elements.repositoryLink.setAttribute("title", t("repository"));
  elements.issueLink.setAttribute("aria-label", t("feedback"));
  elements.issueLink.setAttribute("title", t("feedback"));
  elements.sidebarProviderSection.setAttribute("aria-label", t("aiService"));
  elements.sidebarProviderLabel.textContent = t("aiService");
  elements.providerOptions.setAttribute("aria-label", t("aiService"));
  elements.sidebarUsageSection.setAttribute("aria-label", t("periodUsage"));
  elements.sidebarUsageLabel.textContent = t("remainingUsage");
  elements.updateButton.setAttribute("aria-label", t("updateAvailable", { version: updateInfo.version || "" }).trim());
  elements.updateButton.setAttribute("title", t("updateAvailable", { version: updateInfo.version || "" }).trim());
  elements.refreshButton.setAttribute("aria-label", t("refresh"));
  elements.refreshButton.setAttribute("title", t("refresh"));
  elements.overviewSourceLabel.textContent = t("dataSource");
  elements.overviewEstimateLabel.textContent = t("localEstimate");
  elements.todayCostLabel.textContent = t("todayCost");
  elements.periodCostLabel.textContent = t("periodCost", { days: chartDays });
  elements.periodTokensLabel.textContent = t("periodTokens", { days: chartDays });
  elements.latestTokenUsageLabel.textContent = t("latestTokenUsage");
  elements.threadsTotalLabel.textContent = t("threadsTotal");
  elements.threadsActiveLabel.textContent = t("threadsActive");
  elements.tokensTotalLabel.textContent = t("tokensTotal");
  elements.updatedThisWeekLabel.textContent = t("updatedThisWeek");
  elements.activityTitle.textContent = t("activityTrend", { days: chartDays });
  elements.rateLimitTitle.textContent = t("remainingUsage");
  elements.modelTitle.textContent = t("models");
  elements.sourceTitle.textContent = t("sources");
  elements.workspaceTitle.textContent = t("workspaces");
  elements.recentThreadsTitle.textContent = t("recentThreads");
  elements.settingsPanelTitle.textContent = t("general");
  elements.settingsGeneralTitle.textContent = t("general");
  elements.settingsProvidersContentTitle.textContent = t("providers");
  elements.settingsCodexProviderTitle.textContent = PROVIDERS.codex.label;
  elements.settingsClaudeProviderTitle.textContent = PROVIDERS.claude.label;
  elements.settingsCopilotProviderTitle.textContent = PROVIDERS.copilot.label;
  elements.settingsCursorProviderTitle.textContent = PROVIDERS.cursor.label;
  elements.settingsChatgptProviderTitle.textContent = PROVIDERS.chatgpt.label;
  elements.settingsAppearanceTitle.textContent = t("appearance");
  elements.settingsChartTitle.textContent = t("chart");
  for (const label of elements.providerEnabledLabels) {
    label.textContent = t("providerEnabled");
  }
  for (const label of elements.providerToggleLabels) {
    label.textContent = t("providerEnabled");
  }
  elements.codexHomeLabel.textContent = t("dataFolder");
  elements.claudeHomeLabel.textContent = t("dataFolder");
  elements.copilotHomeLabel.textContent = t("dataFolder");
  elements.cursorHomeLabel.textContent = t("dataFolder");
  elements.chatgptHomeLabel.textContent = t("dataFolder");
  elements.chooseCodexHomeButton.textContent = t("chooseFolder");
  elements.chooseClaudeHomeButton.textContent = t("chooseFolder");
  elements.chooseCopilotHomeButton.textContent = t("chooseFolder");
  elements.chooseCursorHomeButton.textContent = t("chooseFolder");
  elements.chooseChatgptHomeButton.textContent = t("chooseFolder");
  elements.languageLabel.textContent = t("language");
  elements.languageAutoOption.textContent = t("followSystem");
  elements.languageZhOption.textContent = t("chinese");
  elements.languageEnOption.textContent = t("english");
  elements.themeLabel.textContent = t("theme");
  elements.themeSystemOption.textContent = t("followSystem");
  elements.themeLightOption.textContent = t("light");
  elements.themeDarkOption.textContent = t("dark");
  elements.accentLabel.textContent = t("accentColor");
  elements.accentOptions.setAttribute("aria-label", t("accentColor"));
  elements.chartPeriodLabel.textContent = t("chartPeriod");
  elements.periodPresets.setAttribute("aria-label", t("chartPeriodPresets"));
  elements.period7Button.textContent = t("oneWeek");
  elements.period30Button.textContent = t("oneMonth");
  elements.period90Button.textContent = t("threeMonths");
  elements.daysSuffix.textContent = t("daysSuffix");
  renderProviderVisibility();
  renderUpdateButton();
  activateSettingsNav(activeSettingsSectionId);
  setView(currentView);
}

function applyTheme(theme) {
  const resolvedTheme =
    theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : theme;

  document.body.dataset.theme = resolvedTheme === "dark" ? "dark" : "light";
}

function applyAccent(accentColor) {
  const resolvedAccent = accentColor || "blue";
  document.body.dataset.accent = resolvedAccent;
  for (const button of elements.accentButtons) {
    button.classList.toggle("active", button.dataset.accent === resolvedAccent);
  }
}

function renderUpdateButton() {
  const version = updateInfo.version || "";
  const isSettings = currentView === "settings";
  const shouldShow = Boolean(updateInfo.supported && updateInfo.available && !isSettings);

  elements.updateButton.hidden = !shouldShow;
  elements.updateButton.disabled = updateInstalling;
  elements.updateButton.textContent = updateInstalling ? t("installingUpdate") : t("updateAvailable", { version });
  elements.updateButton.setAttribute("aria-label", t("updateAvailable", { version }));
  elements.updateButton.setAttribute("title", t("updateAvailable", { version }));
}

function setView(view) {
  currentView = view;
  document.body.dataset.view = view;
  const isSettings = view === "settings";
  const provider = PROVIDERS[currentSettings.activeProvider] || PROVIDERS.codex;
  elements.homeView.hidden = isSettings;
  elements.settingsView.hidden = !isSettings;
  elements.refreshButton.hidden = isSettings;
  elements.homeButton.classList.toggle("active", !isSettings);
  elements.settingsButton.classList.toggle("active", isSettings);
  elements.viewEyebrow.textContent = isSettings ? t("preferences") : `${provider.label} ${t("usage")}`;
  elements.viewTitle.textContent = isSettings ? t("settings") : t("overview");
  renderUpdateButton();
}

function settingsPanelGroupTitle(sectionId) {
  return ["settingsGeneralSection", "settingsAppearanceSection", "settingsChartSection"].includes(sectionId)
    ? t("personal")
    : t("providers");
}

function activateSettingsNav(sectionId) {
  activeSettingsSectionId = sectionId;
  for (const button of elements.settingsNavButtons) {
    button.classList.toggle("active", button.dataset.settingsSection === sectionId);
  }
  elements.settingsPanelTitle.textContent = settingsPanelGroupTitle(sectionId);
}

function renderProviderVisibility() {
  for (const button of elements.providerButtons) {
    const isEnabled = isProviderEnabled(button.dataset.provider);
    button.hidden = !isEnabled;
    button.setAttribute("aria-hidden", String(!isEnabled));
    const isActive = button.dataset.provider === currentSettings.activeProvider;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-checked", String(isActive));
  }

  for (const button of elements.settingsProviderNavButtons) {
    const isEnabled = isProviderEnabled(button.dataset.settingsProvider);
    button.classList.toggle("inactive-provider", !isEnabled);
  }
}

function setLoading(isLoading) {
  currentLoading = isLoading;
  elements.refreshButton.disabled = isLoading;
  elements.updateButton.disabled = isLoading || updateInstalling;
  elements.chooseCodexHomeButton.disabled = isLoading || !isProviderEnabled("codex");
  elements.chooseClaudeHomeButton.disabled = isLoading || !isProviderEnabled("claude");
  elements.chooseCopilotHomeButton.disabled = isLoading || !isProviderEnabled("copilot");
  elements.chooseCursorHomeButton.disabled = isLoading || !isProviderEnabled("cursor");
  elements.chooseChatgptHomeButton.disabled = isLoading || !isProviderEnabled("chatgpt");
  elements.refreshButton.classList.toggle("loading", isLoading);
}

function renderError(message) {
  elements.errorPanel.hidden = !message;
  elements.errorPanel.textContent = message || "";
}

function providerHome(providerId, settings = currentSettings) {
  if (providerId === "claude") return settings.claudeHome || "";
  if (providerId === "copilot") return settings.copilotHome || "";
  if (providerId === "cursor") return settings.cursorHome || "";
  if (providerId === "chatgpt") return settings.chatgptHome || "";
  return settings.codexHome || "";
}

function statsCacheKey(providerId = currentSettings.activeProvider, settings = currentSettings) {
  return [providerId, settings.chartDays || 30, providerHome(providerId, settings)].join("\u001f");
}

function cacheStats(providerId, stats, settings = currentSettings) {
  statsCache.set(statsCacheKey(providerId, settings), stats);
}

function cachedStats(providerId = currentSettings.activeProvider, settings = currentSettings) {
  return statsCache.get(statsCacheKey(providerId, settings)) || null;
}

function clearSkeletons() {
  for (const node of document.querySelectorAll(".skeleton-line, .skeleton-block")) {
    node.classList.remove("skeleton-line", "skeleton-block");
    node.style.removeProperty("--skeleton-width");
  }
}

function markSkeleton(element, width = "72%") {
  element.textContent = "";
  element.classList.add("skeleton-line");
  element.style.setProperty("--skeleton-width", width);
}

function appendSkeletonRows(container, count, kind = "rank") {
  container.replaceChildren();
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div");
    row.className = kind === "thread" ? "thread-row" : "rank-row";

    if (kind === "thread") {
      const main = document.createElement("div");
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      markSkeleton(title, `${68 - index * 4}%`);
      markSkeleton(meta, `${52 - index * 3}%`);
      main.append(title, meta);
      const value = document.createElement("span");
      markSkeleton(value, "42px");
      row.append(main, value);
    } else {
      const label = document.createElement("span");
      label.className = "rank-label";
      const value = document.createElement("span");
      value.className = "rank-value";
      markSkeleton(label, `${64 - index * 5}%`);
      markSkeleton(value, "38px");
      row.append(label, value);
    }

    container.append(row);
  }
}

function setChartScale(daysCount) {
  elements.dailyChart.style.setProperty("--days", daysCount);
  const gap = daysCount > 180 ? 0 : daysCount > 60 ? 2 : 6;
  elements.dailyChart.style.setProperty("--chart-gap", `${gap}px`);
}

function renderChartSkeleton(daysCount) {
  elements.dailyChart.replaceChildren();
  setChartScale(daysCount);
  for (let index = 0; index < daysCount; index += 1) {
    const column = document.createElement("div");
    column.className = "day-column";
    const bar = document.createElement("div");
    bar.className = "day-bar skeleton-block";
    bar.style.height = `${18 + ((index * 17) % 54)}%`;
    column.append(bar);
    elements.dailyChart.append(column);
  }
}

function renderStatsSkeleton(providerId = currentSettings.activeProvider) {
  clearSkeletons();
  renderError(null);

  const provider = PROVIDERS[providerId] || PROVIDERS.codex;
  const chartDays = currentSettings.chartDays || 30;
  elements.overviewProvider.textContent = provider.label;
  elements.periodCostLabel.textContent = t("periodCost", { days: chartDays });
  elements.periodTokensLabel.textContent = t("periodTokens", { days: chartDays });
  elements.activityTitle.textContent = t("activityTrend", { days: chartDays });
  elements.overviewPeriod.textContent = t("daysPeriod", { days: chartDays });
  elements.accountInitials.textContent = provider.initials;
  elements.accountName.textContent = provider.label;
  markSkeleton(elements.accountPlan, "64px");
  markSkeleton(elements.todayCost, "86px");
  markSkeleton(elements.periodCost, "86px");
  markSkeleton(elements.periodUsagePercent, "110px");
  markSkeleton(elements.periodTokens, "78px");
  markSkeleton(elements.latestTokenUsage, "72px");
  markSkeleton(elements.threadsTotal, "48px");
  markSkeleton(elements.threadsActive, "48px");
  markSkeleton(elements.tokensTotal, "64px");
  markSkeleton(elements.updatedThisWeek, "48px");
  markSkeleton(elements.sidebarRemainingUsage, "46px");
  markSkeleton(elements.sidebarPeriodMeta, "116px");
  markSkeleton(elements.lastUpdated, "118px");
  markSkeleton(elements.rateLimitUpdated, "94px");

  renderChartSkeleton(chartDays);
  appendSkeletonRows(elements.rateLimitList, 2);
  appendSkeletonRows(elements.modelList, 3);
  appendSkeletonRows(elements.sourceList, 3);
  appendSkeletonRows(elements.workspaceList, 4);
  appendSkeletonRows(elements.recentThreads, 4, "thread");
}

function renderSettings() {
  currentSettings.language = currentSettings.language || "auto";
  currentSettings.enabledProviders = enabledProviders();
  if (!isProviderEnabled(currentSettings.activeProvider)) {
    currentSettings.activeProvider = firstEnabledProvider();
  }
  elements.codexHomeValue.textContent = currentSettings.codexHome || PROVIDERS.codex.defaultHome;
  elements.claudeHomeValue.textContent = currentSettings.claudeHome || PROVIDERS.claude.defaultHome;
  elements.copilotHomeValue.textContent = currentSettings.copilotHome || PROVIDERS.copilot.defaultHome;
  elements.cursorHomeValue.textContent = currentSettings.cursorHome || PROVIDERS.cursor.defaultHome;
  elements.chatgptHomeValue.textContent = currentSettings.chatgptHome || PROVIDERS.chatgpt.defaultHome;
  for (const input of elements.enabledProviderInputs) {
    input.checked = isProviderEnabled(input.dataset.enabledProvider);
  }
  renderProviderVisibility();
  elements.languageSelect.value = currentSettings.language;
  elements.themeSelect.value = currentSettings.theme;
  applyAccent(currentSettings.accentColor);
  elements.chartDaysInput.min = String(MIN_CHART_DAYS);
  elements.chartDaysInput.max = String(MAX_CHART_DAYS);
  elements.chartDaysInput.value = currentSettings.chartDays;
  elements.overviewPeriod.textContent = t("daysPeriod", { days: currentSettings.chartDays });
  elements.sidebarPeriodMeta.textContent = t("daysPeriod", { days: currentSettings.chartDays });
  for (const button of elements.periodButtons) {
    button.classList.toggle("active", Number(button.dataset.days) === Number(currentSettings.chartDays));
  }
  elements.settingsStatus.textContent = t("settingsSaved");
  applyTheme(currentSettings.theme);
  applyLanguage();
  setLoading(currentLoading);
}

function renderRankList(container, items, options = {}) {
  container.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("emptyData");
    container.append(empty);
    return;
  }

  const max = Math.max(...items.map((item) => item.value), 1);

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "rank-row";

    const label = document.createElement("span");
    label.className = "rank-label";
    label.textContent = options.formatName ? options.formatName(item.name) : item.name;

    const value = document.createElement("span");
    value.className = "rank-value";
    value.textContent = options.compact ? formatCompact(item.value) : formatNumber(item.value);

    const bar = document.createElement("span");
    bar.className = "rank-bar";
    bar.style.setProperty("--value", `${Math.max(4, (item.value / max) * 100)}%`);

    row.append(label, value, bar);
    container.append(row);
  }
}

function renderRateLimits(rateLimits) {
  elements.rateLimitList.replaceChildren();

  if (!rateLimits?.windows?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("emptyRateLimits");
    elements.rateLimitList.append(empty);
    elements.rateLimitUpdated.textContent = "-";
    return;
  }

  elements.rateLimitUpdated.textContent = rateLimits.updatedAt
    ? t("updatedAt", { date: formatDate(rateLimits.updatedAt) })
    : "-";

  for (const limit of rateLimits.windows) {
    const row = document.createElement("div");
    row.className = "limit-row";

    const label = document.createElement("strong");
    label.textContent = formatLimitLabel(limit);

    const remaining = document.createElement("span");
    remaining.textContent = formatPercent(limit.remainingPercent);

    const reset = document.createElement("span");
    reset.textContent = formatResetTime(limit);

    const meter = document.createElement("div");
    meter.className = "limit-meter";
    meter.style.setProperty("--remaining", `${Math.max(0, Math.min(100, Number(limit.remainingPercent) || 0))}%`);

    row.append(label, remaining, reset, meter);
    elements.rateLimitList.append(row);
  }
}

function renderDailyChart(days) {
  elements.dailyChart.replaceChildren();
  setChartScale(days.length);

  const maxTokens = Math.max(...days.map((day) => day.tokens), 1);

  for (const day of days) {
    const column = document.createElement("div");
    column.className = "day-column";

    const bar = document.createElement("div");
    bar.className = "day-bar";
    const intensity = day.tokens / maxTokens;
    if (intensity >= 0.72) {
      bar.dataset.level = "high";
    } else if (intensity >= 0.36) {
      bar.dataset.level = "medium";
    } else {
      bar.dataset.level = "low";
    }
    if (day.tokens === 0) {
      bar.dataset.empty = "true";
    }
    bar.style.height = day.tokens > 0 ? `${Math.max(8, (day.tokens / maxTokens) * 100)}%` : "3px";
    bar.setAttribute("aria-label", `${day.date}: ${formatCompact(day.tokens)} ${t("tokens")}`);
    bar.addEventListener("mouseenter", (event) => {
      bar.classList.add("active");
      showChartTooltip(event, day);
    });
    bar.addEventListener("mousemove", (event) => moveChartTooltip(event));
    bar.addEventListener("mouseleave", () => {
      bar.classList.remove("active");
      hideChartTooltip();
    });

    column.append(bar);
    elements.dailyChart.append(column);
  }
}

function showChartTooltip(event, day) {
  elements.chartTooltip.innerHTML = `
    <strong>${day.date}</strong>
    <span>${formatCompact(day.tokens)} ${t("tokens")}</span>
    <span>${formatCurrency(day.cost)}</span>
  `;
  elements.chartTooltip.hidden = false;
  moveChartTooltip(event);
}

function moveChartTooltip(event) {
  const rect = elements.dailyChart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  elements.chartTooltip.style.left = `${Math.min(rect.width - 150, Math.max(8, x + 10))}px`;
  elements.chartTooltip.style.top = `${Math.max(8, y - 54)}px`;
}

function hideChartTooltip() {
  elements.chartTooltip.hidden = true;
}

function renderRecentThreads(threads) {
  elements.recentThreads.replaceChildren();

  if (!threads.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("emptyRecentThreads");
    elements.recentThreads.append(empty);
    return;
  }

  for (const thread of threads) {
    const row = document.createElement("div");
    row.className = "thread-row";

    const main = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = thread.title || t("untitled");
    const meta = document.createElement("span");
    meta.textContent = `${thread.model} · ${displaySourceName(thread.source)} · ${formatDate(thread.updatedAt)}`;
    main.append(title, meta);

    const tokens = document.createElement("span");
    tokens.className = "thread-token";
    tokens.textContent = formatCompact(thread.tokensUsed);

    row.append(main, tokens);
    elements.recentThreads.append(row);
  }
}

function renderStats(stats) {
  clearSkeletons();
  lastStats = stats;
  const chartDays = stats.settings?.chartDays || currentSettings.chartDays;
  const mainLimit = primaryRateLimit(stats);
  const provider = PROVIDERS[currentSettings.activeProvider] || PROVIDERS.codex;
  renderError(stats.error);

  elements.overviewProvider.textContent = provider.label;
  elements.periodCostLabel.textContent = t("periodCost", { days: chartDays });
  elements.periodTokensLabel.textContent = t("periodTokens", { days: chartDays });
  elements.activityTitle.textContent = t("activityTrend", { days: chartDays });
  elements.overviewPeriod.textContent = t("daysPeriod", { days: chartDays });
  elements.todayCost.textContent = formatCurrency(stats.featured.todayCost);
  elements.periodCost.textContent = formatCurrency(stats.featured.periodCost);
  elements.periodUsagePercent.textContent = Number.isFinite(stats.featured.periodUsagePercent)
    ? t("percentUsage", {
        percent: Math.round(stats.featured.periodUsagePercent),
        plan: stats.account?.planLabel || ""
      })
    : t("usageEstimated");
  elements.sidebarRemainingUsage.textContent = mainLimit ? formatPercent(mainLimit.remainingPercent) : "-";
  elements.sidebarPeriodMeta.textContent = mainLimit
    ? formatLimitMeta(mainLimit)
    : t("waitingForLogs", { provider: provider.label });
  elements.periodTokens.textContent = formatCompact(stats.featured.periodTokens);
  elements.latestTokenUsage.textContent = formatCompact(stats.featured.latestTokenUsage);

  elements.threadsTotal.textContent = formatCompact(stats.totals.threads);
  elements.threadsActive.textContent = formatCompact(stats.totals.activeThreads);
  elements.tokensTotal.textContent = formatCompact(stats.totals.totalTokens);
  elements.updatedThisWeek.textContent = formatCompact(stats.totals.updatedThisWeek);
  elements.lastUpdated.textContent = t("updatedAt", { date: formatDate(stats.generatedAt) });
  elements.accountInitials.textContent = stats.account?.initials || provider.initials;
  elements.accountName.textContent = stats.account?.displayName || provider.label;
  elements.accountPlan.textContent = stats.account?.planLabel || provider.label;

  renderDailyChart(stats.dailySeries);
  renderRateLimits(stats.rateLimits);
  renderRankList(elements.modelList, stats.models, { compact: true });
  renderRankList(elements.sourceList, stats.sources, { formatName: displaySourceName });
  renderRankList(elements.workspaceList, stats.workspaces, { compact: true });
  renderRecentThreads(stats.latestThreads);
}

async function refreshStats(options = {}) {
  const { force = false, preferCache = false, showLoading = true } = options;
  const providerId = currentSettings.activeProvider;
  const requestId = latestStatsRequestId + 1;
  latestStatsRequestId = requestId;

  if (!force) {
    const cached = cachedStats(providerId);
    if (cached) {
      renderStats(cached);
      if (!preferCache) {
        return;
      }
    } else {
      renderStatsSkeleton(providerId);
    }
  } else {
    renderStatsSkeleton(providerId);
  }

  if (showLoading) {
    setLoading(true);
  }
  try {
    const stats = await aiUsage.getStats(providerId);
    if (requestId !== latestStatsRequestId || providerId !== currentSettings.activeProvider) {
      return;
    }
    cacheStats(providerId, stats);
    renderStats(stats);
  } catch (error) {
    if (requestId !== latestStatsRequestId) {
      return;
    }
    const provider = PROVIDERS[providerId] || PROVIDERS.codex;
    renderError(error.message || t("readStatsError", { provider: provider.label }));
  } finally {
    if (requestId === latestStatsRequestId && showLoading) {
      setLoading(false);
    }
  }
}

async function checkForUpdates() {
  try {
    updateInfo = await aiUsage.checkUpdate();
  } catch {
    updateInfo = { supported: false, available: false, version: null };
  }
  renderUpdateButton();
}

async function installAvailableUpdate() {
  if (!updateInfo.supported || !updateInfo.available || updateInstalling) {
    return;
  }

  updateInstalling = true;
  renderUpdateButton();
  setLoading(currentLoading);

  try {
    await aiUsage.installUpdate();
  } catch (error) {
    renderError(error.message || t("installUpdateError"));
    updateInstalling = false;
    renderUpdateButton();
    setLoading(currentLoading);
  }
}

async function saveSettings(nextSettings, shouldRefresh = true) {
  const languageChanged = Object.prototype.hasOwnProperty.call(nextSettings, "language");
  const normalizedNextSettings = { ...nextSettings };
  if (Object.prototype.hasOwnProperty.call(normalizedNextSettings, "chartDays")) {
    normalizedNextSettings.chartDays = normalizeChartDays(
      normalizedNextSettings.chartDays,
      normalizeChartDays(currentSettings.chartDays)
    );
  }
  currentSettings = await aiUsage.updateSettings({
    ...currentSettings,
    ...normalizedNextSettings
  });
  renderSettings();
  if (languageChanged && lastStats) {
    renderStats(lastStats);
  }
  if (shouldRefresh) {
    await refreshStats({ preferCache: true });
  }
}

async function chooseHome(providerId) {
  setLoading(true);
  try {
    const result = await aiUsage.chooseHome(providerId);
    if (result) {
      currentSettings = result.settings;
      renderSettings();
      cacheStats(providerId, result.stats);
      renderStats(result.stats);
    }
  } catch (error) {
    const provider = PROVIDERS[providerId] || PROVIDERS.codex;
    renderError(error.message || t("switchHomeError", { provider: provider.label }));
  } finally {
    setLoading(false);
  }
}

function shouldStartWindowDrag(event) {
  if (event.button !== 0) return false;
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target?.closest("[data-tauri-drag-region]")) return false;
  return !target.closest("button, input, select, textarea, a, [role='button']");
}

function startWindowDrag(event) {
  if (!shouldStartWindowDrag(event)) return;
  event.preventDefault();
  aiUsage.startWindowDrag().catch(() => {});
}

function openProjectLink(event, url) {
  event.preventDefault();
  aiUsage.openExternal(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

document.addEventListener("pointerdown", startWindowDrag, true);
elements.updateButton.addEventListener("click", installAvailableUpdate);
elements.refreshButton.addEventListener("click", () => refreshStats({ force: true }));
elements.settingsButton.addEventListener("click", () => setView("settings"));
elements.homeButton.addEventListener("click", () => setView("home"));
elements.settingsBackButton.addEventListener("click", () => setView("home"));
elements.repositoryLink.addEventListener("click", (event) => openProjectLink(event, REPOSITORY_URL));
elements.issueLink.addEventListener("click", (event) => openProjectLink(event, ISSUE_URL));
elements.chooseCodexHomeButton.addEventListener("click", () => chooseHome("codex"));
elements.chooseClaudeHomeButton.addEventListener("click", () => chooseHome("claude"));
elements.chooseCopilotHomeButton.addEventListener("click", () => chooseHome("copilot"));
elements.chooseCursorHomeButton.addEventListener("click", () => chooseHome("cursor"));
elements.chooseChatgptHomeButton.addEventListener("click", () => chooseHome("chatgpt"));
for (const button of elements.providerButtons) {
  button.addEventListener("click", async () => {
    if (!isProviderEnabled(button.dataset.provider)) return;
    await saveSettings({ activeProvider: button.dataset.provider });
  });
}
for (const input of elements.enabledProviderInputs) {
  input.addEventListener("change", async () => {
    const previousActiveProvider = currentSettings.activeProvider;
    const nextEnabledProviders = elements.enabledProviderInputs
      .filter((providerInput) => providerInput.checked)
      .map((providerInput) => providerInput.dataset.enabledProvider);

    if (!nextEnabledProviders.length) {
      input.checked = true;
      elements.settingsStatus.textContent = t("atLeastOneProvider");
      return;
    }

    const nextSettings = { enabledProviders: nextEnabledProviders };
    if (!nextEnabledProviders.includes(currentSettings.activeProvider)) {
      nextSettings.activeProvider = nextEnabledProviders[0];
    }
    await saveSettings(nextSettings, false);
    if (currentSettings.activeProvider !== previousActiveProvider) {
      await refreshStats({ preferCache: true, showLoading: false });
    }
  });
}
for (const button of elements.settingsNavButtons) {
  button.addEventListener("click", () => {
    const sectionId = button.dataset.settingsSection;
    const section = document.getElementById(sectionId);
    if (!section) return;
    activateSettingsNav(sectionId);
    section.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}
elements.themeSelect.addEventListener("change", async () => {
  await saveSettings({ theme: elements.themeSelect.value }, false);
});
elements.languageSelect.addEventListener("change", async () => {
  await saveSettings({ language: elements.languageSelect.value }, false);
});
for (const button of elements.accentButtons) {
  button.addEventListener("click", async () => {
    await saveSettings({ accentColor: button.dataset.accent }, false);
  });
}
for (const button of elements.periodButtons) {
  button.addEventListener("click", async () => {
    await saveSettings({ chartDays: Number(button.dataset.days) });
  });
}
elements.chartDaysInput.addEventListener("change", async () => {
  const chartDays = normalizeChartDays(elements.chartDaysInput.value, normalizeChartDays(currentSettings.chartDays));
  elements.chartDaysInput.value = chartDays;
  await saveSettings({ chartDays });
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyTheme(currentSettings.theme);
});
window.addEventListener("languagechange", () => {
  if (currentSettings.language !== "auto") return;
  renderSettings();
  if (lastStats) {
    renderStats(lastStats);
  }
});

async function boot() {
  currentSettings = await aiUsage.getSettings();
  renderSettings();
  setView(currentView);
  await Promise.all([refreshStats({ preferCache: true }), checkForUpdates()]);
}

boot();
