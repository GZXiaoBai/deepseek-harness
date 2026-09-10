use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};

static PROCESS_STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// Captures the native process timing origin before Tauri initialization.
pub fn mark_process_started() {
    PROCESS_STARTED_AT.get_or_init(Instant::now);
}

/// Machine-readable desktop timings measured from native process setup.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPerformanceStats {
    pub process_start_ms: u64,
    pub sidecar_spawn_ms: Option<u64>,
    pub plugin_tree_ready_ms: Option<u64>,
    pub http_ready_ms: Option<u64>,
    pub page_loaded_ms: Option<u64>,
    pub shutdown_ms: Option<u64>,
    pub forced_termination_count: u64,
}

/// Owns the monotonic timing origin and persists the latest complete snapshot.
pub struct PerformanceRecorder {
    started_at: Instant,
    path: PathBuf,
    stats: Mutex<DesktopPerformanceStats>,
}

impl PerformanceRecorder {
    pub fn new(user_data: &Path) -> Self {
        Self {
            started_at: *PROCESS_STARTED_AT.get_or_init(Instant::now),
            path: user_data.join("Logs").join("desktop-performance.json"),
            stats: Mutex::new(DesktopPerformanceStats::default()),
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    pub fn record_sidecar_spawn(&self) {
        self.update(|stats, elapsed| stats.sidecar_spawn_ms = Some(elapsed));
    }

    pub fn record_sidecar_phase(&self, phase: &str) {
        match phase {
            "plugin-tree-ready" => {
                self.update(|stats, value| stats.plugin_tree_ready_ms = Some(value))
            }
            "http-ready" => self.update(|stats, value| stats.http_ready_ms = Some(value)),
            _ => {}
        }
    }

    pub fn record_page_loaded(&self) {
        self.update(|stats, elapsed| stats.page_loaded_ms = Some(elapsed));
    }

    pub fn record_shutdown(&self, forced_termination_count: u64) {
        self.update(|stats, elapsed| {
            stats.shutdown_ms = Some(elapsed);
            stats.forced_termination_count = forced_termination_count;
        });
    }

    fn update(&self, change: impl FnOnce(&mut DesktopPerformanceStats, u64)) {
        self.update_at(self.elapsed_ms(), change);
    }

    fn update_at(&self, elapsed: u64, change: impl FnOnce(&mut DesktopPerformanceStats, u64)) {
        let mut stats = self.stats.lock().unwrap_or_else(|error| error.into_inner());
        change(&mut stats, elapsed);
        if let Ok(json) = serde_json::to_vec_pretty(&*stats) {
            let _ = fs::write(&self.path, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn persists_complete_camel_case_timings() {
        let directory = std::env::temp_dir().join(format!(
            "dsh-desktop-performance-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        fs::create_dir_all(directory.join("Logs")).unwrap();
        let recorder = PerformanceRecorder::new(&directory);
        thread::sleep(Duration::from_millis(2));
        recorder.record_sidecar_spawn();
        thread::sleep(Duration::from_millis(1));
        recorder.record_sidecar_phase("plugin-tree-ready");
        thread::sleep(Duration::from_millis(1));
        recorder.record_sidecar_phase("http-ready");
        recorder.record_page_loaded();
        recorder.record_shutdown(0);

        let json = fs::read(directory.join("Logs/desktop-performance.json")).unwrap();
        let stats: DesktopPerformanceStats = serde_json::from_slice(&json).unwrap();
        assert!(stats.sidecar_spawn_ms.is_some_and(|value| value >= 2));
        assert!(stats.plugin_tree_ready_ms > stats.sidecar_spawn_ms);
        assert!(stats.http_ready_ms > stats.plugin_tree_ready_ms);
        assert!(stats.page_loaded_ms.is_some());
        assert!(stats.shutdown_ms >= stats.page_loaded_ms);
        assert_eq!(stats.forced_termination_count, 0);
        let text = String::from_utf8(json).unwrap();
        assert!(text.contains("\"pageLoadedMs\""));
        assert!(!text.contains("page_loaded_ms"));
        fs::remove_dir_all(directory).unwrap();
    }
}
