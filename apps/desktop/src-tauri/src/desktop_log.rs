use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const RETAINED_LOGS: usize = 3;

pub struct DesktopLog {
    path: PathBuf,
    writer: Mutex<File>,
}

impl DesktopLog {
    pub fn open(user_data: &Path) -> io::Result<Self> {
        let directory = user_data.join("Logs");
        fs::create_dir_all(&directory)?;
        let path = directory.join("desktop.log");
        rotate_if_needed(&path, MAX_LOG_BYTES, RETAINED_LOGS)?;
        let writer = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            writer: Mutex::new(writer),
        })
    }

    pub fn directory(&self) -> &Path {
        self.path.parent().expect("desktop log always has a parent")
    }

    pub fn line(&self, source: &str, message: &str) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default();
        if let Ok(mut writer) = self.writer.lock() {
            let escaped = message.replace('\n', "\\n").replace('\r', "\\r");
            let _ = writeln!(writer, "{timestamp}\t{source}\t{escaped}");
            let _ = writer.flush();
        }
    }
}

fn rotate_if_needed(path: &Path, max_bytes: u64, retained: usize) -> io::Result<()> {
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) < max_bytes {
        return Ok(());
    }
    for index in (1..retained).rev() {
        let from = numbered_log(path, index);
        let to = numbered_log(path, index + 1);
        if from.exists() {
            let _ = fs::remove_file(&to);
            fs::rename(from, to)?;
        }
    }
    let first = numbered_log(path, 1);
    let _ = fs::remove_file(&first);
    fs::rename(path, first)
}

fn numbered_log(path: &Path, index: usize) -> PathBuf {
    path.with_file_name(format!("desktop.log.{index}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_bounded_log_generations() {
        let root = std::env::temp_dir().join(format!("dsh-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("desktop.log");
        fs::write(&path, b"oversized").unwrap();
        fs::write(numbered_log(&path, 1), b"prior").unwrap();

        rotate_if_needed(&path, 1, 3).unwrap();

        assert_eq!(fs::read(numbered_log(&path, 1)).unwrap(), b"oversized");
        assert_eq!(fs::read(numbered_log(&path, 2)).unwrap(), b"prior");
        let _ = fs::remove_dir_all(root);
    }
}
