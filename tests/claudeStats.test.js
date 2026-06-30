const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildClaudeStatsFromSessions, readClaudeSession, usageTotal } = require("../src/main/claudeStats");

test("usageTotal includes Claude Code cache and output tokens", () => {
  assert.equal(
    usageTotal({
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40
    }),
    100
  );
});

test("buildClaudeStatsFromSessions aggregates Claude Code sessions", () => {
  const now = new Date("2026-06-30T12:00:00.000Z");
  const stats = buildClaudeStatsFromSessions(
    [
      {
        id: "one",
        title: "First Claude session",
        source: "Claude Code",
        provider: "Anthropic",
        model: "claude-opus-4-8",
        cwd: "/work/app-one",
        archived: false,
        tokensUsed: 1200,
        createdAtMs: Date.parse("2026-06-29T10:00:00.000Z"),
        updatedAtMs: Date.parse("2026-06-30T09:00:00.000Z"),
        usageEvents: [
          {
            threadId: "one",
            timestampMs: Date.parse("2026-06-30T11:00:00.000Z"),
            model: "claude-opus-4-8",
            totalTokens: 900
          },
          {
            threadId: "one",
            timestampMs: Date.parse("2026-06-29T11:00:00.000Z"),
            model: "claude-opus-4-8",
            totalTokens: 300
          }
        ]
      },
      {
        id: "two",
        title: "Second Claude session",
        source: "子任务",
        provider: "Anthropic",
        model: "claude-sonnet-4-5",
        cwd: "/work/app-two",
        archived: false,
        tokensUsed: 400,
        createdAtMs: Date.parse("2026-06-20T10:00:00.000Z"),
        updatedAtMs: Date.parse("2026-06-20T11:00:00.000Z"),
        usageEvents: [
          {
            threadId: "two",
            timestampMs: Date.parse("2026-06-20T11:00:00.000Z"),
            model: "claude-sonnet-4-5",
            totalTokens: 400
          }
        ]
      }
    ],
    now,
    { chartDays: 30 }
  );

  assert.equal(stats.account.planLabel, "Claude Code");
  assert.equal(stats.totals.threads, 2);
  assert.equal(stats.totals.activeThreads, 2);
  assert.equal(stats.totals.totalTokens, 1600);
  assert.equal(stats.totals.updatedThisWeek, 1);
  assert.equal(stats.featured.periodTokens, 1600);
  assert.equal(stats.featured.latestTokenUsage, 900);
  assert.equal(stats.dailySeries.length, 30);
  assert.equal(stats.dailySeries.at(-1).tokens, 900);
  assert.equal(stats.dailySeries.at(-2).threads, 1);
  assert.deepEqual(stats.models[0], { name: "claude-opus-4-8", value: 1200 });
  assert.deepEqual(stats.sources[0], { name: "Claude Code", value: 1 });
  assert.equal(stats.latestThreads[0].id, "one");
});

test("readClaudeSession deduplicates repeated assistant message updates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-claude-"));
  const file = path.join(dir, "session-one.jsonl");
  const rows = [
    {
      type: "custom-title",
      customTitle: "Dedup session",
      sessionId: "session-one"
    },
    {
      type: "user",
      timestamp: "2026-06-30T10:00:00.000Z",
      sessionId: "session-one",
      cwd: "/work/app",
      entrypoint: "cli",
      message: { role: "user", content: "hello" }
    },
    {
      type: "assistant",
      timestamp: "2026-06-30T10:00:10.000Z",
      sessionId: "session-one",
      cwd: "/work/app",
      message: {
        id: "msg-one",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40
        }
      }
    },
    {
      type: "assistant",
      timestamp: "2026-06-30T10:00:12.000Z",
      sessionId: "session-one",
      cwd: "/work/app",
      message: {
        id: "msg-one",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40
        }
      }
    }
  ];

  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await readClaudeSession(file);

  assert.equal(session.id, "session-one");
  assert.equal(session.title, "Dedup session");
  assert.equal(session.source, "CLI");
  assert.equal(session.tokensUsed, 100);
  assert.equal(session.usageEvents.length, 1);
});
