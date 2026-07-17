use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Instant, UNIX_EPOCH},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};

const CACHE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanDiagnostics {
    pub provider: String,
    pub elapsed_ms: u64,
    pub total_files: usize,
    pub cache_hits: usize,
    pub parsed_files: usize,
    pub deleted_files: usize,
    pub failed_files: usize,
    pub cache_hit_rate: f64,
    pub cache_status: String,
    pub forced: bool,
    pub cache_write_succeeded: bool,
}

impl ScanDiagnostics {
    pub(crate) fn empty(provider: &str, forced: bool) -> Self {
        Self {
            provider: provider.to_string(),
            cache_status: if forced { "forced" } else { "not-used" }.to_string(),
            forced,
            cache_write_succeeded: true,
            ..Self::default()
        }
    }

    pub(crate) fn record(&self) {
        eprintln!(
            "[scan] provider={} elapsed_ms={} total_files={} cache_hits={} parsed_files={} deleted_files={} failed_files={} hit_rate={:.1}% cache_status={} forced={} cache_write_succeeded={}",
            self.provider,
            self.elapsed_ms,
            self.total_files,
            self.cache_hits,
            self.parsed_files,
            self.deleted_files,
            self.failed_files,
            self.cache_hit_rate,
            self.cache_status,
            self.forced,
            self.cache_write_succeeded,
        );
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ScanRequest {
    pub provider: String,
    pub parser_version: String,
    pub source_key: String,
    pub cache_path: PathBuf,
    pub files: Vec<PathBuf>,
    pub force: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct ScannedFile<T> {
    pub path: PathBuf,
    pub values: Vec<T>,
}

#[derive(Clone, Debug)]
pub(crate) struct ScanOutcome<T> {
    pub files: Vec<ScannedFile<T>>,
    pub diagnostics: ScanDiagnostics,
}

impl<T> ScanOutcome<T> {
    pub(crate) fn into_values(self) -> Vec<T> {
        self.files
            .into_iter()
            .flat_map(|file| file.values)
            .collect()
    }
}

#[derive(Default)]
pub(crate) struct ScanCacheStore {
    transaction_lock: Mutex<()>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    normalized_path: String,
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
    auxiliary_files: Vec<AuxiliaryFingerprint>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AuxiliaryFingerprint {
    suffix: String,
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CacheEntry<T> {
    fingerprint: FileFingerprint,
    values: Vec<T>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile<T> {
    schema_version: u32,
    parser_version: String,
    provider: String,
    source_key: String,
    files: BTreeMap<String, CacheEntry<T>>,
}

enum CacheLoad<T> {
    Valid(CacheFile<T>),
    Missing,
    Corrupt,
    Incompatible,
    Forced,
}

impl ScanCacheStore {
    pub(crate) fn scan<T, F>(&self, request: ScanRequest, mut parse_file: F) -> ScanOutcome<T>
    where
        T: Clone + DeserializeOwned + Serialize,
        F: FnMut(&Path) -> Result<Vec<T>, String>,
    {
        let _transaction = self
            .transaction_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let started_at = Instant::now();
        let loaded = load_cache::<T>(&request);
        let (old_files, cache_status) = match loaded {
            CacheLoad::Valid(cache) => (cache.files, "hit"),
            CacheLoad::Missing => (BTreeMap::new(), "cold"),
            CacheLoad::Corrupt => (BTreeMap::new(), "corrupt-rebuilt"),
            CacheLoad::Incompatible => (BTreeMap::new(), "incompatible-rebuilt"),
            CacheLoad::Forced => (BTreeMap::new(), "forced"),
        };

        let mut diagnostics = ScanDiagnostics {
            provider: request.provider.clone(),
            cache_status: cache_status.to_string(),
            forced: request.force,
            ..ScanDiagnostics::default()
        };
        let mut current_paths = BTreeMap::new();
        for path in request.files {
            match fingerprint(&path) {
                Ok(fingerprint) => {
                    current_paths
                        .entry(fingerprint.normalized_path.clone())
                        .or_insert((path, fingerprint));
                }
                Err(_) => diagnostics.failed_files += 1,
            }
        }
        diagnostics.total_files = current_paths.len() + diagnostics.failed_files;
        diagnostics.deleted_files = old_files
            .keys()
            .filter(|path| !current_paths.contains_key(*path))
            .count();

        let mut next_files = BTreeMap::new();
        let mut output_files = Vec::new();
        for (normalized_path, (path, initial_fingerprint)) in current_paths {
            if let Some(entry) = old_files
                .get(&normalized_path)
                .filter(|entry| entry.fingerprint == initial_fingerprint)
            {
                diagnostics.cache_hits += 1;
                next_files.insert(normalized_path, entry.clone());
                output_files.push(ScannedFile {
                    path,
                    values: entry.values.clone(),
                });
                continue;
            }

            diagnostics.parsed_files += 1;
            match parse_stable_file(&path, initial_fingerprint, &mut parse_file) {
                Ok((fingerprint, values)) => {
                    next_files.insert(
                        normalized_path,
                        CacheEntry {
                            fingerprint,
                            values: values.clone(),
                        },
                    );
                    output_files.push(ScannedFile { path, values });
                }
                Err(_) => diagnostics.failed_files += 1,
            }
        }

        diagnostics.cache_hit_rate = if diagnostics.total_files == 0 {
            0.0
        } else {
            diagnostics.cache_hits as f64 / diagnostics.total_files as f64 * 100.0
        };
        let cache = CacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            parser_version: request.parser_version,
            provider: request.provider,
            source_key: request.source_key,
            files: next_files,
        };
        let should_write = cache_status != "hit"
            || diagnostics.parsed_files > 0
            || diagnostics.deleted_files > 0
            || diagnostics.failed_files > 0;
        diagnostics.cache_write_succeeded =
            !should_write || super::write_json_file(&request.cache_path, &cache).is_ok();
        diagnostics.elapsed_ms = started_at
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);

        ScanOutcome {
            files: output_files,
            diagnostics,
        }
    }
}

fn load_cache<T>(request: &ScanRequest) -> CacheLoad<T>
where
    T: DeserializeOwned,
{
    if request.force {
        return CacheLoad::Forced;
    }
    let content = match fs::read_to_string(&request.cache_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return CacheLoad::Missing,
        Err(_) => return CacheLoad::Corrupt,
    };
    let cache = match serde_json::from_str::<CacheFile<T>>(&content) {
        Ok(cache) => cache,
        Err(_) => return CacheLoad::Corrupt,
    };
    if cache.schema_version != CACHE_SCHEMA_VERSION
        || cache.parser_version != request.parser_version
        || cache.provider != request.provider
        || cache.source_key != request.source_key
    {
        return CacheLoad::Incompatible;
    }
    CacheLoad::Valid(cache)
}

fn parse_stable_file<T, F>(
    path: &Path,
    mut before: FileFingerprint,
    parse_file: &mut F,
) -> Result<(FileFingerprint, Vec<T>), String>
where
    F: FnMut(&Path) -> Result<Vec<T>, String>,
{
    for _ in 0..2 {
        let values = parse_file(path)?;
        let after = fingerprint(path)?;
        if before == after {
            return Ok((after, values));
        }
        before = after;
    }
    Err("file changed while it was being parsed".to_string())
}

fn fingerprint(path: &Path) -> Result<FileFingerprint, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("scan candidate is not a regular file".to_string());
    }
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let duration = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    let mut auxiliary_files = Vec::new();
    if is_sqlite_path(path) {
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar_name = path.as_os_str().to_os_string();
            sidecar_name.push(suffix);
            let sidecar_path = PathBuf::from(sidecar_name);
            match fs::metadata(&sidecar_path) {
                Ok(sidecar_metadata) => {
                    let sidecar_modified = sidecar_metadata
                        .modified()
                        .map_err(|error| error.to_string())?;
                    let sidecar_duration = sidecar_modified
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default();
                    auxiliary_files.push(AuxiliaryFingerprint {
                        suffix: suffix.to_string(),
                        size: sidecar_metadata.len(),
                        modified_secs: sidecar_duration.as_secs(),
                        modified_nanos: sidecar_duration.subsec_nanos(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(FileFingerprint {
        normalized_path: normalize_existing_path(path),
        size: metadata.len(),
        modified_secs: duration.as_secs(),
        modified_nanos: duration.subsec_nanos(),
        auxiliary_files,
    })
}

fn is_sqlite_path(path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("state.vscdb"))
        .unwrap_or(false)
    {
        return true;
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            ["sqlite", "sqlite3", "db"].contains(&extension.to_ascii_lowercase().as_str())
        })
        .unwrap_or(false)
}

pub(crate) fn cache_source_key(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| normalize_existing_path(path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_existing_path(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_platform_path(&path)
}

fn normalize_platform_path(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        return normalize_windows_path_text(&path.to_string_lossy());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut output = PathBuf::new();
        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    output.pop();
                }
                component => output.push(component.as_os_str()),
            }
        }
        output.to_string_lossy().to_string()
    }
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn normalize_windows_path_text(value: &str) -> String {
    let mut replaced = value.replace('\\', "/");
    let lowercase = replaced.to_ascii_lowercase();
    if lowercase.starts_with("//?/unc/") {
        replaced = format!("//{}", &replaced[8..]);
    } else if lowercase.starts_with("//?/") {
        replaced = replaced[4..].to_string();
    }
    let is_unc = replaced.starts_with("//");
    let mut prefix = String::new();
    let mut rest = replaced.as_str();
    if is_unc {
        prefix.push_str("//");
        rest = rest.trim_start_matches('/');
    } else if replaced.as_bytes().get(1) == Some(&b':') {
        prefix.push_str(&replaced[..2].to_ascii_lowercase());
        rest = replaced[2..].trim_start_matches('/');
        prefix.push('/');
    }

    let mut parts = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part.to_ascii_lowercase()),
        }
    }
    format!("{prefix}{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::File,
        io::Write,
        sync::{
            atomic::{AtomicU64, AtomicUsize, Ordering},
            Arc,
        },
        thread,
    };

    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-usage-cache-{name}-{}-{}",
            std::process::id(),
            FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(dir: &Path, files: Vec<PathBuf>) -> ScanRequest {
        ScanRequest {
            provider: "fixture".to_string(),
            parser_version: "fixture-v1".to_string(),
            source_key: cache_source_key(&[dir.to_path_buf()]),
            cache_path: dir.join("cache.json"),
            files,
            force: false,
        }
    }

    fn parse_number(path: &Path) -> Result<Vec<u64>, String> {
        fs::read_to_string(path)
            .map_err(|error| error.to_string())?
            .trim()
            .parse::<u64>()
            .map(|value| vec![value])
            .map_err(|error| error.to_string())
    }

    fn semantic_stats(threads: Vec<crate::Thread>) -> serde_json::Value {
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-17T12:00:00.000+08:00")
            .unwrap()
            .with_timezone(&chrono::Local);
        let stats = crate::build_stats_from_threads(
            threads,
            now,
            30,
            crate::Account {
                display_name: "Fixture".to_string(),
                initials: "FX".to_string(),
                plan_type: None,
                plan_label: "Fixture".to_string(),
                plan_monthly_usd: None,
            },
            None,
            None,
            false,
            serde_json::json!({}),
        );
        let mut value = serde_json::to_value(stats).unwrap();
        value["generatedAt"] = serde_json::Value::Null;
        value
    }

    fn write_claude_fixture(path: &Path, session_id: &str, tokens: u64) {
        let rows = [
            serde_json::json!({
                "sessionId": session_id,
                "timestamp": "2026-07-17T01:00:00.000Z",
                "cwd": "/fixture/project"
            }),
            serde_json::json!({
                "sessionId": session_id,
                "type": "assistant",
                "timestamp": "2026-07-17T02:00:00.000Z",
                "message": {
                    "id": format!("message-{session_id}"),
                    "model": "claude-fixture",
                    "usage": { "input_tokens": tokens }
                }
            }),
        ];
        let mut file = File::create(path).unwrap();
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
    }

    #[test]
    fn cold_hot_and_incremental_results_are_equivalent() {
        let dir = fixture_dir("equivalence");
        let first = dir.join("first.jsonl");
        let second = dir.join("second.jsonl");
        fs::write(&first, "10").unwrap();
        fs::write(&second, "20").unwrap();
        let store = ScanCacheStore::default();

        let cold = store.scan(
            request(&dir, vec![first.clone(), second.clone()]),
            parse_number,
        );
        assert_eq!(cold.clone().into_values(), vec![10, 20]);
        assert_eq!(cold.diagnostics.parsed_files, 2);
        assert_eq!(cold.diagnostics.cache_hits, 0);

        let hot = store.scan(
            request(&dir, vec![first.clone(), second.clone()]),
            parse_number,
        );
        assert_eq!(hot.clone().into_values(), vec![10, 20]);
        assert_eq!(hot.diagnostics.cache_hits, 2);
        assert_eq!(hot.diagnostics.parsed_files, 0);

        let third = dir.join("third.jsonl");
        fs::write(&third, "30").unwrap();
        fs::write(&first, "100").unwrap();
        let changed = store.scan(
            request(&dir, vec![first.clone(), second.clone(), third.clone()]),
            parse_number,
        );
        assert_eq!(changed.clone().into_values(), vec![100, 20, 30]);
        assert_eq!(changed.diagnostics.cache_hits, 1);
        assert_eq!(changed.diagnostics.parsed_files, 2);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cold_hot_incremental_and_forced_provider_stats_are_equivalent() {
        let dir = fixture_dir("provider-equivalence");
        let first = dir.join("first.jsonl");
        let second = dir.join("second.jsonl");
        write_claude_fixture(&first, "first", 10);
        write_claude_fixture(&second, "second", 20);
        let store = ScanCacheStore::default();
        let parse = |path: &Path| {
            File::open(path).map_err(|error| error.to_string())?;
            Ok(crate::read_claude_session(path).into_iter().collect())
        };

        let cold = store.scan(request(&dir, vec![first.clone(), second.clone()]), parse);
        let hot = store.scan(request(&dir, vec![first.clone(), second.clone()]), parse);
        assert_eq!(
            semantic_stats(cold.clone().into_values()),
            semantic_stats(hot.clone().into_values())
        );
        assert_eq!(hot.diagnostics.cache_hits, 2);

        write_claude_fixture(&first, "first", 100);
        let incremental = store.scan(request(&dir, vec![first.clone(), second.clone()]), parse);
        let mut forced_request = request(&dir, vec![first, second]);
        forced_request.force = true;
        let forced = store.scan(forced_request, parse);
        assert_eq!(
            semantic_stats(incremental.clone().into_values()),
            semantic_stats(forced.clone().into_values())
        );
        assert_eq!(incremental.diagnostics.cache_hits, 1);
        assert_eq!(incremental.diagnostics.parsed_files, 1);

        fs::remove_file(dir.join("second.jsonl")).unwrap();
        let remaining_file = dir.join("first.jsonl");
        let deleted = store.scan(request(&dir, vec![remaining_file.clone()]), parse);
        let mut forced_after_delete = request(&dir, vec![remaining_file]);
        forced_after_delete.force = true;
        let forced_after_delete = store.scan(forced_after_delete, parse);
        assert_eq!(
            semantic_stats(deleted.clone().into_values()),
            semantic_stats(forced_after_delete.into_values())
        );
        assert_eq!(deleted.diagnostics.deleted_files, 1);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn append_truncate_replace_and_delete_invalidate_entries() {
        let dir = fixture_dir("mutations");
        let path = dir.join("session.jsonl");
        fs::write(&path, "1").unwrap();
        let store = ScanCacheStore::default();
        store.scan(request(&dir, vec![path.clone()]), parse_number);

        fs::write(&path, "12").unwrap();
        let appended = store.scan(request(&dir, vec![path.clone()]), parse_number);
        assert_eq!(appended.clone().into_values(), vec![12]);
        assert_eq!(appended.diagnostics.parsed_files, 1);

        fs::write(&path, "2").unwrap();
        let truncated = store.scan(request(&dir, vec![path.clone()]), parse_number);
        assert_eq!(truncated.clone().into_values(), vec![2]);
        assert_eq!(truncated.diagnostics.parsed_files, 1);

        let replacement = dir.join("replacement.tmp");
        fs::write(&replacement, "300").unwrap();
        fs::rename(&replacement, &path).unwrap();
        let replaced = store.scan(request(&dir, vec![path.clone()]), parse_number);
        assert_eq!(replaced.clone().into_values(), vec![300]);
        assert_eq!(replaced.diagnostics.parsed_files, 1);

        fs::remove_file(&path).unwrap();
        let deleted = store.scan(request(&dir, Vec::new()), parse_number);
        assert!(deleted.clone().into_values().is_empty());
        assert_eq!(deleted.diagnostics.deleted_files, 1);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sqlite_sidecar_changes_invalidate_the_main_file_entry() {
        let dir = fixture_dir("sqlite-sidecar");
        let database = dir.join("state.db");
        let wal = dir.join("state.db-wal");
        fs::write(&database, "41").unwrap();
        fs::write(&wal, "first wal state").unwrap();
        let store = ScanCacheStore::default();
        store.scan(request(&dir, vec![database.clone()]), parse_number);

        let hot = store.scan(request(&dir, vec![database.clone()]), parse_number);
        assert_eq!(hot.diagnostics.cache_hits, 1);
        fs::write(&wal, "a newer and larger wal state").unwrap();
        let invalidated = store.scan(request(&dir, vec![database]), parse_number);
        assert_eq!(invalidated.diagnostics.cache_hits, 0);
        assert_eq!(invalidated.diagnostics.parsed_files, 1);
        assert_eq!(invalidated.into_values(), vec![41]);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_and_incompatible_caches_rebuild_without_old_data() {
        let dir = fixture_dir("recovery");
        let path = dir.join("session.jsonl");
        fs::write(&path, "7").unwrap();
        let store = ScanCacheStore::default();
        store.scan(request(&dir, vec![path.clone()]), parse_number);

        fs::write(dir.join("cache.json"), "{broken").unwrap();
        fs::write(&path, "88").unwrap();
        let corrupt = store.scan(request(&dir, vec![path.clone()]), parse_number);
        assert_eq!(corrupt.clone().into_values(), vec![88]);
        assert_eq!(corrupt.diagnostics.cache_status, "corrupt-rebuilt");
        assert_eq!(corrupt.diagnostics.cache_hits, 0);

        let mut upgraded = request(&dir, vec![path.clone()]);
        upgraded.parser_version = "fixture-v2".to_string();
        let incompatible = store.scan(upgraded, parse_number);
        assert_eq!(incompatible.clone().into_values(), vec![88]);
        assert_eq!(
            incompatible.diagnostics.cache_status,
            "incompatible-rebuilt"
        );
        assert_eq!(incompatible.diagnostics.cache_hits, 0);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parse_failures_do_not_reuse_or_permanently_cache_old_results() {
        let dir = fixture_dir("failure");
        let path = dir.join("session.jsonl");
        fs::write(&path, "5").unwrap();
        let store = ScanCacheStore::default();
        store.scan(request(&dir, vec![path.clone()]), parse_number);

        fs::write(&path, "invalid").unwrap();
        let failed = store.scan(request(&dir, vec![path.clone()]), parse_number);
        assert!(failed.clone().into_values().is_empty());
        assert_eq!(failed.diagnostics.failed_files, 1);
        assert_eq!(failed.diagnostics.cache_hits, 0);

        fs::write(&path, "9").unwrap();
        let recovered = store.scan(request(&dir, vec![path.clone()]), parse_number);
        assert_eq!(recovered.clone().into_values(), vec![9]);
        assert_eq!(recovered.diagnostics.parsed_files, 1);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn force_mode_reparses_all_files() {
        let dir = fixture_dir("force");
        let path = dir.join("session.jsonl");
        fs::write(&path, "11").unwrap();
        let store = ScanCacheStore::default();
        store.scan(request(&dir, vec![path.clone()]), parse_number);

        let mut forced_request = request(&dir, vec![path]);
        forced_request.force = true;
        let forced = store.scan(forced_request, parse_number);
        assert_eq!(forced.diagnostics.cache_status, "forced");
        assert_eq!(forced.diagnostics.cache_hits, 0);
        assert_eq!(forced.diagnostics.parsed_files, 1);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_scans_share_one_serialized_cache_transaction() {
        let dir = fixture_dir("concurrent");
        let path = dir.join("session.jsonl");
        fs::write(&path, "42").unwrap();
        let store = Arc::new(ScanCacheStore::default());
        let parses = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let store = store.clone();
            let parses = parses.clone();
            let dir = dir.clone();
            let path = path.clone();
            handles.push(thread::spawn(move || {
                store.scan(request(&dir, vec![path]), |path| {
                    parses.fetch_add(1, Ordering::SeqCst);
                    parse_number(path)
                })
            }));
        }
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(parses.load(Ordering::SeqCst), 1);
        assert!(outcomes
            .iter()
            .all(|outcome| outcome.clone().into_values() == vec![42]));
        assert_eq!(
            outcomes
                .iter()
                .map(|outcome| outcome.diagnostics.cache_hits)
                .sum::<usize>(),
            1
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn windows_paths_are_separator_and_case_stable() {
        assert_eq!(
            normalize_windows_path_text(r"C:\Users\Example\.codex\sessions\..\rollout.jsonl"),
            "c:/users/example/.codex/rollout.jsonl"
        );
        assert_eq!(
            normalize_windows_path_text(r"\\Server\Share\Logs\SESSION.JSONL"),
            "//server/share/logs/session.jsonl"
        );
        assert_eq!(
            normalize_windows_path_text(r"\\?\C:\Users\Example\Logs\session.jsonl"),
            "c:/users/example/logs/session.jsonl"
        );
        assert_eq!(
            normalize_windows_path_text(r"\\?\UNC\Server\Share\Logs\session.jsonl"),
            "//server/share/logs/session.jsonl"
        );
    }

    #[test]
    fn write_interruption_sibling_does_not_poison_valid_cache() {
        let dir = fixture_dir("interrupted");
        let path = dir.join("session.jsonl");
        fs::write(&path, "17").unwrap();
        let store = ScanCacheStore::default();
        store.scan(request(&dir, vec![path.clone()]), parse_number);
        let mut interrupted = File::create(dir.join(".cache.json.interrupted.tmp")).unwrap();
        interrupted.write_all(b"{partial").unwrap();

        let hot = store.scan(request(&dir, vec![path]), parse_number);
        assert_eq!(hot.clone().into_values(), vec![17]);
        assert_eq!(hot.diagnostics.cache_hits, 1);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "benchmark-style controlled fixture"]
    fn controlled_fixture_reports_cold_and_hot_metrics() {
        let dir = fixture_dir("metrics");
        let mut files = Vec::new();
        for index in 0..2_000_u64 {
            let path = dir.join(format!("session-{index:04}.jsonl"));
            fs::write(&path, index.to_string()).unwrap();
            files.push(path);
        }
        let store = ScanCacheStore::default();
        let cold = store.scan(request(&dir, files.clone()), parse_number);
        let hot = store.scan(request(&dir, files), parse_number);

        eprintln!(
            "controlled_fixture files={} cold_ms={} cold_parsed={} hot_ms={} hot_hits={} hot_parsed={}",
            cold.diagnostics.total_files,
            cold.diagnostics.elapsed_ms,
            cold.diagnostics.parsed_files,
            hot.diagnostics.elapsed_ms,
            hot.diagnostics.cache_hits,
            hot.diagnostics.parsed_files,
        );
        assert_eq!(cold.diagnostics.parsed_files, 2_000);
        assert_eq!(hot.diagnostics.cache_hits, 2_000);
        assert_eq!(hot.diagnostics.parsed_files, 0);
        assert_eq!(cold.into_values(), hot.into_values());

        fs::remove_dir_all(dir).unwrap();
    }
}
