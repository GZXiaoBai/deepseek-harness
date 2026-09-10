use serde::{Deserialize, Serialize};
use url::Url;

pub const PREFIX: &str = "DSH_DESKTOP/1 ";

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SidecarEvent {
    Phase {
        phase: String,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: f64,
    },
    Ready {
        url: String,
    },
    Fatal {
        message: String,
    },
    Stopped,
    DirectoryPickerRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        title: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SidecarCommand<'a> {
    Shutdown,
    DirectoryPickerResult {
        #[serde(rename = "requestId")]
        request_id: &'a str,
        path: Option<&'a str>,
    },
}

pub fn parse_event(line: &str) -> Result<Option<SidecarEvent>, String> {
    let Some(payload) = line.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    let event: SidecarEvent =
        serde_json::from_str(payload).map_err(|error| format!("invalid sidecar event: {error}"))?;
    validate_event(&event)?;
    Ok(Some(event))
}

pub fn serialize_command(command: &SidecarCommand<'_>) -> Result<String, String> {
    serde_json::to_string(command)
        .map(|payload| format!("{PREFIX}{payload}\n"))
        .map_err(|error| format!("failed to serialize sidecar command: {error}"))
}

fn validate_event(event: &SidecarEvent) -> Result<(), String> {
    match event {
        SidecarEvent::Phase { elapsed_ms, .. } if !elapsed_ms.is_finite() || *elapsed_ms < 0.0 => {
            Err("sidecar phase elapsedMs must be non-negative".into())
        }
        SidecarEvent::Ready { url } if !is_strict_loopback_url(url) => {
            Err("sidecar ready URL must use a strict 127.0.0.1 origin".into())
        }
        SidecarEvent::Fatal { message } if message.trim().is_empty() => {
            Err("sidecar fatal message must not be empty".into())
        }
        SidecarEvent::DirectoryPickerRequest { request_id, .. }
            if request_id.is_empty()
                || request_id.len() > 128
                || !request_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) =>
        {
            Err("sidecar directory-picker request id is invalid".into())
        }
        _ => Ok(()),
    }
}

pub fn is_strict_loopback_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let query_is_valid = match url.query() {
        None => true,
        Some(query) => query.strip_prefix("token=").is_some_and(|token| {
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        }),
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/"
        && query_is_valid
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_plugin_output_and_accepts_strict_ready_event() {
        assert_eq!(parse_event("ordinary plugin output").unwrap(), None);
        assert_eq!(
            parse_event(r#"DSH_DESKTOP/1 {"type":"ready","url":"http://127.0.0.1:43127/"}"#)
                .unwrap(),
            Some(SidecarEvent::Ready {
                url: "http://127.0.0.1:43127/".into()
            }),
        );
        assert_eq!(
            parse_event(
                r#"DSH_DESKTOP/1 {"type":"ready","url":"http://127.0.0.1:43127/?token=abc_123-XYZ"}"#,
            )
            .unwrap(),
            Some(SidecarEvent::Ready {
                url: "http://127.0.0.1:43127/?token=abc_123-XYZ".into()
            }),
        );
    }

    #[test]
    fn rejects_non_loopback_and_ambiguous_ready_urls() {
        for url in [
            "https://127.0.0.1:43127/",
            "http://localhost:43127/",
            "http://127.0.0.1:43127/path",
            "http://127.0.0.1:43127/?query=1",
            "http://127.0.0.1:43127/?token=",
            "http://127.0.0.1:43127/?token=one&token=two",
            "http://127.0.0.1:43127/?token=one&next=two",
            "http://127.0.0.1/",
        ] {
            let line = format!(r#"{PREFIX}{{"type":"ready","url":"{url}"}}"#);
            assert!(parse_event(&line).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn serializes_unicode_directory_results_as_one_frame() {
        assert_eq!(
            serialize_command(&SidecarCommand::DirectoryPickerResult {
                request_id: "picker-1",
                path: Some(r#"C:\用户\有 空格"#),
            })
            .unwrap(),
            "DSH_DESKTOP/1 {\"type\":\"directory-picker-result\",\"requestId\":\"picker-1\",\"path\":\"C:\\\\用户\\\\有 空格\"}\n",
        );
    }
}
