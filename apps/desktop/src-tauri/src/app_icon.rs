//! The app icon the person picked on this computer (ADR 0164), from the site's Settings › Account › This device
//! (`this_mac` `appIcon`): the Dock's icon on macOS and the windows' (the taskbar's) on Windows and Linux, while
//! the app runs. The bundle keeps the default one, so Finder, Launchpad and the Dock of a closed app show that:
//! changing the bundle would break its signature. Kept in `app-icon.json` (the app's config folder) and shown again
//! at launch and whenever a window is made. The ids are the site's (packages/client `app-icons.ts`); the images come
//! from packages/ui/scripts/app-icons.mjs.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// One icon: its id, the Dock's image (macOS's shape and shadow) and the windows' (a rounded square).
pub struct Icon {
    pub id: &'static str,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    dock: &'static [u8],
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    window: &'static [u8],
}

macro_rules! icon {
    ($id:literal) => {
        Icon {
            id: $id,
            dock: include_bytes!(concat!("../icons/app/", $id, ".png")),
            window: include_bytes!(concat!("../icons/app/", $id, "-tile.png")),
        }
    };
}

/// In the site's order; the first is the bundle's own.
pub const ICONS: &[Icon] = &[icon!("night"), icon!("moon"), icon!("sky"), icon!("peekNight"), icon!("peekSky")];

pub fn find(id: &str) -> Option<&'static Icon> {
    ICONS.iter().find(|icon| icon.id == id)
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("app-icon.json"))
}

/// The id kept in `app-icon.json`'s text, when it is one of ours.
fn parse(bytes: &[u8]) -> Option<&'static Icon> {
    let saved: Value = serde_json::from_slice(bytes).ok()?;
    find(saved.get("icon")?.as_str()?)
}

/// The icon picked on this computer (the bundle's own until someone picks).
pub fn current(app: &AppHandle) -> &'static Icon {
    file(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| parse(&bytes))
        .unwrap_or(&ICONS[0])
}

/// Keeps the pick and shows it.
pub fn set(app: &AppHandle, id: &str) -> Result<(), String> {
    find(id).ok_or("unknown icon")?;
    let path = file(app).ok_or("no config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json!({ "icon": id }).to_string()).map_err(|e| e.to_string())?;
    show(app);
    Ok(())
}

/// Shows the kept icon: at launch, after a pick and when a window is made (on Windows and Linux a new window
/// starts with the bundle's).
pub fn show(app: &AppHandle) {
    apply(app, current(app));
}

#[cfg(target_os = "macos")]
fn apply(app: &AppHandle, icon: &'static Icon) {
    dock_image(app, (icon.id != ICONS[0].id).then_some(icon.dock));
}

#[cfg(not(target_os = "macos"))]
fn apply(app: &AppHandle, icon: &'static Icon) {
    if let Ok(image) = tauri::image::Image::from_bytes(icon.window) {
        for window in app.webview_windows().values() {
            let _ = window.set_icon(image.clone());
        }
    }
}

/// The Dock's icon while the app runs; `None` gives the bundle's back.
#[cfg(target_os = "macos")]
fn dock_image(app: &AppHandle, png: Option<&'static [u8]>) {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let _ = app.run_on_main_thread(move || {
        // SAFETY: AppKit on the main thread; the data and the image are owned here (`Retained`) and the
        // application keeps its own reference to the image it is given.
        unsafe {
            let image: Option<Retained<AnyObject>> = match png {
                Some(bytes) => {
                    let data: Option<Retained<AnyObject>> = msg_send![
                        class!(NSData),
                        dataWithBytes: bytes.as_ptr().cast::<std::ffi::c_void>(),
                        length: bytes.len()
                    ];
                    let Some(data) = data else { return };
                    let blank: Allocated<AnyObject> = msg_send![class!(NSImage), alloc];
                    let made: Option<Retained<AnyObject>> = msg_send![blank, initWithData: &*data];
                    if made.is_none() {
                        return;
                    }
                    made
                }
                None => None,
            };
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if ns_app.is_null() {
                return;
            }
            let arg: *const AnyObject = image.as_deref().map_or(std::ptr::null(), |i| i as *const AnyObject);
            let _: () = msg_send![ns_app, setApplicationIconImage: arg];
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_our_ids() {
        assert_eq!(parse(br#"{"icon":"moon"}"#).map(|i| i.id), Some("moon"));
        assert!(parse(br#"{"icon":"../etc/passwd"}"#).is_none());
        assert!(parse(br#"{"icon":7}"#).is_none());
        assert!(parse(b"not json").is_none());
    }

    #[test]
    fn every_icon_has_both_images() {
        for icon in ICONS {
            assert!(icon.dock.starts_with(b"\x89PNG"), "{}", icon.id);
            assert!(icon.window.starts_with(b"\x89PNG"), "{}", icon.id);
        }
    }
}
