#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod close_behavior;
mod desktop_log;
mod performance;
mod protocol;
mod supervisor;
mod updater;
mod window_state;

use close_behavior::{CloseRequestAction, close_request_action, smoke_exit_after_hide_delay};
use supervisor::{DesktopRuntime, NavigationState};
use tauri::{
    Manager, RunEvent, WindowEvent,
    webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder},
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "windows")]
fn setup_windows_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show = MenuItem::with_id(
        app,
        "tray_show",
        "Show DeepSeek Harness",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "tray_quit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DeepSeek Harness")
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    performance::mark_process_started();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(NavigationState::new())
        .manage(updater::StartupUpdateGate::default())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("desktop-navigation-policy")
                .on_navigation(|webview, url| {
                    if webview.app_handle().state::<NavigationState>().allows(url) {
                        return true;
                    }
                    if webview
                        .app_handle()
                        .state::<NavigationState>()
                        .opens_externally(url)
                    {
                        let _ = open::that_detached(url.as_str());
                    }
                    false
                })
                .build(),
        )
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "tray_show" {
                show_main_window(app);
            } else if event.id().as_ref() == "tray_quit" {
                app.state::<DesktopRuntime>().begin_close(app.clone());
            } else if event.id().as_ref() == "open_logs" {
                let _ = open::that_detached(app.state::<DesktopRuntime>().log_directory());
            } else if event.id().as_ref() == "check_updates" {
                updater::check_for_updates(app.clone(), true);
            } else if event.id().as_ref() == "automatic_updates"
                && let Some(menu) = app.menu()
                && let Some(item) = menu.get("automatic_updates")
                && let Some(item) = item.as_check_menuitem()
                && let Ok(enabled) = item.is_checked()
            {
                let runtime = app.state::<DesktopRuntime>();
                if let Err(error) =
                    updater::set_automatic_updates_enabled(&runtime.settings_path(), enabled)
                {
                    runtime.log_line("updater", &format!("settings save failed: {error}"));
                }
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished
                && webview
                    .app_handle()
                    .state::<NavigationState>()
                    .is_ready_origin(payload.url())
            {
                let app = webview.app_handle();
                let runtime = app.state::<DesktopRuntime>();
                if let Some(url) = app
                    .state::<NavigationState>()
                    .take_authentication_reopen()
                {
                    if let Err(error) = webview.navigate(url) {
                        runtime.log_line(
                            "desktop",
                            &format!("authenticated navigation reopen failed: {error}"),
                        );
                    }
                    return;
                }
                runtime.record_page_loaded();
                let automatic_updates =
                    updater::automatic_updates_enabled(&runtime.settings_path());
                if app
                    .state::<updater::StartupUpdateGate>()
                    .begin(automatic_updates)
                {
                    updater::check_for_updates(app.clone(), false);
                }
            }
        })
        .setup(|app| {
            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("main window configuration is missing")?;
            let external_app = app.handle().clone();
            WebviewWindowBuilder::from_config(app.handle(), main_window_config)?
                .on_new_window(move |url, _| {
                    if external_app
                        .state::<NavigationState>()
                        .opens_externally(&url)
                    {
                        let _ = open::that_detached(url.as_str());
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            let runtime = DesktopRuntime::create()
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let automatic_updates = updater::automatic_updates_enabled(&runtime.settings_path());
            app.manage(runtime);
            let menu = tauri::menu::Menu::default(app.handle())?;
            let open_logs = tauri::menu::MenuItem::with_id(
                app.handle(),
                "open_logs",
                "Open Logs Directory",
                true,
                None::<&str>,
            )?;
            let check_updates = tauri::menu::MenuItem::with_id(
                app.handle(),
                "check_updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            let automatic_updates_item = tauri::menu::CheckMenuItem::with_id(
                app.handle(),
                "automatic_updates",
                "Automatically Check for Updates",
                true,
                automatic_updates,
                None::<&str>,
            )?;
            let desktop_menu = tauri::menu::Submenu::with_items(
                app.handle(),
                "Harness",
                true,
                &[&check_updates, &automatic_updates_item, &open_logs],
            )?;
            menu.append(&desktop_menu)?;
            app.set_menu(menu)?;
            #[cfg(target_os = "windows")]
            setup_windows_tray(app)?;
            if let Some(window) = app.get_webview_window("main") {
                window_state::restore(&window, &app.state::<DesktopRuntime>().window_state_path());
            }
            app.state::<DesktopRuntime>()
                .start(app.handle().clone())
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("DeepSeek Harness Tauri runtime failed to build");

    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if !app.state::<DesktopRuntime>().has_terminated() {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    window_state::save(&window, &app.state::<DesktopRuntime>().window_state_path());
                }
                match close_request_action(std::env::consts::OS) {
                    CloseRequestAction::HideToTray => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                        if let Some(delay) = smoke_exit_after_hide_delay(
                            std::env::var("DSH_DESKTOP_SMOKE_EXIT_AFTER_HIDE_MS")
                                .ok()
                                .as_deref(),
                        ) {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(delay);
                                app.state::<DesktopRuntime>().begin_close(app.clone());
                            });
                        }
                    }
                    CloseRequestAction::BeginShutdown => {
                        app.state::<DesktopRuntime>().begin_close(app.clone());
                    }
                }
            }
        }
        RunEvent::ExitRequested { api, .. } => {
            if !app.state::<DesktopRuntime>().has_terminated() {
                api.prevent_exit();
                app.state::<DesktopRuntime>().begin_close(app.clone());
            }
        }
        _ => {}
    });
}
