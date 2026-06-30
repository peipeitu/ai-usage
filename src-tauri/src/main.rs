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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
  active_provider: String,
  codex_home: String,
  claude_home: String,
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
    codex_home: String::new(),
    claude_home: String::new(),
    language: default_language(),
    theme: "system".to_string(),
    accent_color: "blue".to_string(),
    chart_days: DEFAULT_CHART_DAYS,
  }
}

fn default_language() -> String {
  "auto".to_string()
}

fn normalize_settings(settings: Settings) -> Settings {
  let providers = ["codex", "claude"];
  let languages = ["auto", "zh", "en"];
  let themes = ["system", "light", "dark"];
  let accents = ["blue", "turquoise", "green", "purple", "red", "orange", "graphite"];

  Settings {
    active_provider: if providers.contains(&settings.active_provider.as_str()) {
      settings.active_provider
    } else {
      "codex".to_string()
    },
    codex_home: settings.codex_home,
    claude_home: settings.claude_home,
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
  let provider = if provider == "claude" { "claude" } else { "codex" }.to_string();
  let title = if provider == "claude" {
    "Select Claude Code data directory"
  } else {
    "Select Codex data directory"
  };

  let Some(folder) = rfd::FileDialog::new().set_title(title).pick_folder() else {
    return Ok(None);
  };

  let folder = folder.to_string_lossy().to_string();
  tauri::async_runtime::spawn_blocking(move || {
    let mut settings = load_settings();
    settings.active_provider = provider.clone();
    if provider == "claude" {
      settings.claude_home = folder;
    } else {
      settings.codex_home = folder;
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
    .and_then(|status| status.success().then_some(()).ok_or_else(|| "Unable to open URL".to_string()))
}

fn read_stats_for_provider(settings: &Settings, provider: &str) -> Result<Stats, String> {
  if provider == "claude" {
    read_claude_stats(settings)
  } else {
    read_codex_stats(settings)
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
    .and_then(|auth| auth.pointer("/tokens/id_token").and_then(Value::as_str).map(str::to_string))
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
      let updated = updated_at_ms.unwrap_or_else(|| updated_at.unwrap_or(created / 1000) * 1000);
      let source: Option<String> = row.get(2)?;

      Ok(Thread {
        id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
        title: row.get::<_, Option<String>>(1)?.unwrap_or_else(|| "Untitled".to_string()),
        source: source_label(source.as_deref()),
        model: row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "Unknown".to_string()),
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

  rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
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
    plan_type: rate_limits.get("plan_type").and_then(Value::as_str).map(str::to_string),
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
        total_tokens: usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
        plan_type: entry
          .pointer("/payload/rate_limits/plan_type")
          .and_then(Value::as_str)
          .map(str::to_string),
        rate_limits: normalize_rate_limits(entry.pointer("/payload/rate_limits"), timestamp_ms),
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
  let usage_events: Vec<UsageEvent> = threads.iter().flat_map(|thread| thread.usage_events.clone()).collect();
  let has_usage_events = !usage_events.is_empty();
  let today_start_ms = start_of_local_day_ms(now);
  let period_start_ms = today_start_ms - (chart_days as i64 - 1) * 24 * 60 * 60 * 1000;
  let recent_threshold = now.timestamp_millis() - 7 * 24 * 60 * 60 * 1000;
  let active_threads = threads.iter().filter(|thread| !thread.archived).count();
  let total_tokens = threads.iter().map(|thread| thread.tokens_used).sum();
  let updated_this_week = threads.iter().filter(|thread| thread.updated_at_ms >= recent_threshold).count();

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
    threads.first().map(|thread| thread.tokens_used).unwrap_or(0)
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
    models: rank_by_tokens(threads.iter().map(|thread| (thread.model.clone(), thread.tokens_used)), 6),
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
      format!("Codex state database not found at {}", state_db.to_string_lossy()),
      paths,
    ));
  }

  let mut threads = read_codex_threads(&state_db)?;
  let usage_events = read_codex_usage_events(&threads);
  let mut usage_by_thread: HashMap<String, Vec<UsageEvent>> = HashMap::new();
  for event in usage_events {
    usage_by_thread.entry(event.thread_id.clone()).or_default().push(event);
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
  usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0)
    + usage
      .get("cache_creation_input_tokens")
      .and_then(Value::as_u64)
      .unwrap_or(0)
    + usage
      .get("cache_read_input_tokens")
      .and_then(Value::as_u64)
      .unwrap_or(0)
    + usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0)
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
    if entry.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
      sidechain = true;
    }

    let timestamp_ms = entry
      .get("timestamp")
      .and_then(Value::as_str)
      .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
      .map(|timestamp| timestamp.timestamp_millis());
    if let Some(timestamp_ms) = timestamp_ms {
      created_at_ms = Some(created_at_ms.map_or(timestamp_ms, |value| value.min(timestamp_ms)));
      updated_at_ms = Some(updated_at_ms.map_or(timestamp_ms, |value| value.max(timestamp_ms)));
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
      .unwrap_or_else(|| format!("{}:{}:{}", id, timestamp_ms.unwrap_or(0), usage_by_message.len()));
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
      format!("Claude Code session logs not found at {}", projects_path.to_string_lossy()),
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

  let account = Account {
    display_name: "Claude Code".to_string(),
    initials: "CC".to_string(),
    plan_type: None,
    plan_label: "Claude Code".to_string(),
    plan_monthly_usd: None,
  };
  let pricing = Some(Pricing {
    label: "Local token estimate".to_string(),
    url: None,
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
    time::{SystemTime, UNIX_EPOCH},
  };

  fn test_account() -> Account {
    Account {
      display_name: "Codex".to_string(),
      initials: "CD".to_string(),
      plan_type: None,
      plan_label: "Codex".to_string(),
      plan_monthly_usd: None,
    }
  }

  fn temp_jsonl_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("system time should be after unix epoch")
      .as_nanos();
    let dir = env::temp_dir().join(format!("ai-usage-test-{nonce}"));
    fs::create_dir_all(&dir).expect("test temp dir should be created");
    dir.join(name)
  }

  #[test]
  fn source_label_normalizes_known_sources() {
    assert_eq!(source_label(Some(r#"{"subagent":{"other":"guardian"}}"#)), "子任务");
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
    assert_eq!(stats.rate_limits.as_ref().unwrap().windows[0].label, "5 小时");
    assert_eq!(stats.rate_limits.as_ref().unwrap().windows[0].remaining_percent, 92.0);
    assert_eq!(stats.models[0].name, "gpt-5.5");
    assert!(stats.sources.iter().any(|source| source.name == "VS Code" && source.value == 1));
    assert!(stats.sources.iter().any(|source| source.name == "子任务" && source.value == 1));
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
