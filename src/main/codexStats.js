const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { formatPlanType, planMonthlyUsd, readCodexAccount } = require("./accountInfo");
const { getCodexDatabasePaths } = require("./codexPaths");
const { PRICING_SOURCE, estimateCodexCost } = require("./pricing");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHART_DAYS = 30;

let sqlPromise;

function getSql() {
  if (!sqlPromise) {
    const initSqlJs = require("sql.js");
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(__dirname, "..", "..", "node_modules", "sql.js", "dist", file)
    });
  }

  return sqlPromise;
}

function rowsFromQuery(db, query, params = []) {
  const statement = db.prepare(query);
  statement.bind(params);

  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();

  return rows;
}

function openReadOnlyDatabase(SQL, dbPath) {
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  return new SQL.Database(fs.readFileSync(dbPath));
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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

function sourceLabel(value) {
  if (!value) return "Unknown";

  try {
    const parsed = JSON.parse(value);
    if (parsed.subagent) return "子任务";
  } catch {
    // Plain source names are expected.
  }

  if (String(value).toLowerCase() === "vscode") return "VS Code";
  return String(value);
}

function normalizeThread(row) {
  const createdAtMs = Number(row.created_at_ms || row.created_at * 1000 || 0);
  const updatedAtMs = Number(row.updated_at_ms || row.updated_at * 1000 || createdAtMs);

  return {
    id: row.id,
    title: row.title || "Untitled",
    source: sourceLabel(row.source),
    provider: row.model_provider || "Unknown",
    model: row.model || "Unknown",
    cwd: row.cwd || "",
    archived: Number(row.archived) === 1,
    tokensUsed: Number(row.tokens_used || 0),
    createdAtMs,
    updatedAtMs,
    rolloutPath: row.rollout_path || "",
    preview: row.preview || ""
  };
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
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

function rateLimitWindowLabel(windowMinutes) {
  const minutes = Number(windowMinutes || 0);
  if (minutes === 300) return "5 小时";
  if (minutes === 10080) return "1 周";
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080} 周`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function normalizeRateLimitWindow(id, window) {
  if (!window) return null;

  const usedPercent = clampNumber(window.used_percent, 0, 0, 100);
  const windowMinutes = Number(window.window_minutes || 0);
  const resetsAtMs = Number(window.resets_at || 0) * 1000;

  return {
    id,
    label: rateLimitWindowLabel(windowMinutes),
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt: Number.isFinite(resetsAtMs) && resetsAtMs > 0 ? new Date(resetsAtMs).toISOString() : null
  };
}

function normalizeRateLimits(rateLimits, timestampMs) {
  if (!rateLimits) return null;

  return {
    updatedAt: safeDate(timestampMs)?.toISOString() || null,
    planType: rateLimits.plan_type || null,
    reachedType: rateLimits.rate_limit_reached_type || null,
    windows: [
      normalizeRateLimitWindow("primary", rateLimits.primary),
      normalizeRateLimitWindow("secondary", rateLimits.secondary)
    ].filter(Boolean)
  };
}

async function readTokenUsageEvents(threads) {
  const events = [];

  for (const thread of threads) {
    if (!thread.rolloutPath || !fs.existsSync(thread.rolloutPath)) continue;

    const stream = fs.createReadStream(thread.rolloutPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;

      try {
        const entry = JSON.parse(line);
        if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;

        const usage = entry.payload.info?.last_token_usage;
        if (!usage) continue;

        events.push({
          threadId: thread.id,
          timestampMs: Date.parse(entry.timestamp),
          model: thread.model,
          inputTokens: Number(usage.input_tokens || 0),
          cachedInputTokens: Number(usage.cached_input_tokens || 0),
          outputTokens: Number(usage.output_tokens || 0),
          totalTokens: Number(usage.total_tokens || 0),
          planType: entry.payload.rate_limits?.plan_type || null,
          rateLimits: normalizeRateLimits(entry.payload.rate_limits, Date.parse(entry.timestamp))
        });
      } catch {
        // Ignore malformed historical log lines.
      }
    }
  }

  return events.filter((event) => Number.isFinite(event.timestampMs));
}

function buildStatsFromThreads(threads, now = new Date(), options = {}) {
  const chartDays = Math.round(clampNumber(options.chartDays, DEFAULT_CHART_DAYS, 7, 365));
  const usageEvents = Array.isArray(options.usageEvents) ? options.usageEvents : [];
  const normalized = threads.map(normalizeThread);
  const activeThreads = normalized.filter((thread) => !thread.archived);
  const totalTokens = normalized.reduce((sum, thread) => sum + thread.tokensUsed, 0);
  const recentThreshold = now.getTime() - 7 * DAY_MS;
  const updatedThisWeek = normalized.filter((thread) => thread.updatedAtMs >= recentThreshold).length;
  const todayStartMs = startOfLocalDay(now);
  const periodStartMs = todayStartMs - (chartDays - 1) * DAY_MS;
  const periodEvents = usageEvents.filter((event) => event.timestampMs >= periodStartMs);
  const todayEvents = usageEvents.filter((event) => event.timestampMs >= todayStartMs);
  const hasUsageEvents = usageEvents.length > 0;
  const todayTokens = hasUsageEvents
    ? todayEvents.reduce((sum, event) => sum + event.totalTokens, 0)
    : normalized.filter((thread) => thread.createdAtMs >= todayStartMs).reduce((sum, thread) => sum + thread.tokensUsed, 0);
  const periodTokens = hasUsageEvents
    ? periodEvents.reduce((sum, event) => sum + event.totalTokens, 0)
    : normalized.filter((thread) => thread.createdAtMs >= periodStartMs).reduce((sum, thread) => sum + thread.tokensUsed, 0);
  const todayCost = estimateCodexCost(todayTokens);
  const periodCost = estimateCodexCost(periodTokens);
  const latestPlanType = usageEvents
    .slice()
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .find((event) => event.planType)?.planType;
  const latestRateLimits = usageEvents
    .slice()
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .find((event) => event.rateLimits)?.rateLimits || null;
  const planMonthlyCost = planMonthlyUsd(latestPlanType);
  const periodUsagePercent = planMonthlyCost ? (periodCost / planMonthlyCost) * 100 : null;

  const dailySeries = buildEmptyDailySeries(chartDays, now);
  const dailyByDate = new Map(dailySeries.map((day) => [day.date, day]));

  for (const thread of normalized) {
    const createdAt = safeDate(thread.createdAtMs);
    if (!createdAt) continue;

    const key = localDateKey(createdAt);
    const day = dailyByDate.get(key);
    if (!day) continue;

    day.threads += 1;
    if (!hasUsageEvents) {
      day.tokens += thread.tokensUsed;
    }
  }

  for (const event of periodEvents) {
    const eventDate = safeDate(event.timestampMs);
    if (!eventDate) continue;

    const key = localDateKey(eventDate);
    const day = dailyByDate.get(key);
    if (!day) continue;

    day.tokens += event.totalTokens;
    day.cost = estimateCodexCost(day.tokens);
  }

  const models = sumBy(normalized, (thread) => thread.model, (thread) => thread.tokensUsed || 0).slice(0, 6);
  const sources = sumBy(normalized, (thread) => thread.source).slice(0, 6);
  const workspaces = sumBy(
    normalized.filter((thread) => thread.cwd),
    (thread) => path.basename(thread.cwd) || thread.cwd,
    (thread) => thread.tokensUsed || 0
  ).slice(0, 6);

  const latestThreads = normalized
    .slice()
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, 8)
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      model: thread.model,
      source: thread.source,
      tokensUsed: thread.tokensUsed,
      updatedAt: safeDate(thread.updatedAtMs)?.toISOString() || null,
      cwd: thread.cwd
    }));
  const latestTokenUsage = todayTokens || (hasUsageEvents
    ? usageEvents.slice().sort((a, b) => b.timestampMs - a.timestampMs)[0]?.totalTokens || 0
    : latestThreads[0]?.tokensUsed || 0);

  return {
    generatedAt: now.toISOString(),
    account: {
      planType: latestPlanType || null,
      planLabel: formatPlanType(latestPlanType),
      planMonthlyUsd: planMonthlyCost
    },
    settings: {
      chartDays
    },
    pricing: PRICING_SOURCE,
    featured: {
      todayCost,
      periodCost,
      periodTokens,
      latestTokenUsage,
      periodUsagePercent,
      costEstimatedFromTokenEvents: hasUsageEvents
    },
    rateLimits: latestRateLimits,
    totals: {
      threads: normalized.length,
      activeThreads: activeThreads.length,
      archivedThreads: normalized.length - activeThreads.length,
      totalTokens,
      updatedThisWeek
    },
    dailySeries,
    models,
    sources,
    workspaces,
    latestThreads
  };
}

async function readCodexStats(options = {}) {
  const paths = getCodexDatabasePaths(options.codexHome);
  const SQL = await getSql();
  const stateDb = openReadOnlyDatabase(SQL, paths.stateDbPath);

  if (!stateDb) {
    return {
      generatedAt: new Date().toISOString(),
      error: `Codex state database not found at ${paths.stateDbPath}`,
      paths,
      account: {
        ...readCodexAccount(paths.codexHome),
        planType: null,
        planLabel: "Codex"
      },
      totals: {
        threads: 0,
        activeThreads: 0,
        archivedThreads: 0,
        totalTokens: 0,
        updatedThisWeek: 0
      },
      featured: {
        todayCost: 0,
        periodCost: 0,
        periodTokens: 0,
        latestTokenUsage: 0
      },
      rateLimits: null,
      dailySeries: buildEmptyDailySeries(options.chartDays || DEFAULT_CHART_DAYS),
      models: [],
      sources: [],
      workspaces: [],
      latestThreads: []
    };
  }

  try {
    const threads = rowsFromQuery(
      stateDb,
      `select
        id,
        title,
        source,
        model_provider,
        model,
        cwd,
        archived,
        tokens_used,
        rollout_path,
        created_at,
        updated_at,
        created_at_ms,
        updated_at_ms,
        preview
      from threads`
    );

    const stats = buildStatsFromThreads(threads, new Date(), {
        ...options,
        usageEvents: await readTokenUsageEvents(threads.map(normalizeThread))
      });

    return {
      ...stats,
      account: {
        ...readCodexAccount(paths.codexHome),
        ...stats.account
      },
      paths
    };
  } finally {
    stateDb.close();
  }
}

module.exports = {
  buildStatsFromThreads,
  readTokenUsageEvents,
  readCodexStats,
  normalizeThread,
  normalizeRateLimits,
  sourceLabel,
  DEFAULT_CHART_DAYS
};
