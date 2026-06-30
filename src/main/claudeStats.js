const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { getClaudePaths, listClaudeSessionFiles } = require("./claudePaths");
const { estimateCodexCost } = require("./pricing");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHART_DAYS = 30;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayLabel(dateKey) {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function buildEmptyDailySeries(days = DEFAULT_CHART_DAYS, now = new Date()) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(startOfLocalDay(now) - (days - index - 1) * DAY_MS);
    const key = localDateKey(date);

    return {
      date: key,
      label: formatDayLabel(key),
      threads: 0,
      tokens: 0,
      cost: 0
    };
  });
}

function sumBy(items, keyFn, valueFn = () => 1) {
  const totals = new Map();

  for (const item of items) {
    const key = keyFn(item);
    totals.set(key, (totals.get(key) || 0) + valueFn(item));
  }

  return Array.from(totals.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function initialsFromName(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "CC";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function usageTotal(usage = {}) {
  return (
    Number(usage.input_tokens || 0) +
    Number(usage.cache_creation_input_tokens || 0) +
    Number(usage.cache_read_input_tokens || 0) +
    Number(usage.output_tokens || 0)
  );
}

function normalizeSource(value) {
  if (!value) return "Claude Code";
  if (String(value).toLowerCase() === "cli") return "CLI";
  if (String(value).toLowerCase() === "vscode") return "VS Code";
  return String(value);
}

function bestModel(modelTotals) {
  let best = "Unknown";
  let max = -1;

  for (const [model, tokens] of modelTotals.entries()) {
    if (tokens > max) {
      best = model;
      max = tokens;
    }
  }

  return best;
}

function sessionIdFromFile(filePath) {
  return path.basename(filePath, ".jsonl");
}

async function readClaudeSession(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const stat = fs.statSync(filePath);
  const usageByMessage = new Map();
  const modelTotals = new Map();
  const eventsByMessage = new Map();
  let id = sessionIdFromFile(filePath);
  let title = "";
  let cwd = "";
  let source = "";
  let createdAtMs = null;
  let updatedAtMs = null;
  let sidechain = false;

  for await (const line of lines) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.sessionId) id = String(entry.sessionId);
    if (!title && entry.customTitle) title = String(entry.customTitle);
    if (!title && entry.aiTitle) title = String(entry.aiTitle);
    if (!cwd && entry.cwd) cwd = String(entry.cwd);
    if (!source && (entry.entrypoint || entry.promptSource)) {
      source = normalizeSource(entry.entrypoint || entry.promptSource);
    }
    if (entry.isSidechain) sidechain = true;

    const timestampMs = Date.parse(entry.timestamp);
    if (Number.isFinite(timestampMs)) {
      createdAtMs = createdAtMs == null ? timestampMs : Math.min(createdAtMs, timestampMs);
      updatedAtMs = updatedAtMs == null ? timestampMs : Math.max(updatedAtMs, timestampMs);
    }

    const usage = entry.message?.usage;
    if (entry.type !== "assistant" || !usage) continue;

    const totalTokens = usageTotal(usage);
    if (totalTokens <= 0) continue;

    const messageId = entry.message.id || entry.uuid || `${id}:${timestampMs}:${usageByMessage.size}`;
    const model = entry.message.model || "Unknown";
    const previous = usageByMessage.get(messageId);
    const event = {
      threadId: id,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : updatedAtMs,
      model,
      inputTokens: Number(usage.input_tokens || 0),
      cachedInputTokens: Number(usage.cache_read_input_tokens || 0),
      cacheCreationTokens: Number(usage.cache_creation_input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      totalTokens
    };

    if (!previous || event.timestampMs >= previous.timestampMs) {
      usageByMessage.set(messageId, event);
    }
  }

  for (const event of usageByMessage.values()) {
    modelTotals.set(event.model, (modelTotals.get(event.model) || 0) + event.totalTokens);
    eventsByMessage.set(`${event.threadId}:${event.model}:${event.timestampMs}:${event.totalTokens}`, event);
  }

  const usageEvents = Array.from(eventsByMessage.values()).filter((event) => Number.isFinite(event.timestampMs));
  const tokensUsed = usageEvents.reduce((sum, event) => sum + event.totalTokens, 0);
  const fallbackTimeMs = Number(stat.mtimeMs || stat.birthtimeMs || 0);

  return {
    id,
    title: title || `Claude session ${id.slice(0, 8)}`,
    source: source || (sidechain ? "子任务" : "Claude Code"),
    provider: "Anthropic",
    model: bestModel(modelTotals),
    cwd,
    archived: false,
    tokensUsed,
    createdAtMs: createdAtMs == null ? fallbackTimeMs : createdAtMs,
    updatedAtMs: updatedAtMs == null ? fallbackTimeMs : updatedAtMs,
    rolloutPath: filePath,
    preview: "",
    usageEvents
  };
}

function buildClaudeStatsFromSessions(sessions, now = new Date(), options = {}) {
  const chartDays = Math.round(clampNumber(options.chartDays, DEFAULT_CHART_DAYS, 7, 365));
  const totalTokens = sessions.reduce((sum, session) => sum + session.tokensUsed, 0);
  const recentThreshold = now.getTime() - 7 * DAY_MS;
  const updatedThisWeek = sessions.filter((session) => session.updatedAtMs >= recentThreshold).length;
  const usageEvents = sessions.flatMap((session) => session.usageEvents || []);
  const todayStartMs = startOfLocalDay(now);
  const periodStartMs = todayStartMs - (chartDays - 1) * DAY_MS;
  const periodEvents = usageEvents.filter((event) => event.timestampMs >= periodStartMs);
  const todayEvents = usageEvents.filter((event) => event.timestampMs >= todayStartMs);
  const todayTokens = todayEvents.reduce((sum, event) => sum + event.totalTokens, 0);
  const periodTokens = periodEvents.reduce((sum, event) => sum + event.totalTokens, 0);
  const todayCost = estimateCodexCost(todayTokens);
  const periodCost = estimateCodexCost(periodTokens);
  const dailySeries = buildEmptyDailySeries(chartDays, now);
  const dailyByDate = new Map(dailySeries.map((day) => [day.date, day]));

  for (const session of sessions) {
    const createdAt = safeDate(session.createdAtMs);
    if (!createdAt) continue;

    const day = dailyByDate.get(localDateKey(createdAt));
    if (day) day.threads += 1;
  }

  for (const event of periodEvents) {
    const eventDate = safeDate(event.timestampMs);
    if (!eventDate) continue;

    const day = dailyByDate.get(localDateKey(eventDate));
    if (!day) continue;

    day.tokens += event.totalTokens;
    day.cost = estimateCodexCost(day.tokens);
  }

  const latestThreads = sessions
    .slice()
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, 8)
    .map((session) => ({
      id: session.id,
      title: session.title,
      model: session.model,
      source: session.source,
      tokensUsed: session.tokensUsed,
      updatedAt: safeDate(session.updatedAtMs)?.toISOString() || null,
      cwd: session.cwd
    }));

  return {
    generatedAt: now.toISOString(),
    account: {
      displayName: "Claude Code",
      initials: initialsFromName("Claude Code"),
      planType: null,
      planLabel: "Claude Code",
      planMonthlyUsd: null
    },
    settings: {
      chartDays
    },
    pricing: {
      label: "Local token estimate",
      checkedAt: "2026-06-30"
    },
    featured: {
      todayCost,
      periodCost,
      periodTokens,
      latestTokenUsage: todayTokens || usageEvents.slice().sort((a, b) => b.timestampMs - a.timestampMs)[0]?.totalTokens || 0,
      periodUsagePercent: null,
      costEstimatedFromTokenEvents: true
    },
    rateLimits: null,
    totals: {
      threads: sessions.length,
      activeThreads: sessions.length,
      archivedThreads: 0,
      totalTokens,
      updatedThisWeek
    },
    dailySeries,
    models: sumBy(sessions, (session) => session.model, (session) => session.tokensUsed || 0).slice(0, 6),
    sources: sumBy(sessions, (session) => session.source).slice(0, 6),
    workspaces: sumBy(
      sessions.filter((session) => session.cwd),
      (session) => path.basename(session.cwd) || session.cwd,
      (session) => session.tokensUsed || 0
    ).slice(0, 6),
    latestThreads
  };
}

async function readClaudeStats(options = {}) {
  const paths = getClaudePaths(options.claudeHome);
  const files = listClaudeSessionFiles(paths.projectsPath);

  if (files.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      error: `Claude Code session logs not found at ${paths.projectsPath}`,
      paths,
      account: {
        displayName: "Claude Code",
        initials: "CC",
        planType: null,
        planLabel: "Claude Code",
        planMonthlyUsd: null
      },
      settings: {
        chartDays: Math.round(clampNumber(options.chartDays, DEFAULT_CHART_DAYS, 7, 365))
      },
      featured: {
        todayCost: 0,
        periodCost: 0,
        periodTokens: 0,
        latestTokenUsage: 0,
        periodUsagePercent: null,
        costEstimatedFromTokenEvents: true
      },
      rateLimits: null,
      totals: {
        threads: 0,
        activeThreads: 0,
        archivedThreads: 0,
        totalTokens: 0,
        updatedThisWeek: 0
      },
      dailySeries: buildEmptyDailySeries(options.chartDays || DEFAULT_CHART_DAYS),
      models: [],
      sources: [],
      workspaces: [],
      latestThreads: []
    };
  }

  const sessions = [];

  for (const file of files) {
    sessions.push(await readClaudeSession(file));
  }

  return {
    ...buildClaudeStatsFromSessions(sessions, new Date(), options),
    paths
  };
}

module.exports = {
  buildClaudeStatsFromSessions,
  readClaudeSession,
  readClaudeStats,
  usageTotal,
  DEFAULT_CHART_DAYS
};
