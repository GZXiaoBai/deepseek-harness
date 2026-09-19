#[derive(Debug, Eq, PartialEq)]
pub enum CloseRequestAction {
    HideToTray,
    BeginShutdown,
}

pub fn close_request_action(operating_system: &str) -> CloseRequestAction {
    if operating_system == "windows" {
        CloseRequestAction::HideToTray
    } else {
        CloseRequestAction::BeginShutdown
    }
}

pub fn smoke_exit_after_hide_delay(value: Option<&str>) -> Option<Duration> {
    let milliseconds = value?.parse::<u64>().ok()?;
    (milliseconds > 0).then(|| Duration::from_millis(milliseconds))
}

#[cfg(test)]
mod tests {
    use super::{CloseRequestAction, close_request_action, smoke_exit_after_hide_delay};
    use std::time::Duration;

    #[test]
    fn windows_close_hides_to_tray() {
        assert_eq!(
            close_request_action("windows"),
            CloseRequestAction::HideToTray
        );
    }

    #[test]
    fn macos_close_starts_shutdown() {
        assert_eq!(
            close_request_action("macos"),
            CloseRequestAction::BeginShutdown
        );
    }

    #[test]
    fn smoke_exit_delay_accepts_only_positive_milliseconds() {
        assert_eq!(
            smoke_exit_after_hide_delay(Some("750")),
            Some(Duration::from_millis(750))
        );
        assert_eq!(smoke_exit_after_hide_delay(Some("0")), None);
        assert_eq!(smoke_exit_after_hide_delay(Some("invalid")), None);
        assert_eq!(smoke_exit_after_hide_delay(None), None);
    }
}
use std::time::Duration;
