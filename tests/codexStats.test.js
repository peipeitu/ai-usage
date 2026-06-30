const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStatsFromThreads, normalizeRateLimits, sourceLabel } = require("../src/main/codexStats");
const { estimateCodexCost } = require("../src/main/pricing");

test("sourceLabel normalizes subagent sources", () => {
  assert.equal(sourceLabel('{"subagent":{"other":"guardian"}}'), "子任务");
  assert.equal(sourceLabel("vscode"), "VS Code");
  assert.equal(sourceLabel(""), "Unknown");
});

test("buildStatsFromThreads aggregates Codex thread data", () => {
  const now = new Date("2026-06-30T12:00:00.000Z");
  const stats = buildStatsFromThreads(
    [
      {
        id: "one",
        title: "First",
        source: "vscode",
        model_provider: "openai",
        model: "gpt-5.5",
        cwd: "/work/app-one",
        archived: 0,
        tokens_used: 1200,
        created_at_ms: Date.parse("2026-06-29T10:00:00.000Z"),
        updated_at_ms: Date.parse("2026-06-30T09:00:00.000Z"),
        preview: "first"
      },
      {
        id: "two",
        title: "Second",
        source: '{"subagent":{"other":"guardian"}}',
        model_provider: "openai",
        model: "codex-auto-review",
        cwd: "/work/app-two",
        archived: 1,
        tokens_used: 300,
        created_at_ms: Date.parse("2026-06-20T10:00:00.000Z"),
        updated_at_ms: Date.parse("2026-06-21T09:00:00.000Z"),
        preview: "second"
      }
    ],
    now,
    {
      chartDays: 30,
      usageEvents: [
        {
          timestampMs: Date.parse("2026-06-30T11:00:00.000Z"),
          totalTokens: 1500,
          planType: "prolite",
          rateLimits: normalizeRateLimits(
            {
              plan_type: "prolite",
              primary: { used_percent: 8, window_minutes: 300, resets_at: 1782833640 },
              secondary: { used_percent: 6, window_minutes: 10080, resets_at: 1783478400 }
            },
            Date.parse("2026-06-30T11:00:00.000Z")
          )
        },
        {
          timestampMs: Date.parse("2026-06-20T11:00:00.000Z"),
          totalTokens: 200
        }
      ]
    }
  );

  assert.equal(stats.totals.threads, 2);
  assert.equal(stats.totals.activeThreads, 1);
  assert.equal(stats.totals.archivedThreads, 1);
  assert.equal(stats.totals.totalTokens, 1500);
  assert.equal(stats.totals.updatedThisWeek, 1);
  assert.equal(stats.settings.chartDays, 30);
  assert.equal(stats.featured.periodTokens, 1700);
  assert.equal(stats.featured.periodCost, 0.0017);
  assert.equal(stats.featured.periodUsagePercent, 0.0017);
  assert.equal(stats.rateLimits.windows[0].label, "5 小时");
  assert.equal(stats.rateLimits.windows[0].remainingPercent, 92);
  assert.equal(stats.rateLimits.windows[1].label, "1 周");
  assert.equal(stats.rateLimits.windows[1].remainingPercent, 94);
  assert.equal(stats.featured.latestTokenUsage, 1500);
  assert.equal(stats.featured.costEstimatedFromTokenEvents, true);
  assert.deepEqual(stats.models[0], { name: "gpt-5.5", value: 1200 });
  assert.deepEqual(stats.sources[0], { name: "VS Code", value: 1 });
  assert.equal(stats.dailySeries.length, 30);
  assert.equal(stats.dailySeries.at(-2).threads, 1);
  assert.equal(stats.latestThreads[0].id, "one");
});

test("estimateCodexCost uses CodexBar-compatible total token estimate", () => {
  assert.equal(estimateCodexCost(369_000_000), 369);
});
