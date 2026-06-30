const currencyFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const wholeFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0
});

let currentSettings = {
  codexHome: "",
  theme: "system",
  accentColor: "blue",
  chartDays: 30
};
let currentView = "home";

const elements = {
  homeView: document.getElementById("homeView"),
  settingsView: document.getElementById("settingsView"),
  homeButton: document.getElementById("homeButton"),
  settingsButton: document.getElementById("settingsButton"),
  overviewPeriod: document.getElementById("overviewPeriod"),
  sidebarRemainingUsage: document.getElementById("sidebarRemainingUsage"),
  sidebarPeriodMeta: document.getElementById("sidebarPeriodMeta"),
  viewEyebrow: document.getElementById("viewEyebrow"),
  viewTitle: document.getElementById("viewTitle"),
  accountInitials: document.getElementById("accountInitials"),
  accountName: document.getElementById("accountName"),
  accountPlan: document.getElementById("accountPlan"),
  errorPanel: document.getElementById("errorPanel"),
  todayCost: document.getElementById("todayCost"),
  periodCost: document.getElementById("periodCost"),
  periodUsagePercent: document.getElementById("periodUsagePercent"),
  periodTokens: document.getElementById("periodTokens"),
  latestTokenUsage: document.getElementById("latestTokenUsage"),
  periodCostLabel: document.getElementById("periodCostLabel"),
  periodTokensLabel: document.getElementById("periodTokensLabel"),
  activityTitle: document.getElementById("activityTitle"),
  threadsTotal: document.getElementById("threadsTotal"),
  threadsActive: document.getElementById("threadsActive"),
  tokensTotal: document.getElementById("tokensTotal"),
  updatedThisWeek: document.getElementById("updatedThisWeek"),
  lastUpdated: document.getElementById("lastUpdated"),
  rateLimitUpdated: document.getElementById("rateLimitUpdated"),
  dailyChart: document.getElementById("dailyChart"),
  chartTooltip: document.getElementById("chartTooltip"),
  rateLimitList: document.getElementById("rateLimitList"),
  modelList: document.getElementById("modelList"),
  sourceList: document.getElementById("sourceList"),
  workspaceList: document.getElementById("workspaceList"),
  recentThreads: document.getElementById("recentThreads"),
  refreshButton: document.getElementById("refreshButton"),
  chooseHomeButton: document.getElementById("chooseHomeButton"),
  codexHomeValue: document.getElementById("codexHomeValue"),
  themeSelect: document.getElementById("themeSelect"),
  accentButtons: Array.from(document.querySelectorAll("[data-accent]")),
  periodButtons: Array.from(document.querySelectorAll("[data-days]")),
  chartDaysInput: document.getElementById("chartDaysInput"),
  settingsStatus: document.getElementById("settingsStatus")
};

function formatNumber(value) {
  return wholeFormatter.format(value || 0);
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
  return `$${currencyFormatter.format(value || 0)}`;
}

function formatPercent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

function formatResetTime(limit) {
  if (!limit?.resetsAt) return "-";
  const resetDate = new Date(limit.resetsAt);
  if (Number.isNaN(resetDate.getTime())) return "-";

  if (Number(limit.windowMinutes) <= 24 * 60) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    }).format(resetDate);
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(resetDate);
}

function primaryRateLimit(stats) {
  return stats.rateLimits?.windows?.[0] || null;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
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
  elements.homeView.hidden = isSettings;
  elements.settingsView.hidden = !isSettings;
  elements.refreshButton.hidden = isSettings;
  elements.homeButton.classList.toggle("active", !isSettings);
  elements.settingsButton.classList.toggle("active", isSettings);
  elements.viewEyebrow.textContent = isSettings ? "Preferences" : "Codex usage";
  elements.viewTitle.textContent = isSettings ? "设置" : "概览";
}

function setLoading(isLoading) {
  elements.refreshButton.disabled = isLoading;
  elements.chooseHomeButton.disabled = isLoading;
  elements.refreshButton.classList.toggle("loading", isLoading);
}

function renderError(message) {
  elements.errorPanel.hidden = !message;
  elements.errorPanel.textContent = message || "";
}

function renderSettings() {
  elements.codexHomeValue.textContent = currentSettings.codexHome || "~/.codex";
  elements.themeSelect.value = currentSettings.theme;
  applyAccent(currentSettings.accentColor);
  elements.chartDaysInput.value = currentSettings.chartDays;
  elements.overviewPeriod.textContent = `近 ${currentSettings.chartDays} 天`;
  elements.sidebarPeriodMeta.textContent = `近 ${currentSettings.chartDays} 天`;
  for (const button of elements.periodButtons) {
    button.classList.toggle("active", Number(button.dataset.days) === Number(currentSettings.chartDays));
  }
  elements.settingsStatus.textContent = "已保存";
  applyTheme(currentSettings.theme);
}

function renderRankList(container, items, options = {}) {
  container.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无数据";
    container.append(empty);
    return;
  }

  const max = Math.max(...items.map((item) => item.value), 1);

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "rank-row";

    const label = document.createElement("span");
    label.className = "rank-label";
    label.textContent = item.name;

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
    empty.textContent = "暂无剩余用量数据";
    elements.rateLimitList.append(empty);
    elements.rateLimitUpdated.textContent = "-";
    return;
  }

  elements.rateLimitUpdated.textContent = rateLimits.updatedAt ? `更新于 ${formatDate(rateLimits.updatedAt)}` : "-";

  for (const limit of rateLimits.windows) {
    const row = document.createElement("div");
    row.className = "limit-row";

    const label = document.createElement("strong");
    label.textContent = limit.label;

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
    bar.setAttribute("aria-label", `${day.date}: ${formatCompact(day.tokens)} tokens`);
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
    <span>${formatCompact(day.tokens)} tokens</span>
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
    empty.textContent = "暂无最近会话";
    elements.recentThreads.append(empty);
    return;
  }

  for (const thread of threads) {
    const row = document.createElement("div");
    row.className = "thread-row";

    const main = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = thread.title;
    const meta = document.createElement("span");
    meta.textContent = `${thread.model} · ${thread.source} · ${formatDate(thread.updatedAt)}`;
    main.append(title, meta);

    const tokens = document.createElement("span");
    tokens.className = "thread-token";
    tokens.textContent = formatCompact(thread.tokensUsed);

    row.append(main, tokens);
    elements.recentThreads.append(row);
  }
}

function renderStats(stats) {
  const chartDays = stats.settings?.chartDays || currentSettings.chartDays;
  const mainLimit = primaryRateLimit(stats);
  renderError(stats.error);

  elements.periodCostLabel.textContent = `近 ${chartDays} 天费用`;
  elements.periodTokensLabel.textContent = `近 ${chartDays} 天 token 用量`;
  elements.activityTitle.textContent = `近 ${chartDays} 天趋势`;
  elements.overviewPeriod.textContent = `近 ${chartDays} 天`;
  elements.todayCost.textContent = formatCurrency(stats.featured.todayCost);
  elements.periodCost.textContent = formatCurrency(stats.featured.periodCost);
  elements.periodUsagePercent.textContent = Number.isFinite(stats.featured.periodUsagePercent)
    ? `${Math.round(stats.featured.periodUsagePercent)}% ${stats.account?.planLabel || ""} 使用量`
    : "按本地日志估算";
  elements.sidebarRemainingUsage.textContent = mainLimit ? formatPercent(mainLimit.remainingPercent) : "-";
  elements.sidebarPeriodMeta.textContent = mainLimit
    ? `${mainLimit.label} · ${formatResetTime(mainLimit)} 重置`
    : "等待 Codex 日志";
  elements.periodTokens.textContent = formatCompact(stats.featured.periodTokens);
  elements.latestTokenUsage.textContent = formatCompact(stats.featured.latestTokenUsage);

  elements.threadsTotal.textContent = formatCompact(stats.totals.threads);
  elements.threadsActive.textContent = formatCompact(stats.totals.activeThreads);
  elements.tokensTotal.textContent = formatCompact(stats.totals.totalTokens);
  elements.updatedThisWeek.textContent = formatCompact(stats.totals.updatedThisWeek);
  elements.lastUpdated.textContent = `更新于 ${formatDate(stats.generatedAt)}`;
  elements.accountInitials.textContent = stats.account?.initials || "CD";
  elements.accountName.textContent = stats.account?.displayName || "Codex";
  elements.accountPlan.textContent = stats.account?.planLabel || "Codex";

  renderDailyChart(stats.dailySeries);
  renderRateLimits(stats.rateLimits);
  renderRankList(elements.modelList, stats.models, { compact: true });
  renderRankList(elements.sourceList, stats.sources);
  renderRankList(elements.workspaceList, stats.workspaces, { compact: true });
  renderRecentThreads(stats.latestThreads);
}

async function refreshStats() {
  setLoading(true);
  try {
    const stats = await window.aiUsage.getCodexStats();
    renderStats(stats);
  } catch (error) {
    renderError(error.message || "无法读取 Codex 统计");
  } finally {
    setLoading(false);
  }
}

async function saveSettings(nextSettings, shouldRefresh = true) {
  currentSettings = await window.aiUsage.updateSettings({
    ...currentSettings,
    ...nextSettings
  });
  renderSettings();
  if (shouldRefresh) {
    await refreshStats();
  }
}

async function chooseCodexHome() {
  setLoading(true);
  try {
    const result = await window.aiUsage.chooseCodexHome();
    if (result) {
      currentSettings = result.settings;
      renderSettings();
      renderStats(result.stats);
    }
  } catch (error) {
    renderError(error.message || "无法切换 Codex 目录");
  } finally {
    setLoading(false);
  }
}

elements.refreshButton.addEventListener("click", refreshStats);
elements.settingsButton.addEventListener("click", () => setView("settings"));
elements.homeButton.addEventListener("click", () => setView("home"));
elements.chooseHomeButton.addEventListener("click", chooseCodexHome);
elements.themeSelect.addEventListener("change", async () => {
  await saveSettings({ theme: elements.themeSelect.value }, false);
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

async function boot() {
  currentSettings = await window.aiUsage.getSettings();
  renderSettings();
  setView(currentView);
  await refreshStats();
}

boot();
