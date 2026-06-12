mod archive;
mod browser;
mod ebook;
mod passwords;
mod sources;

use base64::Engine;
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Serialize)]
struct CmdError {
    code: String,
    message: String,
}

impl CmdError {
    fn need_password() -> Self {
        CmdError {
            code: "need_password".into(),
            message: "此壓縮檔需要密碼".into(),
        }
    }

    fn other(message: impl Into<String>) -> Self {
        CmdError {
            code: "error".into(),
            message: message.into(),
        }
    }
}

impl From<archive::ArchiveError> for CmdError {
    fn from(e: archive::ArchiveError) -> Self {
        match e {
            archive::ArchiveError::NeedPassword => CmdError::need_password(),
            archive::ArchiveError::Other(msg) => CmdError::other(msg),
        }
    }
}

#[derive(Serialize)]
struct ArchiveItem {
    name: String,
    path: String,
    size: u64,
    ext: String,
}

fn list_files_with_exts(dir: &str, exts: &[&str]) -> Result<Vec<ArchiveItem>, CmdError> {
    let entries = std::fs::read_dir(dir).map_err(|e| CmdError::other(e.to_string()))?;
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !exts.contains(&ext.as_str()) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        items.push(ArchiveItem {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            size,
            ext,
        });
    }
    items.sort_by(|a, b| natord::compare_ignore_case(&a.name, &b.name));
    Ok(items)
}

/// 列出資料夾內所有支援的壓縮檔
#[tauri::command]
async fn list_archives(dir: String) -> Result<Vec<ArchiveItem>, CmdError> {
    list_files_with_exts(&dir, &archive::ARCHIVE_EXTS)
}

/// 列出資料夾內的小說／電子書檔
#[tauri::command]
async fn list_novels(dir: String) -> Result<Vec<ArchiveItem>, CmdError> {
    list_files_with_exts(&dir, &ebook::NOVEL_EXTS)
}

/// 讀取小說內容：TXT（自動偵測編碼）／EPUB／MOBI／AZW／AZW3
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, CmdError> {
    ebook::read_novel(&path).map_err(CmdError::other)
}

#[derive(Serialize)]
struct OpenResult {
    entries: Vec<String>,
    /// 成功開啟所使用的密碼（無密碼則為 null），前端讀頁時需帶回
    password: Option<String>,
}

/// 開啟壓縮檔：未提供密碼時會自動嘗試已儲存的密碼清單
#[tauri::command]
async fn open_archive(
    app: AppHandle,
    path: String,
    password: Option<String>,
) -> Result<OpenResult, CmdError> {
    if !Path::new(&path).is_file() {
        return Err(CmdError::other("檔案不存在"));
    }
    let candidates: Vec<Option<String>> = match password {
        Some(pw) => vec![Some(pw)],
        None => {
            let mut v = vec![None];
            v.extend(passwords::load(&app).into_iter().map(Some));
            v
        }
    };
    let mut need_password = false;
    let mut last_err = String::new();
    for candidate in candidates {
        match archive::list_and_validate(&path, candidate.as_deref()) {
            Ok(entries) => {
                return Ok(OpenResult {
                    entries,
                    password: candidate,
                })
            }
            Err(archive::ArchiveError::NeedPassword) => need_password = true,
            Err(archive::ArchiveError::Other(msg)) => last_err = msg,
        }
    }
    if need_password {
        Err(CmdError::need_password())
    } else {
        Err(CmdError::other(last_err))
    }
}

#[derive(Serialize)]
struct PageData {
    data: String,
    mime: String,
}

/// 讀取單頁圖片，回傳 base64
#[tauri::command]
async fn get_page(
    path: String,
    entry: String,
    password: Option<String>,
) -> Result<PageData, CmdError> {
    let bytes = archive::read_entry(&path, &entry, password.as_deref())?;
    Ok(PageData {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: archive::mime_for(&entry).to_string(),
    })
}

#[tauri::command]
fn get_passwords(app: AppHandle) -> Vec<String> {
    passwords::load(&app)
}

#[tauri::command]
fn add_password(app: AppHandle, password: String) -> Result<(), CmdError> {
    if password.is_empty() {
        return Ok(());
    }
    let mut list = passwords::load(&app);
    if !list.contains(&password) {
        list.push(password);
        passwords::save(&app, &list).map_err(CmdError::other)?;
    }
    Ok(())
}

#[tauri::command]
fn remove_password(app: AppHandle, password: String) -> Result<(), CmdError> {
    let mut list = passwords::load(&app);
    list.retain(|p| p != &password);
    passwords::save(&app, &list).map_err(CmdError::other)
}

#[tauri::command]
fn get_sources(app: AppHandle) -> Vec<sources::Source> {
    sources::load(&app)
}

#[tauri::command]
fn add_source(app: AppHandle, name: String, url: String) -> Result<(), CmdError> {
    if name.trim().is_empty() || url.trim().is_empty() {
        return Err(CmdError::other("名稱與網址不可空白"));
    }
    let mut list = sources::load(&app);
    if !list.iter().any(|s| s.url == url) {
        list.push(sources::Source { name, url });
        sources::save(&app, &list).map_err(CmdError::other)?;
    }
    Ok(())
}

#[tauri::command]
fn remove_source(app: AppHandle, url: String) -> Result<(), CmdError> {
    let mut list = sources::load(&app);
    list.retain(|s| s.url != url);
    sources::save(&app, &list).map_err(CmdError::other)
}

/// 以獨立視窗開啟線上資源（套用廣告／彈窗阻擋）
#[tauri::command]
async fn open_browser(app: AppHandle, url: String, title: String) -> Result<(), CmdError> {
    browser::open(&app, &url, &title).map_err(CmdError::other)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_androidbridge::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![
            list_archives,
            open_archive,
            get_page,
            get_passwords,
            add_password,
            remove_password,
            list_novels,
            read_text_file,
            get_sources,
            add_source,
            remove_source,
            open_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
