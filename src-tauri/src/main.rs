use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Command,
};

use base64::{engine::general_purpose, Engine};
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use walkdir::WalkDir;

const DEFAULT_CHART_DAYS: u32 = 30;
const CODEX_USD_PER_MILLION_TOKENS: f64 = 1.0;
const CLAUDE_ESTIMATED_5H_TOKEN_LIMIT: u64 = 500_000;
const CLAUDE_ESTIMATED_WEEKLY_TOKEN_LIMIT: u64 = 2_500_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    active_provider: String,
    #[serde(default = "default_enabled_providers")]
    enabled_providers: Vec<String>,
    #[serde(default)]
    codex_home: String,
    #[serde(default)]
    claude_home: String,
    #[serde(default)]
    copilot_home: String,
    #[serde(default)]
    cursor_home: String,
    #[serde(default = "default_language")]
    language: String,
    theme: String,
    accent_color: String,
    chart_days: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    display_name: String,
    initials: String,
    plan_type: Option<String>,
    plan_label: String,
    plan_monthly_usd: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartSettings {
    chart_days: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pricing {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    checked_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Featured {
    today_cost: f64,
    period_cost: f64,
    period_tokens: u64,
    latest_token_usage: u64,
    period_usage_percent: Option<f64>,
    cost_estimated_from_token_events: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    threads: usize,
    active_threads: usize,
    archived_threads: usize,
    total_tokens: u64,
    updated_this_week: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyPoint {
    date: String,
    label: String,
    threads: u64,
    tokens: u64,
    cost: f64,
}

#[derive(Clone, Debug, Serialize)]
struct RankItem {
    name: String,
    value: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatestThread {
    id: String,
    title: String,
    model: String,
    source: String,
    tokens_used: u64,
    updated_at: Option<String>,
    cwd: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitWindow {
    id: String,
    label: String,
    used_percent: f64,
    remaining_percent: f64,
    window_minutes: u64,
    resets_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RateLimits {
    updated_at: Option<String>,
    plan_type: Option<String>,
    reached_type: Option<String>,
    windows: Vec<RateLimitWindow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    account: Account,
    settings: ChartSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pricing: Option<Pricing>,
    featured: Featured,
    rate_limits: Option<RateLimits>,
    totals: Totals,
    daily_series: Vec<DailyPoint>,
    models: Vec<RankItem>,
    sources: Vec<RankItem>,
    workspaces: Vec<RankItem>,
    latest_threads: Vec<LatestThread>,
    paths: Value,
}

#[derive(Clone, Debug)]
struct Thread {
    id: String,
    title: String,
    source: String,
    model: String,
    cwd: String,
    archived: bool,
    tokens_used: u64,
    created_at_ms: i64,
    updated_at_ms: i64,
    rollout_path: String,
    usage_events: Vec<UsageEvent>,
}

#[derive(Clone, Debug)]
struct UsageEvent {
    thread_id: String,
    timestamp_ms: i64,
    model: String,
    total_tokens: u64,
    plan_type: Option<String>,
    rate_limits: Option<RateLimits>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChooseHomeResult {
    settings: Settings,
    stats: Stats,
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn default_settings() -> Settings {
    Settings {
        active_provider: "codex".to_string(),
        enabled_providers: default_enabled_providers(),
        codex_home: String::new(),
        claude_home: String::new(),
        copilot_home: String::new(),
        cursor_home: String::new(),
        language: default_language(),
        theme: "system".to_string(),
        accent_color: "blue".to_string(),
        chart_days: DEFAULT_CHART_DAYS,
    }
}

fn default_language() -> String {
    "auto".to_string()
}

fn default_enabled_providers() -> Vec<String> {
    ["codex", "claude", "copilot", "cursor"]
        .iter()
        .map(|provider| provider.to_string())
        .collect()
}

fn normalize_settings(settings: Settings) -> Settings {
    let providers = ["codex", "claude", "copilot", "cursor"];
    let languages = ["auto", "zh", "en"];
    let themes = ["system", "light", "dark"];
    let accents = [
        "blue",
        "turquoise",
        "green",
        "purple",
        "red",
        "orange",
        "graphite",
    ];

    let mut enabled_providers = Vec::new();
    for provider in settings.enabled_providers {
        if providers.contains(&provider.as_str()) && !enabled_providers.contains(&provider) {
            enabled_providers.push(provider);
        }
    }
    if enabled_providers.is_empty() {
        enabled_providers = default_enabled_providers();
    }

    let active_provider = if providers.contains(&settings.active_provider.as_str())
        && enabled_providers.contains(&settings.active_provider)
    {
        settings.active_provider
    } else {
        enabled_providers
            .first()
            .cloned()
            .unwrap_or_else(|| "codex".to_string())
    };

    Settings {
        active_provider,
        enabled_providers,
        codex_home: settings.codex_home,
        claude_home: settings.claude_home,
        copilot_home: settings.copilot_home,
        cursor_home: settings.cursor_home,
        language: if languages.contains(&settings.language.as_str()) {
            settings.language
        } else {
            default_language()
        },
        theme: if themes.contains(&settings.theme.as_str()) {
            settings.theme
        } else {
            "system".to_string()
        },
        accent_color: if accents.contains(&settings.accent_color.as_str()) {
            settings.accent_color
        } else {
            "blue".to_string()
        },
        chart_days: settings.chart_days.clamp(7, 365),
    }
}

fn settings_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| home_dir().join(".config"))
        .join("ai-usage")
        .join("settings.json")
}

fn load_settings() -> Settings {
    let path = settings_path();
    let Ok(content) = fs::read_to_string(path) else {
        return default_settings();
    };

    serde_json::from_str::<Settings>(&content)
        .map(normalize_settings)
        .unwrap_or_else(|_| default_settings())
}

fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, format!("{content}\n")).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_settings() -> Settings {
    load_settings()
}

#[tauri::command]
fn update_settings(settings: Settings) -> Result<Settings, String> {
    let settings = normalize_settings(settings);
    save_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
async fn get_stats(provider: Option<String>) -> Result<Stats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings();
        let provider = provider.unwrap_or_else(|| settings.active_provider.clone());
        read_stats_for_provider(&settings, &provider)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn choose_home(provider: String) -> Result<Option<ChooseHomeResult>, String> {
    let provider = match provider.as_str() {
        "claude" => "claude",
        "copilot" => "copilot",
        "cursor" => "cursor",
        _ => "codex",
    }
    .to_string();
    let title = match provider.as_str() {
        "claude" => "Select Claude Code data directory",
        "copilot" => "Select GitHub Copilot data directory",
        "cursor" => "Select Cursor data directory",
        _ => "Select Codex data directory",
    };

    let Some(folder) = rfd::FileDialog::new().set_title(title).pick_folder() else {
        return Ok(None);
    };

    let folder = folder.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = load_settings();
        settings.active_provider = provider.clone();
        match provider.as_str() {
            "claude" => settings.claude_home = folder,
            "copilot" => settings.copilot_home = folder,
            "cursor" => settings.cursor_home = folder,
            _ => settings.codex_home = folder,
        }
        settings = normalize_settings(settings);
        save_settings(&settings)?;
        let stats = read_stats_for_provider(&settings, &provider)?;

        Ok(Some(ChooseHomeResult { settings, stats }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let allowed_urls = [
        "https://github.com/peipeitu/ai-usage",
        "https://github.com/peipeitu/ai-usage/issues",
    ];

    if !allowed_urls.contains(&url.as_str()) {
        return Err("URL is not allowed".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&url).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", &url]).status();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&url).status();

    status
        .map_err(|error| error.to_string())
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or_else(|| "Unable to open URL".to_string())
        })
}

fn read_stats_for_provider(settings: &Settings, provider: &str) -> Result<Stats, String> {
    match provider {
        "claude" => read_claude_stats(settings),
        "copilot" => read_copilot_stats(settings),
        "cursor" => read_cursor_stats(settings),
        _ => read_codex_stats(settings),
    }
}

fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn iso_from_ms(ms: i64) -> Option<String> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn estimate_cost(tokens: u64) -> f64 {
    (tokens as f64 / 1_000_000.0) * CODEX_USD_PER_MILLION_TOKENS
}

fn start_of_local_day_ms(now: DateTime<Local>) -> i64 {
    Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .unwrap_or(now)
        .timestamp_millis()
}

fn local_date_key(ms: i64) -> Option<String> {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn build_empty_daily_series(days: u32, now: DateTime<Local>) -> Vec<DailyPoint> {
    let today = Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .unwrap_or(now);

    (0..days)
        .map(|index| {
            let date = today - Duration::days((days - index - 1) as i64);
            DailyPoint {
                date: date.format("%Y-%m-%d").to_string(),
                label: format!("{}/{}", date.month(), date.day()),
                threads: 0,
                tokens: 0,
                cost: 0.0,
            }
        })
        .collect()
}

fn rank_by_tokens(items: impl IntoIterator<Item = (String, u64)>, limit: usize) -> Vec<RankItem> {
    let mut totals: HashMap<String, u64> = HashMap::new();
    for (name, value) in items {
        *totals.entry(name).or_default() += value;
    }

    let mut items: Vec<_> = totals
        .into_iter()
        .map(|(name, value)| RankItem { name, value })
        .collect();
    items.sort_by(|a, b| b.value.cmp(&a.value));
    items.truncate(limit);
    items
}

fn format_plan_type(plan_type: Option<&str>) -> String {
    let Some(plan_type) = plan_type else {
        return "Codex".to_string();
    };

    let normalized = plan_type.trim().to_lowercase();
    if normalized == "prolite" {
        return "Pro".to_string();
    }

    let mut chars = normalized.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Codex".to_string(),
    }
}

fn plan_monthly_usd(plan_type: Option<&str>) -> Option<f64> {
    match plan_type.unwrap_or("").trim().to_lowercase().as_str() {
        "free" => Some(0.0),
        "go" => Some(8.0),
        "plus" => Some(20.0),
        "pro" | "prolite" => Some(100.0),
        "business" | "team" => Some(20.0),
        _ => None,
    }
}

fn initials_from_name(name: &str, fallback: &str) -> String {
    let initials: String = name
        .split_whitespace()
        .filter_map(|part| part.chars().next())
        .take(2)
        .flat_map(|character| character.to_uppercase())
        .collect();

    if initials.is_empty() {
        fallback.to_string()
    } else {
        initials
    }
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn read_codex_account(codex_home: &Path, latest_plan_type: Option<&str>) -> Account {
    let auth_path = codex_home.join("auth.json");
    let claims = fs::read_to_string(auth_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|auth| {
            auth.pointer("/tokens/id_token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .and_then(|token| decode_jwt_payload(&token));

    let display_name = claims
        .as_ref()
        .and_then(|claims| {
            claims
                .get("name")
                .or_else(|| claims.get("nickname"))
                .or_else(|| claims.get("email"))
                .and_then(Value::as_str)
        })
        .unwrap_or("Codex")
        .to_string();

    Account {
        initials: initials_from_name(&display_name, "CD"),
        display_name,
        plan_type: latest_plan_type.map(str::to_string),
        plan_label: format_plan_type(latest_plan_type),
        plan_monthly_usd: plan_monthly_usd(latest_plan_type),
    }
}

fn source_label(value: Option<&str>) -> String {
    let Some(value) = value else {
        return "Unknown".to_string();
    };

    if let Ok(parsed) = serde_json::from_str::<Value>(value) {
        if parsed.get("subagent").is_some() {
            return "子任务".to_string();
        }
    }

    if value.eq_ignore_ascii_case("vscode") {
        "VS Code".to_string()
    } else if value.is_empty() {
        "Unknown".to_string()
    } else {
        value.to_string()
    }
}

fn codex_home(settings: &Settings) -> PathBuf {
    if !settings.codex_home.trim().is_empty() {
        return PathBuf::from(&settings.codex_home);
    }
    if let Ok(value) = env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    home_dir().join(".codex")
}

fn first_existing(paths: &[PathBuf]) -> PathBuf {
    paths
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| paths[0].clone())
}

fn codex_paths(settings: &Settings) -> (PathBuf, PathBuf, Value) {
    let home = codex_home(settings);
    let state_db = first_existing(&[
        home.join("state_5.sqlite"),
        home.join("sqlite").join("state_5.sqlite"),
    ]);
    let logs_db = first_existing(&[
        home.join("logs_2.sqlite"),
        home.join("sqlite").join("logs_2.sqlite"),
    ]);

    let paths = json!({
      "codexHome": home.to_string_lossy(),
      "stateDbPath": state_db.to_string_lossy(),
      "logsDbPath": logs_db.to_string_lossy(),
      "sessionIndexPath": home.join("session_index.jsonl").to_string_lossy()
    });

    (home, state_db, paths)
}

fn read_codex_threads(db_path: &Path) -> Result<Vec<Thread>, String> {
    let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let mut statement = connection
    .prepare(
      "select id, title, source, model_provider, model, cwd, archived, tokens_used, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, preview from threads",
    )
    .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            let created_at_ms: Option<i64> = row.get(11)?;
            let updated_at_ms: Option<i64> = row.get(12)?;
            let created_at: Option<i64> = row.get(9)?;
            let updated_at: Option<i64> = row.get(10)?;
            let created = created_at_ms.unwrap_or_else(|| created_at.unwrap_or(0) * 1000);
            let updated =
                updated_at_ms.unwrap_or_else(|| updated_at.unwrap_or(created / 1000) * 1000);
            let source: Option<String> = row.get(2)?;

            Ok(Thread {
                id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                title: row
                    .get::<_, Option<String>>(1)?
                    .unwrap_or_else(|| "Untitled".to_string()),
                source: source_label(source.as_deref()),
                model: row
                    .get::<_, Option<String>>(4)?
                    .unwrap_or_else(|| "Unknown".to_string()),
                cwd: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                archived: row.get::<_, Option<i64>>(6)?.unwrap_or(0) == 1,
                tokens_used: row.get::<_, Option<u64>>(7)?.unwrap_or(0),
                rollout_path: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                created_at_ms: created,
                updated_at_ms: updated,
                usage_events: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn rate_limit_window_label(minutes: u64) -> String {
    if minutes == 300 {
        "5 小时".to_string()
    } else if minutes == 10080 {
        "1 周".to_string()
    } else if minutes >= 10080 && minutes % 10080 == 0 {
        format!("{} 周", minutes / 10080)
    } else if minutes >= 1440 && minutes % 1440 == 0 {
        format!("{} 天", minutes / 1440)
    } else if minutes >= 60 && minutes % 60 == 0 {
        format!("{} 小时", minutes / 60)
    } else {
        format!("{minutes} 分钟")
    }
}

fn normalize_rate_limit_window(id: &str, window: Option<&Value>) -> Option<RateLimitWindow> {
    let window = window?;
    let used_percent = window
        .get("used_percent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    let window_minutes = window
        .get("window_minutes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let resets_at = window
        .get("resets_at")
        .and_then(Value::as_i64)
        .and_then(|seconds| iso_from_ms(seconds * 1000));

    Some(RateLimitWindow {
        id: id.to_string(),
        label: rate_limit_window_label(window_minutes),
        used_percent,
        remaining_percent: (100.0 - used_percent).max(0.0),
        window_minutes,
        resets_at,
    })
}

fn normalize_rate_limits(rate_limits: Option<&Value>, timestamp_ms: i64) -> Option<RateLimits> {
    let rate_limits = rate_limits?;
    let windows = [
        normalize_rate_limit_window("primary", rate_limits.get("primary")),
        normalize_rate_limit_window("secondary", rate_limits.get("secondary")),
    ]
    .into_iter()
    .flatten()
    .collect();

    Some(RateLimits {
        updated_at: iso_from_ms(timestamp_ms),
        plan_type: rate_limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        reached_type: rate_limits
            .get("rate_limit_reached_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        windows,
    })
}

fn read_codex_usage_events(threads: &[Thread]) -> Vec<UsageEvent> {
    let mut events = Vec::new();

    for thread in threads {
        if thread.rollout_path.is_empty() {
            continue;
        }

        let path = Path::new(&thread.rollout_path);
        if !path.exists() {
            continue;
        }

        let Ok(file) = File::open(path) else {
            continue;
        };

        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("\"token_count\"") {
                continue;
            }

            let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if entry.get("type").and_then(Value::as_str) != Some("event_msg")
                || entry.pointer("/payload/type").and_then(Value::as_str) != Some("token_count")
            {
                continue;
            }

            let Some(usage) = entry.pointer("/payload/info/last_token_usage") else {
                continue;
            };
            let timestamp_ms = entry
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
                .map(|timestamp| timestamp.timestamp_millis());
            let Some(timestamp_ms) = timestamp_ms else {
                continue;
            };

            events.push(UsageEvent {
                thread_id: thread.id.clone(),
                timestamp_ms,
                model: thread.model.clone(),
                total_tokens: usage
                    .get("total_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                plan_type: entry
                    .pointer("/payload/rate_limits/plan_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                rate_limits: normalize_rate_limits(
                    entry.pointer("/payload/rate_limits"),
                    timestamp_ms,
                ),
            });
        }
    }

    events
}

fn build_stats_from_threads(
    mut threads: Vec<Thread>,
    now: DateTime<Local>,
    chart_days: u32,
    account: Account,
    pricing: Option<Pricing>,
    rate_limits_enabled: bool,
    paths: Value,
) -> Stats {
    let usage_events: Vec<UsageEvent> = threads
        .iter()
        .flat_map(|thread| thread.usage_events.clone())
        .collect();
    let has_usage_events = !usage_events.is_empty();
    let today_start_ms = start_of_local_day_ms(now);
    let period_start_ms = today_start_ms - (chart_days as i64 - 1) * 24 * 60 * 60 * 1000;
    let recent_threshold = now.timestamp_millis() - 7 * 24 * 60 * 60 * 1000;
    let active_threads = threads.iter().filter(|thread| !thread.archived).count();
    let total_tokens = threads.iter().map(|thread| thread.tokens_used).sum();
    let updated_this_week = threads
        .iter()
        .filter(|thread| thread.updated_at_ms >= recent_threshold)
        .count();

    let period_events: Vec<_> = usage_events
        .iter()
        .filter(|event| event.timestamp_ms >= period_start_ms)
        .collect();
    let today_events: Vec<_> = usage_events
        .iter()
        .filter(|event| event.timestamp_ms >= today_start_ms)
        .collect();
    let today_tokens = if has_usage_events {
        today_events.iter().map(|event| event.total_tokens).sum()
    } else {
        threads
            .iter()
            .filter(|thread| thread.created_at_ms >= today_start_ms)
            .map(|thread| thread.tokens_used)
            .sum()
    };
    let period_tokens = if has_usage_events {
        period_events.iter().map(|event| event.total_tokens).sum()
    } else {
        threads
            .iter()
            .filter(|thread| thread.created_at_ms >= period_start_ms)
            .map(|thread| thread.tokens_used)
            .sum()
    };
    let period_cost = estimate_cost(period_tokens);
    let latest_plan_type = usage_events
        .iter()
        .filter(|event| event.plan_type.is_some())
        .max_by_key(|event| event.timestamp_ms)
        .and_then(|event| event.plan_type.clone());
    let plan_monthly_cost = account.plan_monthly_usd;
    let period_usage_percent = plan_monthly_cost
        .filter(|cost| *cost > 0.0)
        .map(|cost| (period_cost / cost) * 100.0);
    let latest_rate_limits = if rate_limits_enabled {
        usage_events
            .iter()
            .filter(|event| event.rate_limits.is_some())
            .max_by_key(|event| event.timestamp_ms)
            .and_then(|event| event.rate_limits.clone())
    } else {
        None
    };

    let mut daily_series = build_empty_daily_series(chart_days, now);
    let mut day_indexes = HashMap::new();
    for (index, day) in daily_series.iter().enumerate() {
        day_indexes.insert(day.date.clone(), index);
    }

    for thread in &threads {
        if let Some(key) = local_date_key(thread.created_at_ms) {
            if let Some(index) = day_indexes.get(&key) {
                daily_series[*index].threads += 1;
                if !has_usage_events {
                    daily_series[*index].tokens += thread.tokens_used;
                    daily_series[*index].cost = estimate_cost(daily_series[*index].tokens);
                }
            }
        }
    }

    for event in period_events {
        if let Some(key) = local_date_key(event.timestamp_ms) {
            if let Some(index) = day_indexes.get(&key) {
                daily_series[*index].tokens += event.total_tokens;
                daily_series[*index].cost = estimate_cost(daily_series[*index].tokens);
            }
        }
    }

    threads.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    let latest_threads = threads
        .iter()
        .take(8)
        .map(|thread| LatestThread {
            id: thread.id.clone(),
            title: thread.title.clone(),
            model: thread.model.clone(),
            source: thread.source.clone(),
            tokens_used: thread.tokens_used,
            updated_at: iso_from_ms(thread.updated_at_ms),
            cwd: thread.cwd.clone(),
        })
        .collect();
    let latest_token_usage = if today_tokens > 0 {
        today_tokens
    } else if has_usage_events {
        usage_events
            .iter()
            .max_by_key(|event| event.timestamp_ms)
            .map(|event| event.total_tokens)
            .unwrap_or(0)
    } else {
        threads
            .first()
            .map(|thread| thread.tokens_used)
            .unwrap_or(0)
    };

    let account = if latest_plan_type.is_some() && account.plan_type.is_none() {
        Account {
            plan_type: latest_plan_type.clone(),
            plan_label: format_plan_type(latest_plan_type.as_deref()),
            plan_monthly_usd: plan_monthly_usd(latest_plan_type.as_deref()),
            ..account
        }
    } else {
        account
    };

    Stats {
        generated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        error: None,
        account,
        settings: ChartSettings { chart_days },
        pricing,
        featured: Featured {
            today_cost: estimate_cost(today_tokens),
            period_cost,
            period_tokens,
            latest_token_usage,
            period_usage_percent,
            cost_estimated_from_token_events: has_usage_events,
        },
        rate_limits: latest_rate_limits,
        totals: Totals {
            threads: threads.len(),
            active_threads: active_threads,
            archived_threads: threads.len() - active_threads,
            total_tokens,
            updated_this_week,
        },
        daily_series,
        models: rank_by_tokens(
            threads
                .iter()
                .map(|thread| (thread.model.clone(), thread.tokens_used)),
            6,
        ),
        sources: rank_by_tokens(threads.iter().map(|thread| (thread.source.clone(), 1)), 6),
        workspaces: rank_by_tokens(
            threads
                .iter()
                .filter(|thread| !thread.cwd.is_empty())
                .map(|thread| {
                    let name = Path::new(&thread.cwd)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or(&thread.cwd)
                        .to_string();
                    (name, thread.tokens_used)
                }),
            6,
        ),
        latest_threads,
        paths,
    }
}

fn empty_stats(
    provider_name: &str,
    initials: &str,
    chart_days: u32,
    error: String,
    paths: Value,
) -> Stats {
    Stats {
        generated_at: iso_now(),
        error: Some(error),
        account: Account {
            display_name: provider_name.to_string(),
            initials: initials.to_string(),
            plan_type: None,
            plan_label: provider_name.to_string(),
            plan_monthly_usd: None,
        },
        settings: ChartSettings { chart_days },
        pricing: None,
        featured: Featured {
            today_cost: 0.0,
            period_cost: 0.0,
            period_tokens: 0,
            latest_token_usage: 0,
            period_usage_percent: None,
            cost_estimated_from_token_events: true,
        },
        rate_limits: None,
        totals: Totals {
            threads: 0,
            active_threads: 0,
            archived_threads: 0,
            total_tokens: 0,
            updated_this_week: 0,
        },
        daily_series: build_empty_daily_series(chart_days, Local::now()),
        models: Vec::new(),
        sources: Vec::new(),
        workspaces: Vec::new(),
        latest_threads: Vec::new(),
        paths,
    }
}

fn read_codex_stats(settings: &Settings) -> Result<Stats, String> {
    let chart_days = settings.chart_days.clamp(7, 365);
    let (home, state_db, paths) = codex_paths(settings);

    if !state_db.exists() {
        return Ok(empty_stats(
            "Codex",
            "CD",
            chart_days,
            format!(
                "Codex state database not found at {}",
                state_db.to_string_lossy()
            ),
            paths,
        ));
    }

    let mut threads = read_codex_threads(&state_db)?;
    let usage_events = read_codex_usage_events(&threads);
    let mut usage_by_thread: HashMap<String, Vec<UsageEvent>> = HashMap::new();
    for event in usage_events {
        usage_by_thread
            .entry(event.thread_id.clone())
            .or_default()
            .push(event);
    }
    for thread in &mut threads {
        thread.usage_events = usage_by_thread.remove(&thread.id).unwrap_or_default();
    }

    let latest_plan_type = threads
        .iter()
        .flat_map(|thread| thread.usage_events.iter())
        .filter(|event| event.plan_type.is_some())
        .max_by_key(|event| event.timestamp_ms)
        .and_then(|event| event.plan_type.as_deref());
    let account = read_codex_account(&home, latest_plan_type);
    let pricing = Some(Pricing {
        label: "Codex local log estimate".to_string(),
        url: Some("https://developers.openai.com/codex/pricing".to_string()),
        checked_at: "2026-06-30".to_string(),
    });

    Ok(build_stats_from_threads(
        threads,
        Local::now(),
        chart_days,
        account,
        pricing,
        true,
        paths,
    ))
}

fn claude_home(settings: &Settings) -> PathBuf {
    if !settings.claude_home.trim().is_empty() {
        return PathBuf::from(&settings.claude_home);
    }
    for key in ["CLAUDE_CONFIG_DIR", "CLAUDE_HOME"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                return PathBuf::from(value);
            }
        }
    }
    home_dir().join(".claude")
}

fn usage_total(usage: &Value) -> u64 {
    usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0)
        + usage
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0)
        + usage
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0)
}

fn normalize_claude_source(value: Option<&str>) -> String {
    match value.unwrap_or("") {
        value if value.eq_ignore_ascii_case("cli") => "CLI".to_string(),
        value if value.eq_ignore_ascii_case("vscode") => "VS Code".to_string(),
        "" => "Claude Code".to_string(),
        value => value.to_string(),
    }
}

fn read_claude_session(path: &Path) -> Option<Thread> {
    let file = File::open(path).ok()?;
    let metadata = fs::metadata(path).ok();
    let mut id = path.file_stem()?.to_string_lossy().to_string();
    let mut title = String::new();
    let mut cwd = String::new();
    let mut source = String::new();
    let mut sidechain = false;
    let mut created_at_ms: Option<i64> = None;
    let mut updated_at_ms: Option<i64> = None;
    let mut usage_by_message: HashMap<String, UsageEvent> = HashMap::new();
    let mut model_totals: HashMap<String, u64> = HashMap::new();

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if let Some(session_id) = entry.get("sessionId").and_then(Value::as_str) {
            id = session_id.to_string();
        }
        if title.is_empty() {
            if let Some(custom_title) = entry.get("customTitle").and_then(Value::as_str) {
                title = custom_title.to_string();
            } else if let Some(ai_title) = entry.get("aiTitle").and_then(Value::as_str) {
                title = ai_title.to_string();
            }
        }
        if cwd.is_empty() {
            if let Some(value) = entry.get("cwd").and_then(Value::as_str) {
                cwd = value.to_string();
            }
        }
        if source.is_empty() {
            if let Some(source_value) = entry
                .get("entrypoint")
                .or_else(|| entry.get("promptSource"))
                .and_then(Value::as_str)
            {
                source = normalize_claude_source(Some(source_value));
            }
        }
        if entry
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            sidechain = true;
        }

        let timestamp_ms = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
            .map(|timestamp| timestamp.timestamp_millis());
        if let Some(timestamp_ms) = timestamp_ms {
            created_at_ms =
                Some(created_at_ms.map_or(timestamp_ms, |value| value.min(timestamp_ms)));
            updated_at_ms =
                Some(updated_at_ms.map_or(timestamp_ms, |value| value.max(timestamp_ms)));
        }

        if entry.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(usage) = entry.pointer("/message/usage") else {
            continue;
        };
        let total_tokens = usage_total(usage);
        if total_tokens == 0 {
            continue;
        }

        let message_id = entry
            .pointer("/message/id")
            .and_then(Value::as_str)
            .or_else(|| entry.get("uuid").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "{}:{}:{}",
                    id,
                    timestamp_ms.unwrap_or(0),
                    usage_by_message.len()
                )
            });
        let model = entry
            .pointer("/message/model")
            .and_then(Value::as_str)
            .unwrap_or("Unknown")
            .to_string();
        let event = UsageEvent {
            thread_id: id.clone(),
            timestamp_ms: timestamp_ms.unwrap_or_else(|| updated_at_ms.unwrap_or(0)),
            model: model.clone(),
            total_tokens,
            plan_type: None,
            rate_limits: None,
        };

        let should_update = usage_by_message
            .get(&message_id)
            .map(|previous| event.timestamp_ms >= previous.timestamp_ms)
            .unwrap_or(true);
        if should_update {
            usage_by_message.insert(message_id, event);
        }
    }

    let usage_events: Vec<_> = usage_by_message.into_values().collect();
    for event in &usage_events {
        *model_totals.entry(event.model.clone()).or_default() += event.total_tokens;
    }
    let tokens_used = usage_events.iter().map(|event| event.total_tokens).sum();
    let model = model_totals
        .into_iter()
        .max_by_key(|(_, tokens)| *tokens)
        .map(|(model, _)| model)
        .unwrap_or_else(|| "Unknown".to_string());
    let fallback_ms = metadata
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);

    Some(Thread {
        id: id.clone(),
        title: if title.is_empty() {
            format!("Claude session {}", id.chars().take(8).collect::<String>())
        } else {
            title
        },
        source: if sidechain && source.is_empty() {
            "子任务".to_string()
        } else if source.is_empty() {
            "Claude Code".to_string()
        } else {
            source
        },
        model,
        cwd,
        archived: false,
        tokens_used,
        created_at_ms: created_at_ms.unwrap_or(fallback_ms),
        updated_at_ms: updated_at_ms.unwrap_or(fallback_ms),
        rollout_path: path.to_string_lossy().to_string(),
        usage_events,
    })
}

fn claude_estimated_token_limit(env_key: &str, fallback: u64) -> u64 {
    env::var(env_key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn estimated_rate_limit_window(
    id: &str,
    label: String,
    window_minutes: u64,
    used_tokens: u64,
    token_limit: u64,
    resets_at_ms: Option<i64>,
) -> RateLimitWindow {
    let used_percent = if token_limit > 0 {
        ((used_tokens as f64 / token_limit as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    RateLimitWindow {
        id: id.to_string(),
        label,
        used_percent,
        remaining_percent: (100.0 - used_percent).max(0.0),
        window_minutes,
        resets_at: resets_at_ms.and_then(iso_from_ms),
    }
}

fn build_claude_estimated_rate_limits(
    threads: &[Thread],
    now: DateTime<Local>,
) -> Option<RateLimits> {
    if threads.is_empty() {
        return None;
    }

    let now_ms = now.timestamp_millis();
    let windows = [
        (
            "primary",
            300_u64,
            claude_estimated_token_limit(
                "AI_USAGE_CLAUDE_5H_TOKEN_LIMIT",
                CLAUDE_ESTIMATED_5H_TOKEN_LIMIT,
            ),
        ),
        (
            "secondary",
            10080_u64,
            claude_estimated_token_limit(
                "AI_USAGE_CLAUDE_WEEKLY_TOKEN_LIMIT",
                CLAUDE_ESTIMATED_WEEKLY_TOKEN_LIMIT,
            ),
        ),
    ]
    .into_iter()
    .map(|(id, window_minutes, token_limit)| {
        let window_start_ms = now_ms - window_minutes as i64 * 60 * 1000;
        let events = threads
            .iter()
            .flat_map(|thread| thread.usage_events.iter())
            .filter(|event| event.timestamp_ms >= window_start_ms && event.timestamp_ms <= now_ms)
            .collect::<Vec<_>>();
        let used_tokens = events.iter().map(|event| event.total_tokens).sum();
        let resets_at_ms = events
            .iter()
            .map(|event| event.timestamp_ms)
            .min()
            .map(|timestamp_ms| timestamp_ms + window_minutes as i64 * 60 * 1000);

        estimated_rate_limit_window(
            id,
            rate_limit_window_label(window_minutes),
            window_minutes,
            used_tokens,
            token_limit,
            resets_at_ms,
        )
    })
    .collect();

    Some(RateLimits {
        updated_at: Some(iso_now()),
        plan_type: Some("local_estimate".to_string()),
        reached_type: None,
        windows,
    })
}

fn format_claude_plan_label(user_type: Option<&str>, is_claude_ai_auth: bool) -> String {
    if is_claude_ai_auth {
        return "Claude.ai account".to_string();
    }

    match user_type.unwrap_or("").trim() {
        "" => "Claude Code".to_string(),
        value => format!("Claude Code {}", value),
    }
}

fn read_claude_account(home: &Path) -> Account {
    let telemetry_path = home.join("telemetry");
    let mut latest: Option<(i64, String, Option<String>, bool)> = None;

    if telemetry_path.exists() {
        for entry in WalkDir::new(&telemetry_path)
            .max_depth(1)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        {
            let Ok(file) = File::open(entry.path()) else {
                continue;
            };

            for line in BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let data = event.get("event_data").unwrap_or(&event);
                let email = data
                    .get("email")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let user_type = data
                    .get("user_type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let is_claude_ai_auth = data
                    .pointer("/env/is_claude_ai_auth")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

                if email.is_none() && user_type.is_none() && !is_claude_ai_auth {
                    continue;
                }

                let timestamp_ms = data
                    .get("client_timestamp")
                    .and_then(Value::as_str)
                    .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
                    .map(|timestamp| timestamp.timestamp_millis())
                    .unwrap_or(0);
                let display_name = email.unwrap_or_else(|| "Claude Code".to_string());
                let should_update = latest
                    .as_ref()
                    .map(|(previous_ms, _, _, _)| timestamp_ms >= *previous_ms)
                    .unwrap_or(true);

                if should_update {
                    latest = Some((timestamp_ms, display_name, user_type, is_claude_ai_auth));
                }
            }
        }
    }

    let (_, display_name, user_type, is_claude_ai_auth) =
        latest.unwrap_or_else(|| (0, "Claude Code".to_string(), None, false));
    let plan_label = format_claude_plan_label(user_type.as_deref(), is_claude_ai_auth);

    Account {
        initials: initials_from_name(&display_name, "CC"),
        display_name,
        plan_type: user_type,
        plan_label,
        plan_monthly_usd: None,
    }
}

fn read_claude_stats(settings: &Settings) -> Result<Stats, String> {
    let chart_days = settings.chart_days.clamp(7, 365);
    let home = claude_home(settings);
    let projects_path = home.join("projects");
    let paths = json!({
      "claudeHome": home.to_string_lossy(),
      "projectsPath": projects_path.to_string_lossy(),
      "settingsPath": home.join("settings.json").to_string_lossy(),
      "historyPath": home.join("history.jsonl").to_string_lossy()
    });

    if !projects_path.exists() {
        return Ok(empty_stats(
            "Claude Code",
            "CC",
            chart_days,
            format!(
                "Claude Code session logs not found at {}",
                projects_path.to_string_lossy()
            ),
            paths,
        ));
    }

    let threads = WalkDir::new(&projects_path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter_map(|entry| read_claude_session(entry.path()))
        .collect::<Vec<_>>();

    let account = read_claude_account(&home);
    let pricing = Some(Pricing {
        label: "Local token and usage-window estimate".to_string(),
        url: None,
        checked_at: "2026-06-30".to_string(),
    });

    let estimated_rate_limits = build_claude_estimated_rate_limits(&threads, Local::now());
    let mut stats = build_stats_from_threads(
        threads,
        Local::now(),
        chart_days,
        account,
        pricing,
        false,
        paths,
    );
    stats.rate_limits = estimated_rate_limits;

    Ok(stats)
}

fn vscode_user_roots() -> Vec<PathBuf> {
    let names = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

    #[cfg(target_os = "macos")]
    let base = home_dir().join("Library").join("Application Support");

    #[cfg(target_os = "windows")]
    let base = env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join("AppData").join("Roaming"));

    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".config"));

    names
        .iter()
        .map(|name| base.join(name).join("User"))
        .collect()
}

fn copilot_default_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for user_root in vscode_user_roots() {
        candidates.push(user_root.join("globalStorage").join("github.copilot-chat"));
        candidates.push(user_root.join("globalStorage").join("github.copilot"));
        candidates.push(user_root.join("workspaceStorage"));
    }
    candidates
}

fn copilot_home(settings: &Settings) -> PathBuf {
    if !settings.copilot_home.trim().is_empty() {
        return PathBuf::from(&settings.copilot_home);
    }
    for key in ["GITHUB_COPILOT_HOME", "COPILOT_HOME"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                return PathBuf::from(value);
            }
        }
    }

    let candidates = copilot_default_candidates();
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| {
            candidates
                .first()
                .cloned()
                .unwrap_or_else(|| home_dir().join(".copilot"))
        })
}

fn copilot_paths(settings: &Settings) -> (PathBuf, Vec<PathBuf>, Value) {
    let configured = !settings.copilot_home.trim().is_empty()
        || env::var("GITHUB_COPILOT_HOME")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || env::var("COPILOT_HOME")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    let home = copilot_home(settings);
    let scan_roots = if configured {
        vec![home.clone()]
    } else {
        let existing = copilot_default_candidates()
            .into_iter()
            .filter(|path| path.exists())
            .collect::<Vec<_>>();
        if existing.is_empty() {
            vec![home.clone()]
        } else {
            existing
        }
    };

    let paths = json!({
      "copilotHome": home.to_string_lossy(),
      "scanRoots": scan_roots
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
    });

    (home, scan_roots, paths)
}

fn object_string<'a>(object: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn object_nested_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a str> {
    if let Some(value) = object_string(object, keys) {
        return Some(value);
    }

    for key in ["author", "sender", "message", "request", "response"] {
        if let Some(Value::Object(nested)) = object.get(key) {
            if let Some(value) = object_string(nested, keys) {
                return Some(value);
            }
        }
    }

    None
}

fn timestamp_ms_from_value(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(if number > 10_000_000_000 {
            number
        } else {
            number * 1000
        });
    }
    if let Some(number) = value.as_u64() {
        let number = number.min(i64::MAX as u64) as i64;
        return Some(if number > 10_000_000_000 {
            number
        } else {
            number * 1000
        });
    }
    let text = value.as_str()?.trim();
    if let Ok(number) = text.parse::<i64>() {
        return Some(if number > 10_000_000_000 {
            number
        } else {
            number * 1000
        });
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn object_timestamp_ms(object: &serde_json::Map<String, Value>) -> Option<i64> {
    [
        "timestamp",
        "time",
        "createdAt",
        "updatedAt",
        "lastUpdatedAt",
        "created_at",
        "updated_at",
        "startTime",
        "endTime",
    ]
    .iter()
    .find_map(|key| object.get(*key).and_then(timestamp_ms_from_value))
}

fn estimate_tokens_from_text(text: &str) -> u64 {
    let chars = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .count() as u64;
    ((chars + 3) / 4).max(1)
}

fn copilot_text_tokens(value: &Value) -> u64 {
    match value {
        Value::String(text) => estimate_tokens_from_text(text),
        Value::Array(items) => items.iter().map(copilot_text_tokens).sum(),
        Value::Object(object) => object
            .get("value")
            .or_else(|| object.get("text"))
            .or_else(|| object.get("content"))
            .map(copilot_text_tokens)
            .unwrap_or(0),
        _ => 0,
    }
}

fn copilot_usage_total(value: &Value) -> u64 {
    for key in [
        "total_tokens",
        "totalTokens",
        "totalTokenCount",
        "token_count",
        "tokenCount",
        "tokens",
    ] {
        if let Some(tokens) = value.get(key).and_then(Value::as_u64) {
            if tokens > 0 {
                return tokens;
            }
        }
    }

    [
        "input_tokens",
        "prompt_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
        "completion_tokens",
        "inputTokens",
        "promptTokens",
        "outputTokens",
        "completionTokens",
    ]
    .iter()
    .filter_map(|key| value.get(*key).and_then(Value::as_u64))
    .sum()
}

fn copilot_object_usage_total(object: &serde_json::Map<String, Value>) -> u64 {
    for value in [
        object.get("usage"),
        object.get("tokenUsage"),
        object.get("usageInfo"),
        object.get("telemetry"),
    ]
    .into_iter()
    .flatten()
    {
        let tokens = copilot_usage_total(value);
        if tokens > 0 {
            return tokens;
        }
    }

    copilot_usage_total(&Value::Object(object.clone()))
}

fn copilot_object_text_tokens(object: &serde_json::Map<String, Value>) -> u64 {
    for key in [
        "content",
        "text",
        "prompt",
        "response",
        "completion",
        "markdown",
    ] {
        if let Some(tokens) = object
            .get(key)
            .map(copilot_text_tokens)
            .filter(|tokens| *tokens > 0)
        {
            return tokens;
        }
    }

    object
        .get("message")
        .and_then(Value::as_str)
        .map(estimate_tokens_from_text)
        .unwrap_or(0)
}

fn find_string_deep(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            if let Some(found) = object_string(object, keys) {
                return Some(found.to_string());
            }
            object
                .values()
                .find_map(|value| find_string_deep(value, keys))
        }
        Value::Array(items) => items.iter().find_map(|value| find_string_deep(value, keys)),
        _ => None,
    }
}

fn find_timestamp_deep(value: &Value) -> Option<i64> {
    match value {
        Value::Object(object) => {
            object_timestamp_ms(object).or_else(|| object.values().find_map(find_timestamp_deep))
        }
        Value::Array(items) => items.iter().find_map(find_timestamp_deep),
        _ => None,
    }
}

fn collect_copilot_usage_events(
    value: &Value,
    thread_id: &str,
    fallback_model: &str,
    events: &mut Vec<UsageEvent>,
    timestamps: &mut Vec<i64>,
) {
    match value {
        Value::Object(object) => {
            if let Some(timestamp_ms) = object_timestamp_ms(object) {
                timestamps.push(timestamp_ms);
            }

            let role = object_nested_string(object, &["role", "kind", "type", "speaker", "name"]);
            let role_is_message = role
                .map(|role| {
                    let role = role.to_lowercase();
                    [
                        "assistant",
                        "user",
                        "system",
                        "copilot",
                        "response",
                        "request",
                    ]
                    .contains(&role.as_str())
                })
                .unwrap_or(false);
            let has_message_text = copilot_object_text_tokens(object) > 0;
            let explicit_tokens = copilot_object_usage_total(object);
            let text_tokens = if explicit_tokens == 0 && (role_is_message || has_message_text) {
                copilot_object_text_tokens(object)
            } else {
                0
            };
            let total_tokens = if role_is_message || has_message_text {
                explicit_tokens.max(text_tokens)
            } else {
                0
            };

            if total_tokens > 0 {
                let timestamp_ms = object_timestamp_ms(object)
                    .or_else(|| find_timestamp_deep(value))
                    .unwrap_or(0);
                let model = object_nested_string(
                    object,
                    &["model", "modelId", "model_id", "engine", "modelName"],
                )
                .unwrap_or(fallback_model)
                .to_string();
                events.push(UsageEvent {
                    thread_id: thread_id.to_string(),
                    timestamp_ms,
                    model,
                    total_tokens,
                    plan_type: None,
                    rate_limits: None,
                });
            }

            for child in object.values() {
                collect_copilot_usage_events(child, thread_id, fallback_model, events, timestamps);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_copilot_usage_events(item, thread_id, fallback_model, events, timestamps);
            }
        }
        _ => {}
    }
}

fn parse_json_from_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if start >= end {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end]).ok()
}

fn read_copilot_values_as_thread(
    path: &Path,
    values: Vec<Value>,
    id_suffix: Option<&str>,
    provider_name: &str,
    default_source: &str,
    workspace_source: &str,
) -> Option<Thread> {
    let metadata = fs::metadata(path).ok();
    let fallback_id = path.file_stem()?.to_string_lossy().to_string();
    let id = values
        .iter()
        .find_map(|value| {
            find_string_deep(
                value,
                &["sessionId", "conversationId", "chatId", "threadId", "id"],
            )
        })
        .unwrap_or_else(|| match id_suffix {
            Some(suffix) => format!("{fallback_id}:{suffix}"),
            None => fallback_id.clone(),
        });
    let title = values
        .iter()
        .find_map(|value| {
            find_string_deep(value, &["title", "customTitle", "name", "summary", "label"])
        })
        .unwrap_or_else(|| format!("Copilot session {}", id.chars().take(8).collect::<String>()));
    let cwd = values
        .iter()
        .find_map(|value| {
            find_string_deep(
                value,
                &[
                    "cwd",
                    "workspaceFolder",
                    "workspace",
                    "workspacePath",
                    "rootPath",
                ],
            )
        })
        .unwrap_or_default();
    let fallback_model = values
        .iter()
        .find_map(|value| {
            find_string_deep(
                value,
                &["model", "modelId", "model_id", "engine", "modelName"],
            )
        })
        .unwrap_or_else(|| provider_name.to_string());

    let mut events = Vec::new();
    let mut timestamps = Vec::new();
    for value in &values {
        collect_copilot_usage_events(value, &id, &fallback_model, &mut events, &mut timestamps);
    }
    if events.is_empty() {
        return None;
    }

    let mut model_totals: HashMap<String, u64> = HashMap::new();
    for event in &events {
        *model_totals.entry(event.model.clone()).or_default() += event.total_tokens;
        if event.timestamp_ms > 0 {
            timestamps.push(event.timestamp_ms);
        }
    }
    let model = model_totals
        .into_iter()
        .max_by_key(|(_, tokens)| *tokens)
        .map(|(model, _)| model)
        .unwrap_or(fallback_model);
    let tokens_used = events.iter().map(|event| event.total_tokens).sum();
    let fallback_ms = metadata
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let created_at_ms = timestamps
        .iter()
        .copied()
        .filter(|time| *time > 0)
        .min()
        .unwrap_or(fallback_ms);
    let updated_at_ms = timestamps
        .iter()
        .copied()
        .filter(|time| *time > 0)
        .max()
        .unwrap_or(fallback_ms);
    let path_text = path.to_string_lossy().to_lowercase();
    let source = if path_text.contains("workspacestorage") {
        workspace_source.to_string()
    } else {
        default_source.to_string()
    };

    Some(Thread {
        id,
        title,
        source,
        model,
        cwd,
        archived: false,
        tokens_used,
        created_at_ms,
        updated_at_ms,
        rollout_path: path.to_string_lossy().to_string(),
        usage_events: events,
    })
}

fn read_copilot_jsonish_file(path: &Path) -> Option<Thread> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > 20 * 1024 * 1024 {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    if extension.eq_ignore_ascii_case("json") {
        let value = serde_json::from_str::<Value>(&content).ok()?;
        return read_copilot_values_as_thread(
            path,
            vec![value],
            None,
            "GitHub Copilot",
            "VS Code",
            "VS Code Workspace",
        );
    }

    let values = content
        .lines()
        .filter_map(parse_json_from_line)
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        read_copilot_values_as_thread(
            path,
            values,
            None,
            "GitHub Copilot",
            "VS Code",
            "VS Code Workspace",
        )
    }
}

fn read_copilot_sqlite_threads(path: &Path) -> Vec<Thread> {
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare("select key, cast(value as text) from ItemTable")
    else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };

    rows.filter_map(Result::ok)
        .filter_map(|(key, value)| {
            let searchable = format!("{} {}", key, value).to_lowercase();
            if !searchable.contains("copilot") && !searchable.contains("chat") {
                return None;
            }
            let parsed = serde_json::from_str::<Value>(&value).ok()?;
            read_copilot_values_as_thread(
                path,
                vec![parsed],
                Some(&key),
                "GitHub Copilot",
                "VS Code",
                "VS Code Workspace",
            )
        })
        .collect()
}

fn state_db_candidates(scan_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for root in scan_roots {
        if root.file_name().and_then(|name| name.to_str()) == Some("state.vscdb") {
            candidates.push(root.clone());
        }
        candidates.push(root.join("state.vscdb"));
        if let Some(parent) = root.parent() {
            candidates.push(parent.join("state.vscdb"));
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates
}

fn storage_json_candidates(scan_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for root in scan_roots {
        candidates.push(root.join("storage.json"));
        if let Some(parent) = root.parent() {
            candidates.push(parent.join("storage.json"));
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates
}

fn read_state_items(path: &Path) -> Vec<(String, String)> {
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare("select key, cast(value as text) from ItemTable")
    else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };

    rows.filter_map(Result::ok).collect()
}

fn find_string_deep_ci(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if keys
                    .iter()
                    .any(|candidate| key.eq_ignore_ascii_case(candidate))
                {
                    if let Some(text) = value.as_str() {
                        let text = text.trim();
                        if is_display_identifier(text) {
                            return Some(text.to_string());
                        }
                    }
                }
            }
            object
                .values()
                .find_map(|value| find_string_deep_ci(value, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|value| find_string_deep_ci(value, keys)),
        _ => None,
    }
}

fn is_display_identifier(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 120
        && !value.contains('\n')
        && !value.to_lowercase().contains("token")
        && !value.starts_with("eyJ")
}

fn format_plan_label(provider_name: &str, raw: Option<&str>) -> String {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return provider_name.to_string();
    };

    let normalized = raw
        .replace(provider_name, "")
        .replace("github", "")
        .replace("copilot", "")
        .replace(['_', '-', '.'], " ");
    let words = normalized
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();

    if words.is_empty() {
        provider_name.to_string()
    } else {
        format!("{provider_name} {}", words.join(" "))
    }
}

fn parse_json_value(value: &str) -> Option<Value> {
    serde_json::from_str::<Value>(value).ok()
}

fn read_github_copilot_account(scan_roots: &[PathBuf]) -> Account {
    let mut state_dbs = state_db_candidates(scan_roots);
    if !state_dbs.iter().any(|path| path.exists()) {
        for user_root in vscode_user_roots() {
            state_dbs.push(user_root.join("globalStorage").join("state.vscdb"));
        }
    }
    state_dbs.sort();
    state_dbs.dedup();

    let mut login: Option<String> = None;
    let mut plan_type: Option<String> = None;
    let mut account_id: Option<String> = None;

    for db_path in state_dbs.iter().filter(|path| path.exists()) {
        for (key, value) in read_state_items(db_path) {
            let key_lower = key.to_lowercase();
            if login.is_none()
                && key_lower.starts_with("github-")
                && !key_lower.ends_with("-usages")
            {
                let candidate = key.trim_start_matches("github-").trim();
                if is_display_identifier(candidate) {
                    login = Some(candidate.to_string());
                }
            }

            if key == "extensionsAssignmentFilterProvider.copilotSku"
                || key == "exp.github.copilot.sku"
            {
                if is_display_identifier(&value) {
                    plan_type = Some(value.clone());
                }
            }

            if let Some(parsed) = parse_json_value(&value) {
                if plan_type.is_none() {
                    plan_type = find_string_deep_ci(
                        &parsed,
                        &[
                            "exp.github.copilot.sku",
                            "copilotSku",
                            "sku",
                            "plan",
                            "planType",
                        ],
                    );
                }
                if account_id.is_none() {
                    account_id = find_string_deep_ci(&parsed, &["accountId", "account_id"]);
                }
            }
        }
    }

    let display_name = login
        .or_else(|| account_id.map(|id| format!("GitHub {id}")))
        .unwrap_or_else(|| "GitHub Copilot".to_string());
    let plan_label = format_plan_label("GitHub Copilot", plan_type.as_deref());

    Account {
        initials: initials_from_name(&display_name, "GH"),
        display_name,
        plan_type,
        plan_label,
        plan_monthly_usd: None,
    }
}

fn read_cursor_account(scan_roots: &[PathBuf]) -> Account {
    let display_keys = [
        "email",
        "login",
        "username",
        "userName",
        "displayName",
        "name",
    ];
    let plan_keys = [
        "plan",
        "planType",
        "tier",
        "membershipType",
        "subscription",
        "subscriptionType",
        "sku",
    ];
    let mut display_name: Option<String> = None;
    let mut plan_type: Option<String> = None;

    for db_path in state_db_candidates(scan_roots)
        .iter()
        .filter(|path| path.exists())
    {
        for (key, value) in read_state_items(db_path) {
            let key_lower = key.to_lowercase();
            if key_lower.contains("token") || key_lower.contains("secret") {
                continue;
            }
            if ![
                "cursor",
                "account",
                "profile",
                "user",
                "auth",
                "membership",
                "subscription",
            ]
            .iter()
            .any(|needle| key_lower.contains(needle))
            {
                continue;
            }
            let Some(parsed) = parse_json_value(&value) else {
                continue;
            };
            if display_name.is_none() {
                display_name = find_string_deep_ci(&parsed, &display_keys);
            }
            if plan_type.is_none() {
                plan_type = find_string_deep_ci(&parsed, &plan_keys);
            }
        }
    }

    for json_path in storage_json_candidates(scan_roots)
        .iter()
        .filter(|path| path.exists())
    {
        let Ok(content) = fs::read_to_string(json_path) else {
            continue;
        };
        let Some(parsed) = parse_json_value(&content) else {
            continue;
        };
        if display_name.is_none() {
            display_name = find_string_deep_ci(&parsed, &display_keys);
        }
        if plan_type.is_none() {
            plan_type = find_string_deep_ci(&parsed, &plan_keys);
        }
    }

    let display_name = display_name.unwrap_or_else(|| "Cursor".to_string());
    let plan_label = format_plan_label("Cursor", plan_type.as_deref());

    Account {
        initials: initials_from_name(&display_name, "CU"),
        display_name,
        plan_type,
        plan_label,
        plan_monthly_usd: None,
    }
}

fn cursor_user_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = home_dir().join("Library").join("Application Support");

    #[cfg(target_os = "windows")]
    let base = env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join("AppData").join("Roaming"));

    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".config"));

    vec![base.join("Cursor").join("User")]
}

fn cursor_default_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for user_root in cursor_user_roots() {
        candidates.push(user_root.join("globalStorage"));
        candidates.push(user_root.join("workspaceStorage"));
    }
    candidates
}

fn cursor_home(settings: &Settings) -> PathBuf {
    if !settings.cursor_home.trim().is_empty() {
        return PathBuf::from(&settings.cursor_home);
    }
    for key in ["AI_USAGE_CURSOR_HOME", "CURSOR_HOME"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                return PathBuf::from(value);
            }
        }
    }

    let candidates = cursor_default_candidates();
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| {
            candidates
                .first()
                .cloned()
                .unwrap_or_else(|| home_dir().join(".cursor"))
        })
}

fn cursor_paths(settings: &Settings) -> (PathBuf, Vec<PathBuf>, Value) {
    let configured = !settings.cursor_home.trim().is_empty()
        || env::var("AI_USAGE_CURSOR_HOME")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || env::var("CURSOR_HOME")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    let home = cursor_home(settings);
    let scan_roots = if configured {
        vec![home.clone()]
    } else {
        let existing = cursor_default_candidates()
            .into_iter()
            .filter(|path| path.exists())
            .collect::<Vec<_>>();
        if existing.is_empty() {
            vec![home.clone()]
        } else {
            existing
        }
    };

    let paths = json!({
      "cursorHome": home.to_string_lossy(),
      "scanRoots": scan_roots
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
    });

    (home, scan_roots, paths)
}

fn read_cursor_values_as_thread(
    path: &Path,
    values: Vec<Value>,
    id_suffix: Option<&str>,
) -> Option<Thread> {
    read_copilot_values_as_thread(
        path,
        values,
        id_suffix,
        "Cursor",
        "Cursor",
        "Cursor Workspace",
    )
}

fn read_cursor_jsonish_file(path: &Path) -> Option<Thread> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > 20 * 1024 * 1024 {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    if extension.eq_ignore_ascii_case("json") {
        let value = serde_json::from_str::<Value>(&content).ok()?;
        return read_cursor_values_as_thread(path, vec![value], None);
    }

    let values = content
        .lines()
        .filter_map(parse_json_from_line)
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        read_cursor_values_as_thread(path, values, None)
    }
}

fn read_cursor_sqlite_threads(path: &Path) -> Vec<Thread> {
    let Ok(connection) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare("select key, cast(value as text) from ItemTable")
    else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };

    rows.filter_map(Result::ok)
        .filter_map(|(key, value)| {
            let searchable = format!("{} {}", key, value).to_lowercase();
            if ![
                "cursor",
                "chat",
                "composer",
                "aichat",
                "ai_chat",
                "workbench.panel.aichat",
            ]
            .iter()
            .any(|needle| searchable.contains(needle))
            {
                return None;
            }
            let parsed = serde_json::from_str::<Value>(&value).ok()?;
            read_cursor_values_as_thread(path, vec![parsed], Some(&key))
        })
        .collect()
}

fn is_cursor_data_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    if file_name == "state.vscdb" {
        return true;
    }

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["json", "jsonl", "log"].contains(&extension.as_str()) {
        return false;
    }

    let path_text = path.to_string_lossy().to_lowercase();
    ["cursor", "chat", "composer", "aichat", "ai_chat"]
        .iter()
        .any(|needle| path_text.contains(needle))
}

fn is_copilot_data_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    if file_name == "state.vscdb" {
        return true;
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["json", "jsonl", "log"].contains(&extension.as_str()) {
        return false;
    }
    let path_text = path.to_string_lossy().to_lowercase();
    path_text.contains("copilot") || path_text.contains("chat")
}

fn read_copilot_stats(settings: &Settings) -> Result<Stats, String> {
    let chart_days = settings.chart_days.clamp(7, 365);
    let (home, scan_roots, paths) = copilot_paths(settings);

    if !scan_roots.iter().any(|path| path.exists()) {
        return Ok(empty_stats(
            "GitHub Copilot",
            "GH",
            chart_days,
            format!(
                "GitHub Copilot local storage not found at {}",
                home.to_string_lossy()
            ),
            paths,
        ));
    }

    let mut threads = Vec::new();
    for root in scan_roots.iter().filter(|path| path.exists()) {
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| is_copilot_data_file(entry.path()))
        {
            if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("state.vscdb")
            {
                threads.extend(read_copilot_sqlite_threads(entry.path()));
            } else if let Some(thread) = read_copilot_jsonish_file(entry.path()) {
                threads.push(thread);
            }
        }
    }

    let account = read_github_copilot_account(&scan_roots);
    let pricing = Some(Pricing {
        label: "Local token estimate".to_string(),
        url: Some("https://github.com/features/copilot/plans".to_string()),
        checked_at: "2026-06-30".to_string(),
    });

    Ok(build_stats_from_threads(
        threads,
        Local::now(),
        chart_days,
        account,
        pricing,
        false,
        paths,
    ))
}

fn read_cursor_stats(settings: &Settings) -> Result<Stats, String> {
    let chart_days = settings.chart_days.clamp(7, 365);
    let (home, scan_roots, paths) = cursor_paths(settings);

    if !scan_roots.iter().any(|path| path.exists()) {
        return Ok(empty_stats(
            "Cursor",
            "CU",
            chart_days,
            format!(
                "Cursor local storage not found at {}",
                home.to_string_lossy()
            ),
            paths,
        ));
    }

    let mut threads = Vec::new();
    for root in scan_roots.iter().filter(|path| path.exists()) {
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| is_cursor_data_file(entry.path()))
        {
            if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("state.vscdb")
            {
                threads.extend(read_cursor_sqlite_threads(entry.path()));
            } else if let Some(thread) = read_cursor_jsonish_file(entry.path()) {
                threads.push(thread);
            }
        }
    }

    let account = read_cursor_account(&scan_roots);
    let pricing = Some(Pricing {
        label: "Local token estimate".to_string(),
        url: Some("https://cursor.com/pricing".to_string()),
        checked_at: "2026-06-30".to_string(),
    });

    Ok(build_stats_from_threads(
        threads,
        Local::now(),
        chart_days,
        account,
        pricing,
        false,
        paths,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_account() -> Account {
        Account {
            display_name: "Codex".to_string(),
            initials: "CD".to_string(),
            plan_type: None,
            plan_label: "Codex".to_string(),
            plan_monthly_usd: None,
        }
    }

    #[test]
    fn normalize_settings_switches_active_to_enabled_provider() {
        let mut settings = default_settings();
        settings.active_provider = "cursor".to_string();
        settings.enabled_providers = vec!["claude".to_string(), "copilot".to_string()];

        let normalized = normalize_settings(settings);

        assert_eq!(normalized.enabled_providers, vec!["claude", "copilot"]);
        assert_eq!(normalized.active_provider, "claude");
    }

    #[test]
    fn normalize_settings_keeps_at_least_one_enabled_provider() {
        let mut settings = default_settings();
        settings.active_provider = "unknown".to_string();
        settings.enabled_providers = vec!["unknown".to_string()];

        let normalized = normalize_settings(settings);

        assert_eq!(normalized.enabled_providers, default_enabled_providers());
        assert_eq!(normalized.active_provider, "codex");
    }

    fn temp_jsonl_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let counter = TEST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = env::temp_dir().join(format!(
            "ai-usage-test-{}-{nonce}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("test temp dir should be created");
        dir.join(name)
    }

    #[test]
    fn source_label_normalizes_known_sources() {
        assert_eq!(
            source_label(Some(r#"{"subagent":{"other":"guardian"}}"#)),
            "子任务"
        );
        assert_eq!(source_label(Some("vscode")), "VS Code");
        assert_eq!(source_label(Some("")), "Unknown");
        assert_eq!(source_label(None), "Unknown");
    }

    #[test]
    fn usage_total_includes_claude_cache_and_output_tokens() {
        let usage = json!({
          "input_tokens": 10,
          "cache_creation_input_tokens": 20,
          "cache_read_input_tokens": 30,
          "output_tokens": 40
        });

        assert_eq!(usage_total(&usage), 100);
    }

    #[test]
    fn build_stats_from_threads_aggregates_codex_usage_events() {
        let now = DateTime::parse_from_rfc3339("2026-06-30T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Local);
        let rate_limits = normalize_rate_limits(
            Some(&json!({
              "plan_type": "prolite",
              "primary": { "used_percent": 8, "window_minutes": 300, "resets_at": 1782833640 },
              "secondary": { "used_percent": 6, "window_minutes": 10080, "resets_at": 1783478400 }
            })),
            DateTime::parse_from_rfc3339("2026-06-30T11:00:00.000Z")
                .unwrap()
                .timestamp_millis(),
        );
        let threads = vec![
            Thread {
                id: "one".to_string(),
                title: "First".to_string(),
                source: source_label(Some("vscode")),
                model: "gpt-5.5".to_string(),
                cwd: "/work/app-one".to_string(),
                archived: false,
                tokens_used: 1200,
                created_at_ms: DateTime::parse_from_rfc3339("2026-06-29T10:00:00.000Z")
                    .unwrap()
                    .timestamp_millis(),
                updated_at_ms: DateTime::parse_from_rfc3339("2026-06-30T09:00:00.000Z")
                    .unwrap()
                    .timestamp_millis(),
                rollout_path: String::new(),
                usage_events: vec![UsageEvent {
                    thread_id: "one".to_string(),
                    timestamp_ms: DateTime::parse_from_rfc3339("2026-06-30T11:00:00.000Z")
                        .unwrap()
                        .timestamp_millis(),
                    model: "gpt-5.5".to_string(),
                    total_tokens: 1500,
                    plan_type: Some("prolite".to_string()),
                    rate_limits,
                }],
            },
            Thread {
                id: "two".to_string(),
                title: "Second".to_string(),
                source: source_label(Some(r#"{"subagent":{"other":"guardian"}}"#)),
                model: "codex-auto-review".to_string(),
                cwd: "/work/app-two".to_string(),
                archived: true,
                tokens_used: 300,
                created_at_ms: DateTime::parse_from_rfc3339("2026-06-20T10:00:00.000Z")
                    .unwrap()
                    .timestamp_millis(),
                updated_at_ms: DateTime::parse_from_rfc3339("2026-06-21T09:00:00.000Z")
                    .unwrap()
                    .timestamp_millis(),
                rollout_path: String::new(),
                usage_events: vec![UsageEvent {
                    thread_id: "two".to_string(),
                    timestamp_ms: DateTime::parse_from_rfc3339("2026-06-20T11:00:00.000Z")
                        .unwrap()
                        .timestamp_millis(),
                    model: "codex-auto-review".to_string(),
                    total_tokens: 200,
                    plan_type: None,
                    rate_limits: None,
                }],
            },
        ];

        let stats = build_stats_from_threads(
            threads,
            now,
            30,
            test_account(),
            None,
            true,
            json!({ "test": true }),
        );

        assert_eq!(stats.totals.threads, 2);
        assert_eq!(stats.totals.active_threads, 1);
        assert_eq!(stats.totals.archived_threads, 1);
        assert_eq!(stats.totals.total_tokens, 1500);
        assert_eq!(stats.featured.period_tokens, 1700);
        assert_eq!(stats.featured.period_cost, 0.0017);
        assert_eq!(stats.featured.latest_token_usage, 1500);
        assert_eq!(stats.featured.cost_estimated_from_token_events, true);
        assert_eq!(
            stats.rate_limits.as_ref().unwrap().windows[0].label,
            "5 小时"
        );
        assert_eq!(
            stats.rate_limits.as_ref().unwrap().windows[0].remaining_percent,
            92.0
        );
        assert_eq!(stats.models[0].name, "gpt-5.5");
        assert!(stats
            .sources
            .iter()
            .any(|source| source.name == "VS Code" && source.value == 1));
        assert!(stats
            .sources
            .iter()
            .any(|source| source.name == "子任务" && source.value == 1));
        assert_eq!(stats.daily_series.len(), 30);
        assert_eq!(stats.daily_series[28].threads, 1);
        assert_eq!(stats.latest_threads[0].id, "one");
    }

    #[test]
    fn read_claude_session_deduplicates_repeated_assistant_updates() {
        let file_path = temp_jsonl_path("session-one.jsonl");
        let rows = [
            json!({
              "type": "custom-title",
              "customTitle": "Dedup session",
              "sessionId": "session-one"
            }),
            json!({
              "type": "user",
              "timestamp": "2026-06-30T10:00:00.000Z",
              "sessionId": "session-one",
              "cwd": "/work/app",
              "entrypoint": "cli",
              "message": { "role": "user", "content": "hello" }
            }),
            json!({
              "type": "assistant",
              "timestamp": "2026-06-30T10:00:10.000Z",
              "sessionId": "session-one",
              "cwd": "/work/app",
              "message": {
                "id": "msg-one",
                "model": "claude-opus-4-8",
                "usage": {
                  "input_tokens": 10,
                  "cache_creation_input_tokens": 20,
                  "cache_read_input_tokens": 30,
                  "output_tokens": 40
                }
              }
            }),
            json!({
              "type": "assistant",
              "timestamp": "2026-06-30T10:00:12.000Z",
              "sessionId": "session-one",
              "cwd": "/work/app",
              "message": {
                "id": "msg-one",
                "model": "claude-opus-4-8",
                "usage": {
                  "input_tokens": 10,
                  "cache_creation_input_tokens": 20,
                  "cache_read_input_tokens": 30,
                  "output_tokens": 40
                }
              }
            }),
        ];
        let mut file = File::create(&file_path).expect("test jsonl should be created");
        for row in rows {
            writeln!(file, "{row}").expect("test jsonl row should be written");
        }

        let session = read_claude_session(&file_path).expect("session should parse");

        assert_eq!(session.id, "session-one");
        assert_eq!(session.title, "Dedup session");
        assert_eq!(session.source, "CLI");
        assert_eq!(session.tokens_used, 100);
        assert_eq!(session.usage_events.len(), 1);

        let _ = fs::remove_dir_all(file_path.parent().unwrap());
    }

    #[test]
    fn read_claude_account_uses_latest_telemetry_identity() {
        let telemetry_file = temp_jsonl_path("events.json");
        let home = telemetry_file.parent().unwrap().to_path_buf();
        let telemetry_dir = home.join("telemetry");
        fs::create_dir_all(&telemetry_dir).expect("telemetry dir should be created");
        let telemetry_file = telemetry_dir.join("events.json");
        let rows = [
            json!({
              "event_data": {
                "client_timestamp": "2026-06-30T09:00:00.000Z",
                "email": "old@example.com",
                "user_type": "external",
                "env": { "is_claude_ai_auth": true }
              }
            }),
            json!({
              "event_data": {
                "client_timestamp": "2026-06-30T10:00:00.000Z",
                "email": "new@example.com",
                "user_type": "external",
                "env": { "is_claude_ai_auth": true }
              }
            }),
        ];
        let mut file = File::create(&telemetry_file).expect("telemetry file should be created");
        for row in rows {
            writeln!(file, "{row}").expect("telemetry row should be written");
        }

        let account = read_claude_account(&home);

        assert_eq!(account.display_name, "new@example.com");
        assert_eq!(account.initials, "N");
        assert_eq!(account.plan_type.as_deref(), Some("external"));
        assert_eq!(account.plan_label, "Claude.ai account");

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn build_claude_estimated_rate_limits_uses_recent_token_windows() {
        let now = DateTime::parse_from_rfc3339("2026-06-30T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Local);
        let threads = vec![Thread {
            id: "claude-one".to_string(),
            title: "Claude".to_string(),
            source: "CLI".to_string(),
            model: "claude-opus-4-8".to_string(),
            cwd: "/work/app".to_string(),
            archived: false,
            tokens_used: 11_000,
            created_at_ms: DateTime::parse_from_rfc3339("2026-06-30T08:00:00.000Z")
                .unwrap()
                .timestamp_millis(),
            updated_at_ms: DateTime::parse_from_rfc3339("2026-06-30T11:00:00.000Z")
                .unwrap()
                .timestamp_millis(),
            rollout_path: String::new(),
            usage_events: vec![
                UsageEvent {
                    thread_id: "claude-one".to_string(),
                    timestamp_ms: DateTime::parse_from_rfc3339("2026-06-30T11:00:00.000Z")
                        .unwrap()
                        .timestamp_millis(),
                    model: "claude-opus-4-8".to_string(),
                    total_tokens: 10_000,
                    plan_type: None,
                    rate_limits: None,
                },
                UsageEvent {
                    thread_id: "claude-one".to_string(),
                    timestamp_ms: DateTime::parse_from_rfc3339("2026-06-30T01:00:00.000Z")
                        .unwrap()
                        .timestamp_millis(),
                    model: "claude-opus-4-8".to_string(),
                    total_tokens: 1_000,
                    plan_type: None,
                    rate_limits: None,
                },
            ],
        }];

        let limits =
            build_claude_estimated_rate_limits(&threads, now).expect("limits should exist");

        assert_eq!(limits.windows.len(), 2);
        assert_eq!(limits.windows[0].window_minutes, 300);
        assert_eq!(limits.windows[0].used_percent, 2.0);
        assert_eq!(limits.windows[0].remaining_percent, 98.0);
        assert_eq!(limits.windows[1].window_minutes, 10080);
        assert!((limits.windows[1].used_percent - 0.44).abs() < f64::EPSILON);
    }

    #[test]
    fn read_copilot_jsonish_file_uses_usage_and_text_estimates() {
        let file_path = temp_jsonl_path("copilot-chat.jsonl");
        let rows = [
            json!({
              "sessionId": "copilot-one",
              "title": "Copilot session",
              "workspaceFolder": "/work/copilot-app"
            }),
            json!({
              "role": "assistant",
              "timestamp": "2026-06-30T10:00:00.000Z",
              "model": "gpt-4.1",
              "content": "Here is the answer.",
              "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5
              }
            }),
            json!({
              "role": "user",
              "timestamp": "2026-06-30T10:00:05.000Z",
              "content": "hello world"
            }),
        ];
        let mut file = File::create(&file_path).expect("test jsonl should be created");
        for row in rows {
            writeln!(file, "{row}").expect("test jsonl row should be written");
        }

        let session = read_copilot_jsonish_file(&file_path).expect("copilot session should parse");

        assert_eq!(session.id, "copilot-one");
        assert_eq!(session.title, "Copilot session");
        assert_eq!(session.source, "VS Code");
        assert_eq!(session.model, "gpt-4.1");
        assert_eq!(session.cwd, "/work/copilot-app");
        assert_eq!(session.tokens_used, 18);
        assert_eq!(session.usage_events.len(), 2);

        let _ = fs::remove_dir_all(file_path.parent().unwrap());
    }

    #[test]
    fn read_github_copilot_account_uses_vscode_state() {
        let db_path = temp_jsonl_path("state.vscdb");
        let global_storage = db_path.parent().unwrap().to_path_buf();
        let copilot_storage = global_storage.join("github.copilot-chat");
        fs::create_dir_all(&copilot_storage).expect("copilot storage should be created");
        let connection = Connection::open(&db_path).expect("state db should be created");
        connection
            .execute(
                "create table ItemTable (key text primary key, value text)",
                [],
            )
            .expect("item table should be created");
        connection
            .execute(
                "insert into ItemTable (key, value) values (?1, ?2)",
                rusqlite::params![
                    "github-octocat",
                    r#"[{"id":"vscode.github","allowed":true}]"#
                ],
            )
            .expect("github account row should be inserted");
        connection
            .execute(
                "insert into ItemTable (key, value) values (?1, ?2)",
                rusqlite::params![
                    "GitHub.copilot-chat",
                    r#"{"exp.github.copilot.sku":"free_limited_copilot"}"#
                ],
            )
            .expect("copilot sku row should be inserted");

        let account = read_github_copilot_account(&[copilot_storage]);

        assert_eq!(account.display_name, "octocat");
        assert_eq!(account.initials, "O");
        assert_eq!(account.plan_type.as_deref(), Some("free_limited_copilot"));
        assert_eq!(account.plan_label, "GitHub Copilot Free Limited");

        let _ = fs::remove_dir_all(global_storage);
    }

    #[test]
    fn read_cursor_account_uses_state_identity() {
        let db_path = temp_jsonl_path("state.vscdb");
        let storage = db_path.parent().unwrap().to_path_buf();
        let connection = Connection::open(&db_path).expect("state db should be created");
        connection
            .execute(
                "create table ItemTable (key text primary key, value text)",
                [],
            )
            .expect("item table should be created");
        connection
            .execute(
                "insert into ItemTable (key, value) values (?1, ?2)",
                rusqlite::params![
                    "cursor.account",
                    r#"{"email":"cursor@example.com","membershipType":"pro"}"#
                ],
            )
            .expect("cursor account row should be inserted");

        let account = read_cursor_account(&[storage.clone()]);

        assert_eq!(account.display_name, "cursor@example.com");
        assert_eq!(account.initials, "C");
        assert_eq!(account.plan_type.as_deref(), Some("pro"));
        assert_eq!(account.plan_label, "Cursor Pro");

        let _ = fs::remove_dir_all(storage);
    }

    #[test]
    fn read_cursor_jsonish_file_uses_cursor_labels() {
        let file_path = temp_jsonl_path("cursor-composer.jsonl");
        let rows = [
            json!({
              "conversationId": "cursor-one",
              "title": "Cursor composer",
              "workspacePath": "/work/cursor-app"
            }),
            json!({
              "role": "assistant",
              "timestamp": "2026-06-30T10:00:00.000Z",
              "content": "Cursor generated this response.",
              "usage": {
                "inputTokens": 12,
                "outputTokens": 8
              }
            }),
        ];
        let mut file = File::create(&file_path).expect("test jsonl should be created");
        for row in rows {
            writeln!(file, "{row}").expect("test jsonl row should be written");
        }

        let session = read_cursor_jsonish_file(&file_path).expect("cursor session should parse");

        assert_eq!(session.id, "cursor-one");
        assert_eq!(session.title, "Cursor composer");
        assert_eq!(session.source, "Cursor");
        assert_eq!(session.model, "Cursor");
        assert_eq!(session.cwd, "/work/cursor-app");
        assert_eq!(session.tokens_used, 20);
        assert_eq!(session.usage_events.len(), 1);

        let _ = fs::remove_dir_all(file_path.parent().unwrap());
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_stats,
            choose_home,
            start_window_drag,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Usage");
}
