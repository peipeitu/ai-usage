const tauriCore = window.__TAURI__?.core;
const tauriWindow = window.__TAURI__?.window;
const REPOSITORY_URL = "https://github.com/peipeitu/ai-usage";
const ISSUE_URL = "https://github.com/peipeitu/ai-usage/issues";
const aiUsage = window.aiUsage || {
  platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : navigator.platform.toLowerCase(),
  getStats: (provider) => tauriCore.invoke("get_stats", { provider }),
  chooseHome: (provider) => tauriCore.invoke("choose_home", { provider }),
  getSettings: () => tauriCore.invoke("get_settings"),
  updateSettings: (settings) => tauriCore.invoke("update_settings", { settings }),
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
  codexHome: "",
  claudeHome: "",
  language: "auto",
  theme: "system",
  accentColor: "blue",
  chartDays: 30
};
let currentView = "home";
let lastStats = null;

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
  }
};

const I18N = {
  zh: {
    brandSubtitle: "用量监控",
    primaryNavigation: "主导航",
    overview: "概览",
    settings: "设置",
    preferences: "偏好设置",
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
    codexHome: "Codex 数据目录",
    claudeHome: "Claude Code 数据目录",
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
    codexHome: "Codex data folder",
    claudeHome: "Claude Code data folder",
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
  refreshButton: document.getElementById("refreshButton"),
  chooseCodexHomeButton: document.getElementById("chooseCodexHomeButton"),
  chooseClaudeHomeButton: document.getElementById("chooseClaudeHomeButton"),
  codexHomeValue: document.getElementById("codexHomeValue"),
  claudeHomeValue: document.getElementById("claudeHomeValue"),
  settingsPanelTitle: document.getElementById("settingsPanelTitle"),
  codexHomeLabel: document.getElementById("codexHomeLabel"),
  claudeHomeLabel: document.getElementById("claudeHomeLabel"),
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
  providerButtons: Array.from(document.querySelectorAll("[data-provider]")),
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
  elements.repositoryLink.textContent = t("repository");
  elements.issueLink.textContent = t("feedback");
  elements.sidebarProviderSection.setAttribute("aria-label", t("aiService"));
  elements.sidebarProviderLabel.textContent = t("aiService");
  elements.providerOptions.setAttribute("aria-label", t("aiService"));
  elements.sidebarUsageSection.setAttribute("aria-label", t("periodUsage"));
  elements.sidebarUsageLabel.textContent = t("remainingUsage");
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
  elements.settingsPanelTitle.textContent = t("settings");
  elements.codexHomeLabel.textContent = t("codexHome");
  elements.claudeHomeLabel.textContent = t("claudeHome");
  elements.chooseCodexHomeButton.textContent = t("chooseFolder");
  elements.chooseClaudeHomeButton.textContent = t("chooseFolder");
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

function setView(view) {
  currentView = view;
  const isSettings = view === "settings";
  const provider = PROVIDERS[currentSettings.activeProvider] || PROVIDERS.codex;
  elements.homeView.hidden = isSettings;
  elements.settingsView.hidden = !isSettings;
  elements.refreshButton.hidden = isSettings;
  elements.homeButton.classList.toggle("active", !isSettings);
  elements.settingsButton.classList.toggle("active", isSettings);
  elements.viewEyebrow.textContent = isSettings ? t("preferences") : `${provider.label} ${t("usage")}`;
  elements.viewTitle.textContent = isSettings ? t("settings") : t("overview");
}

function setLoading(isLoading) {
  elements.refreshButton.disabled = isLoading;
  elements.chooseCodexHomeButton.disabled = isLoading;
  elements.chooseClaudeHomeButton.disabled = isLoading;
  elements.refreshButton.classList.toggle("loading", isLoading);
}

function renderError(message) {
  elements.errorPanel.hidden = !message;
  elements.errorPanel.textContent = message || "";
}

function renderSettings() {
  currentSettings.language = currentSettings.language || "auto";
  elements.codexHomeValue.textContent = currentSettings.codexHome || PROVIDERS.codex.defaultHome;
  elements.claudeHomeValue.textContent = currentSettings.claudeHome || PROVIDERS.claude.defaultHome;
  for (const button of elements.providerButtons) {
    const isActive = button.dataset.provider === currentSettings.activeProvider;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-checked", String(isActive));
  }
  elements.languageSelect.value = currentSettings.language;
  elements.themeSelect.value = currentSettings.theme;
  applyAccent(currentSettings.accentColor);
  elements.chartDaysInput.value = currentSettings.chartDays;
  elements.overviewPeriod.textContent = t("daysPeriod", { days: currentSettings.chartDays });
  elements.sidebarPeriodMeta.textContent = t("daysPeriod", { days: currentSettings.chartDays });
  for (const button of elements.periodButtons) {
    button.classList.toggle("active", Number(button.dataset.days) === Number(currentSettings.chartDays));
  }
  elements.settingsStatus.textContent = t("settingsSaved");
  applyTheme(currentSettings.theme);
  applyLanguage();
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
  elements.dailyChart.style.setProperty("--days", days.length);

  const max = Math.max(...days.map((day) => day.tokens), ...days.map((day) => day.threads), 1);

  for (const day of days) {
    const column = document.createElement("div");
    column.className = "day-column";

    const bar = document.createElement("div");
    bar.className = "day-bar";
    const intensity = day.tokens / max;
    if (intensity >= 0.72) {
      bar.dataset.level = "high";
    } else if (intensity >= 0.36) {
      bar.dataset.level = "medium";
    } else {
      bar.dataset.level = "low";
    }
    bar.style.height = `${Math.max(8, (Math.max(day.tokens, day.threads) / max) * 100)}%`;
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
    ? t("resetAt", { label: formatLimitLabel(mainLimit), time: formatResetTime(mainLimit) })
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

async function refreshStats() {
  setLoading(true);
  try {
    const stats = await aiUsage.getStats(currentSettings.activeProvider);
    renderStats(stats);
  } catch (error) {
    const provider = PROVIDERS[currentSettings.activeProvider] || PROVIDERS.codex;
    renderError(error.message || t("readStatsError", { provider: provider.label }));
  } finally {
    setLoading(false);
  }
}

async function saveSettings(nextSettings, shouldRefresh = true) {
  const languageChanged = Object.prototype.hasOwnProperty.call(nextSettings, "language");
  currentSettings = await aiUsage.updateSettings({
    ...currentSettings,
    ...nextSettings
  });
  renderSettings();
  if (languageChanged && lastStats) {
    renderStats(lastStats);
  }
  if (shouldRefresh) {
    await refreshStats();
  }
}

async function chooseHome(providerId) {
  setLoading(true);
  try {
    const result = await aiUsage.chooseHome(providerId);
    if (result) {
      currentSettings = result.settings;
      renderSettings();
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
elements.refreshButton.addEventListener("click", refreshStats);
elements.settingsButton.addEventListener("click", () => setView("settings"));
elements.homeButton.addEventListener("click", () => setView("home"));
elements.repositoryLink.addEventListener("click", (event) => openProjectLink(event, REPOSITORY_URL));
elements.issueLink.addEventListener("click", (event) => openProjectLink(event, ISSUE_URL));
elements.chooseCodexHomeButton.addEventListener("click", () => chooseHome("codex"));
elements.chooseClaudeHomeButton.addEventListener("click", () => chooseHome("claude"));
for (const button of elements.providerButtons) {
  button.addEventListener("click", async () => {
    await saveSettings({ activeProvider: button.dataset.provider });
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
    await saveSettings({ chartDays: button.dataset.days });
  });
}
elements.chartDaysInput.addEventListener("change", async () => {
  await saveSettings({ chartDays: elements.chartDaysInput.value });
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
  await refreshStats();
}

boot();
