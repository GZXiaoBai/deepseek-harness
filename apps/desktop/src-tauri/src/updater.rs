use crate::supervisor::DesktopRuntime;
use serde_json::{Map, Value};
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// Ensures the automatic update request starts once, after the Web UI is usable.
#[derive(Default)]
pub struct StartupUpdateGate {
    started: AtomicBool,
}

impl StartupUpdateGate {
    /// Claims the deferred automatic update request when the preference is enabled.
    pub fn begin(&self, enabled: bool) -> bool {
        enabled && !self.started.swap(true, Ordering::SeqCst)
    }
}

/// Reads the existing Electron-compatible updater preference without rewriting it.
pub fn automatic_updates_enabled(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return true;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("updater")?.get("autoUpdate")?.as_bool())
        .unwrap_or(true)
}

/// Persists the automatic-update toggle while preserving all other settings fields.
pub fn set_automatic_updates_enabled(path: &Path, enabled: bool) -> Result<(), String> {
    let mut root = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let updater = root
        .entry("updater")
        .or_insert_with(|| Value::Object(Map::new()));
    if !updater.is_object() {
        *updater = Value::Object(Map::new());
    }
    updater
        .as_object_mut()
        .expect("updater was normalized to an object")
        .insert("autoUpdate".into(), Value::Bool(enabled));
    let text = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

/// Checks, verifies, downloads, and applies a signed Tauri update.
pub fn check_for_updates(app: AppHandle, manual: bool) {
    tauri::async_runtime::spawn(async move {
        let runtime = app.state::<DesktopRuntime>();
        runtime.log_line("updater", "update check started");
        let result = async {
            let updater = app.updater().map_err(|error| error.to_string())?;
            let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
                if manual {
                    app.dialog()
                        .message("DeepSeek Harness is up to date.")
                        .title("No update available")
                        .show(|_| {});
                }
                return Ok::<(), String>(());
            };
            let version = update.version.clone();
            let accepted = app
                .dialog()
                .message(format!("Install DeepSeek Harness {version} now?"))
                .title("Update available")
                .buttons(MessageDialogButtons::YesNo)
                .blocking_show();
            if !accepted {
                runtime.log_line("updater", &format!("update declined version={version}"));
                return Ok(());
            }
            runtime.log_line(
                "updater",
                &format!("update download started version={version}"),
            );
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())?;
            runtime.log_line(
                "updater",
                &format!("update signature verified version={version}"),
            );
            if !runtime.prepare_for_update() {
                return Err("application is already closing".into());
            }
            update.install(bytes).map_err(|error| error.to_string())?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            let runtime = app.state::<DesktopRuntime>();
            runtime.log_line("updater", &format!("update failed: {error}"));
            if manual {
                app.dialog()
                    .message(error)
                    .title("Update failed")
                    .show(|_| {});
            }
            if runtime.has_terminated() {
                app.exit(1);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn migrates_and_preserves_legacy_settings() {
        let directory = std::env::temp_dir().join(format!(
            "dsh-tauri-settings-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("desktop-settings.json");
        fs::write(
            &path,
            r#"{"updater":{"repository":"owner/repo","channel":"prerelease","autoUpdate":false},"future":7}"#,
        )
        .unwrap();
        assert!(!automatic_updates_enabled(&path));
        set_automatic_updates_enabled(&path, true).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["updater"]["autoUpdate"], true);
        assert_eq!(value["updater"]["repository"], "owner/repo");
        assert_eq!(value["future"], 7);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_or_missing_settings_keep_automatic_updates_enabled() {
        let path = std::env::temp_dir().join("dsh-tauri-settings-missing.json");
        let _ = fs::remove_file(&path);
        assert!(automatic_updates_enabled(&path));
        fs::write(&path, "not json").unwrap();
        assert!(automatic_updates_enabled(&path));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn starts_the_deferred_automatic_check_once_after_page_readiness() {
        let gate = StartupUpdateGate::default();
        assert!(!gate.begin(false));
        assert!(gate.begin(true));
        assert!(!gate.begin(true));
    }
}
