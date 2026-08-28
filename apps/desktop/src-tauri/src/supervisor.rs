use crate::{
    desktop_log::DesktopLog,
    performance::PerformanceRecorder,
    protocol::{SidecarCommand, SidecarEvent, parse_event, serialize_command},
};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

pub struct NavigationState {
    origin: Mutex<Option<(String, String, u16)>>,
    authentication_reopen: Mutex<Option<url::Url>>,
}

impl NavigationState {
    pub fn new() -> Self {
        Self {
            origin: Mutex::new(None),
            authentication_reopen: Mutex::new(None),
        }
    }

    pub fn allows(&self, url: &url::Url) -> bool {
        if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
            return true;
        }
        let Ok(origin) = self.origin.lock() else {
            return false;
        };
        origin.as_ref().is_some_and(|(scheme, host, port)| {
            url.scheme() == scheme && url.host_str() == Some(host) && url.port() == Some(*port)
        })
    }

    pub fn is_ready_origin(&self, url: &url::Url) -> bool {
        let Ok(origin) = self.origin.lock() else {
            return false;
        };
        origin.as_ref().is_some_and(|(scheme, host, port)| {
            url.scheme() == scheme && url.host_str() == Some(host) && url.port() == Some(*port)
        })
    }

    pub fn opens_externally(&self, url: &url::Url) -> bool {
        if !matches!(url.scheme(), "http" | "https") {
            return false;
        }
        match url.host() {
            Some(url::Host::Domain(host)) => host != "localhost",
            Some(url::Host::Ipv4(host)) => !host.is_loopback(),
            Some(url::Host::Ipv6(host)) => !host.is_loopback(),
            None => false,
        }
    }

    fn set_ready_url(&self, url: &str) -> Result<(), String> {
        let parsed = url::Url::parse(url).map_err(|error| error.to_string())?;
        let host = parsed
            .host_str()
            .ok_or("ready URL is missing a host")?
            .to_owned();
        let port = parsed.port().ok_or("ready URL is missing a port")?;
        *self
            .origin
            .lock()
            .map_err(|_| "navigation state lock is poisoned")? =
            Some((parsed.scheme().to_owned(), host, port));
        let mut clean = parsed.clone();
        clean.set_query(None);
        *self
            .authentication_reopen
            .lock()
            .map_err(|_| "authentication navigation lock is poisoned")? =
            parsed.query().map(|_| clean);
        Ok(())
    }

    /// Takes the one clean-root navigation required after a launch-token response.
    pub fn take_authentication_reopen(&self) -> Option<url::Url> {
        self.authentication_reopen.lock().ok()?.take()
    }
}

struct OwnedSidecar {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pid: u32,
    #[cfg(windows)]
    windows_job: Option<WindowsJob>,
}

pub struct DesktopRuntime {
    user_data: PathBuf,
    log: Arc<DesktopLog>,
    process: Mutex<Option<OwnedSidecar>>,
    stopped: Arc<(Mutex<bool>, Condvar)>,
    closing: AtomicBool,
    terminated: AtomicBool,
    forced_termination_count: AtomicU64,
    performance: PerformanceRecorder,
}

impl DesktopRuntime {
    pub fn create() -> Result<Self, String> {
        let user_data = desktop_user_data_dir()?;
        fs::create_dir_all(user_data.join("Harness")).map_err(|error| error.to_string())?;
        let log = Arc::new(DesktopLog::open(&user_data).map_err(|error| error.to_string())?);
        let performance = PerformanceRecorder::new(&user_data);
        Ok(Self {
            user_data,
            log,
            process: Mutex::new(None),
            stopped: Arc::new((Mutex::new(false), Condvar::new())),
            closing: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            forced_termination_count: AtomicU64::new(0),
            performance,
        })
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let executable = sidecar_executable()?;
        let mut command = Command::new(&executable);
        command
            .current_dir(dirs::home_dir().unwrap_or_else(|| self.user_data.clone()))
            .env("DSH_HOME", self.user_data.join("Harness"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start {}: {error}", executable.display()))?;
        let pid = child.id();
        #[cfg(windows)]
        let windows_job = match attach_windows_job_and_resume(&child, pid) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let stdin = child.stdin.take().ok_or("sidecar stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr was not piped")?;
        self.log
            .line("desktop", &format!("sidecar spawned pid={pid}"));
        self.performance.record_sidecar_spawn();
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        *self
            .process
            .lock()
            .map_err(|_| "sidecar process lock is poisoned")? = Some(OwnedSidecar {
            child: Arc::clone(&child),
            stdin: Arc::clone(&stdin),
            pid,
            #[cfg(windows)]
            windows_job: Some(windows_job),
        });

        let stdout_log = Arc::clone(&self.log);
        let stdout_app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => handle_stdout(&stdout_app, &stdout_log, &line),
                    Err(error) => {
                        stdout_log.line("sidecar-stdout", &format!("read failed: {error}"));
                        break;
                    }
                }
            }
        });
        let stderr_log = Arc::clone(&self.log);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => stderr_log.line("sidecar-stderr", &line),
                    Err(error) => {
                        stderr_log.line("sidecar-stderr", &format!("read failed: {error}"));
                        break;
                    }
                }
            }
        });
        let monitor_app = app.clone();
        let monitor_child = Arc::clone(&child);
        let monitor_log = Arc::clone(&self.log);
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(100));
                let status = monitor_child
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .try_wait();
                match status {
                    Ok(Some(status)) => {
                        let runtime = monitor_app.state::<DesktopRuntime>();
                        runtime.mark_stopped();
                        monitor_log.line("desktop", &format!("sidecar exited status={status}"));
                        if !runtime.closing.load(Ordering::SeqCst) {
                            let dialog_app = monitor_app.clone();
                            let _ = monitor_app.run_on_main_thread(move || {
                                dialog_app
                                    .dialog()
                                    .message("The Harness backend stopped unexpectedly. See Logs for details.")
                                    .title("DeepSeek Harness stopped")
                                    .show(|_| {});
                            });
                            runtime.begin_close(monitor_app.clone());
                        }
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        monitor_log.line(
                            "desktop",
                            &format!("sidecar exit observation failed: {error}"),
                        );
                        break;
                    }
                }
            }
        });
        Ok(())
    }

    pub fn begin_close(&self, app: AppHandle) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        thread::spawn(move || {
            let runtime = app.state::<DesktopRuntime>();
            runtime.shutdown();
            app.exit(0);
        });
    }

    pub fn has_terminated(&self) -> bool {
        self.terminated.load(Ordering::SeqCst)
    }

    fn send(&self, command: &SidecarCommand<'_>) -> Result<(), String> {
        let frame = serialize_command(command)?;
        let process = self
            .process
            .lock()
            .map_err(|_| "sidecar process lock is poisoned")?;
        let owned = process.as_ref().ok_or("sidecar is not running")?;
        let mut stdin = owned
            .stdin
            .lock()
            .map_err(|_| "sidecar stdin lock is poisoned")?;
        stdin
            .write_all(frame.as_bytes())
            .map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    }

    fn shutdown(&self) {
        self.log
            .line("desktop", "sidecar graceful shutdown requested");
        if let Err(error) = self.send(&SidecarCommand::Shutdown) {
            self.log
                .line("desktop", &format!("shutdown command failed: {error}"));
        }
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        let (stopped_lock, stopped_signal) = &*self.stopped;
        let mut stopped = stopped_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while !*stopped && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = stopped_signal
                .wait_timeout(stopped, remaining)
                .unwrap_or_else(|error| error.into_inner());
            stopped = result.0;
        }
        drop(stopped);

        let process = self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(mut owned) = process {
            let exited = wait_for_exit(&owned.child, deadline);
            if !exited {
                self.forced_termination_count.fetch_add(1, Ordering::SeqCst);
                self.log.line(
                    "desktop",
                    "sidecar graceful shutdown timed out; forcing process tree",
                );
                force_process_tree(&mut owned);
                let _ = wait_for_exit(&owned.child, Instant::now() + Duration::from_secs(2));
            }
        }
        self.terminated.store(true, Ordering::SeqCst);
        let forced_termination_count = self.forced_termination_count.load(Ordering::SeqCst);
        self.performance.record_shutdown(forced_termination_count);
        self.log.line(
            "desktop",
            &format!("sidecar stopped forced={}", forced_termination_count),
        );
    }

    fn mark_stopped(&self) {
        let (lock, signal) = &*self.stopped;
        *lock.lock().unwrap_or_else(|error| error.into_inner()) = true;
        signal.notify_all();
    }

    pub fn log_directory(&self) -> &Path {
        self.log.directory()
    }

    pub fn log_line(&self, source: &str, message: &str) {
        self.log.line(source, message);
    }

    pub fn window_state_path(&self) -> PathBuf {
        self.user_data.join("window-state.json")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.user_data.join("desktop-settings.json")
    }

    pub fn prepare_for_update(&self) -> bool {
        if self.closing.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.shutdown();
        true
    }

    pub fn record_page_loaded(&self) {
        self.performance.record_page_loaded();
        self.log.line(
            "performance",
            &format!("page-loaded elapsedMs={}", self.performance.elapsed_ms()),
        );
    }
}

fn handle_stdout(app: &AppHandle, log: &DesktopLog, line: &str) {
    log.line("sidecar-stdout", line);
    let event = match parse_event(line) {
        Ok(Some(event)) => event,
        Ok(None) => return,
        Err(error) => {
            log.line("desktop", &error);
            return;
        }
    };
    match event {
        SidecarEvent::Ready { url } => {
            let navigation = app.state::<NavigationState>();
            if let Err(error) = navigation.set_ready_url(&url) {
                log.line("desktop", &format!("invalid ready navigation: {error}"));
                return;
            }
            let app = app.clone();
            let window_app = app.clone();
            let parsed = url::Url::parse(&url).expect("protocol already validated ready URL");
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = window_app.get_webview_window("main") {
                    let _ = window.navigate(parsed);
                }
            });
            if let Some(delay) = smoke_exit_delay() {
                let app = app.clone();
                thread::spawn(move || {
                    thread::sleep(delay);
                    app.state::<DesktopRuntime>().begin_close(app.clone());
                });
            }
        }
        SidecarEvent::DirectoryPickerRequest { request_id, title } => {
            let app_for_result = app.clone();
            let mut dialog = app.dialog().file();
            if let Some(title) = title {
                dialog = dialog.set_title(title);
            }
            dialog.pick_folder(move |selection| {
                let path = selection
                    .and_then(|selection| selection.into_path().ok())
                    .map(|path| path.to_string_lossy().into_owned());
                let runtime = app_for_result.state::<DesktopRuntime>();
                if let Err(error) = runtime.send(&SidecarCommand::DirectoryPickerResult {
                    request_id: &request_id,
                    path: path.as_deref(),
                }) {
                    runtime
                        .log
                        .line("desktop", &format!("directory result failed: {error}"));
                }
            });
        }
        SidecarEvent::Fatal { message } => {
            log.line("sidecar-fatal", &message);
            app.dialog()
                .message(message)
                .title("DeepSeek Harness could not start")
                .show(|_| {});
        }
        SidecarEvent::Stopped => app.state::<DesktopRuntime>().mark_stopped(),
        SidecarEvent::Phase { phase, elapsed_ms } => {
            app.state::<DesktopRuntime>()
                .performance
                .record_sidecar_phase(&phase);
            log.line("performance", &format!("{phase} elapsedMs={elapsed_ms}"));
        }
    }
}

fn desktop_user_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DSH_DESKTOP_USER_DATA_DIR").map(PathBuf::from) {
        if !path.is_absolute() {
            return Err("DSH_DESKTOP_USER_DATA_DIR must be absolute".into());
        }
        return Ok(path);
    }
    dirs::data_dir()
        .map(|directory| directory.join("DeepSeek Harness"))
        .ok_or_else(|| "operating system data directory is unavailable".into())
}

fn smoke_exit_delay() -> Option<Duration> {
    std::env::var("DSH_DESKTOP_SMOKE_EXIT_AFTER_READY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
}

fn sidecar_executable() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = if cfg!(windows) {
        "dsh-desktop-sidecar.exe"
    } else {
        "dsh-desktop-sidecar"
    };
    let path = executable
        .parent()
        .ok_or("desktop executable has no parent")?
        .join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("desktop sidecar is missing: {}", path.display()))
    }
}

fn wait_for_exit(child: &Arc<Mutex<Child>>, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .try_wait()
            .ok()
            .flatten()
            .is_some()
        {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    child
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .try_wait()
        .ok()
        .flatten()
        .is_some()
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(
        windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
            | windows_sys::Win32::System::Threading::CREATE_SUSPENDED,
    );
}

#[cfg(unix)]
fn force_process_tree(owned: &mut OwnedSidecar) {
    unsafe {
        libc::kill(-(owned.pid as i32), libc::SIGKILL);
    }
    let _ = owned
        .child
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .kill();
}

#[cfg(windows)]
fn force_process_tree(owned: &mut OwnedSidecar) {
    owned.windows_job.take();
    let _ = owned
        .child
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .kill();
}

#[cfg(windows)]
struct WindowsJob {
    handle: isize,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

#[cfg(windows)]
fn attach_windows_job_and_resume(child: &Child, pid: u32) -> Result<WindowsJob, String> {
    use std::{mem::size_of, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("SetInformationJobObject failed: {error}"));
        }
        if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("AssignProcessToJobObject failed: {error}"));
        }

        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("CreateToolhelp32Snapshot failed: {error}"));
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = Thread32First(snapshot, &mut entry) != 0;
        while found && entry.th32OwnerProcessID != pid {
            found = Thread32Next(snapshot, &mut entry) != 0;
        }
        if !found {
            CloseHandle(snapshot);
            CloseHandle(job);
            return Err("suspended sidecar primary thread was not found".into());
        }
        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
        if thread.is_null() {
            let error = std::io::Error::last_os_error();
            CloseHandle(snapshot);
            CloseHandle(job);
            return Err(format!("OpenThread failed: {error}"));
        }
        let resume_result = ResumeThread(thread);
        CloseHandle(thread);
        CloseHandle(snapshot);
        if resume_result == u32::MAX {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("ResumeThread failed: {error}"));
        }
        Ok(WindowsJob {
            handle: job as isize,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_allows_only_assets_and_the_exact_ready_origin() {
        let navigation = NavigationState::new();
        assert!(navigation.allows(&url::Url::parse("tauri://localhost/startup.html").unwrap()));
        assert!(!navigation.allows(&url::Url::parse("https://example.com/").unwrap()));
        navigation.set_ready_url("http://127.0.0.1:43127/").unwrap();
        assert!(navigation.allows(&url::Url::parse("http://127.0.0.1:43127/session/1").unwrap()));
        assert!(!navigation.allows(&url::Url::parse("http://127.0.0.1:43128/").unwrap()));
        assert!(!navigation.allows(&url::Url::parse("http://localhost:43127/").unwrap()));
        assert!(
            navigation
                .is_ready_origin(&url::Url::parse("http://127.0.0.1:43127/session/1").unwrap())
        );
        assert!(
            !navigation
                .is_ready_origin(&url::Url::parse("tauri://localhost/startup.html").unwrap())
        );
        assert!(navigation.opens_externally(&url::Url::parse("https://example.com/docs").unwrap()));
        assert!(!navigation.opens_externally(&url::Url::parse("mailto:user@example.com").unwrap()));
        assert!(!navigation.opens_externally(&url::Url::parse("http://127.0.0.1:43128/").unwrap()));
        assert!(!navigation.opens_externally(&url::Url::parse("http://localhost:43127/").unwrap()));
    }

    #[test]
    fn reopens_authenticated_ready_url_once_without_the_launch_token() {
        let navigation = NavigationState::new();
        navigation
            .set_ready_url("http://127.0.0.1:43127/?token=abc_123-XYZ")
            .unwrap();

        assert_eq!(
            navigation.take_authentication_reopen(),
            Some(url::Url::parse("http://127.0.0.1:43127/").unwrap())
        );
        assert_eq!(navigation.take_authentication_reopen(), None);

        navigation.set_ready_url("http://127.0.0.1:43127/").unwrap();
        assert_eq!(navigation.take_authentication_reopen(), None);
    }
}
