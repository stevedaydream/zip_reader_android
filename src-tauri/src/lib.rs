mod archive;
mod browser;
mod ebook;
mod favorites;
mod hjwzw;
mod net;
mod passwords;
mod preload;
mod sources;
mod webnovel;
mod webshelf;

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

/// 抓取網路小說章節並解析出純內文與上下章連結
#[tauri::command]
async fn fetch_web_chapter(url: String) -> Result<webnovel::WebChapter, CmdError> {
    webnovel::fetch_chapter(&url).await.map_err(CmdError::other)
}

#[tauri::command]
fn get_webnovels(app: AppHandle) -> Vec<webshelf::WebNovel> {
    webshelf::load(&app)
}

/// 新增或更新書架項目（以書名為鍵，更新最後閱讀章節網址）
#[tauri::command]
fn upsert_webnovel(app: AppHandle, name: String, url: String) -> Result<(), CmdError> {
    if name.trim().is_empty() || url.trim().is_empty() {
        return Ok(());
    }
    let mut list = webshelf::load(&app);
    if let Some(item) = list.iter_mut().find(|n| n.name == name) {
        item.url = url;
    } else {
        list.push(webshelf::WebNovel { name, url });
    }
    webshelf::save(&app, &list).map_err(CmdError::other)
}

#[tauri::command]
fn remove_webnovel(app: AppHandle, name: String) -> Result<(), CmdError> {
    let mut list = webshelf::load(&app);
    list.retain(|n| n.name != name);
    webshelf::save(&app, &list).map_err(CmdError::other)
}

// ---------- 黃金屋書源 ----------
#[tauri::command]
fn hjwzw_categories() -> Vec<hjwzw::Category> {
    hjwzw::categories()
}

#[tauri::command]
async fn hjwzw_book_list(url: String) -> Result<Vec<hjwzw::BookEntry>, CmdError> {
    hjwzw::book_list(&url).await.map_err(CmdError::other)
}

#[tauri::command]
async fn hjwzw_search(keyword: String) -> Result<Vec<hjwzw::BookEntry>, CmdError> {
    hjwzw::search(&keyword).await.map_err(CmdError::other)
}

#[tauri::command]
async fn hjwzw_book_detail(url: String) -> Result<hjwzw::BookDetail, CmdError> {
    hjwzw::book_detail(&url).await.map_err(CmdError::other)
}

// ---------- 我的最愛 ----------
#[tauri::command]
fn get_favorites(app: AppHandle) -> Vec<favorites::Favorite> {
    favorites::load(&app)
}

/// 加入或更新最愛（以 book_url 為鍵）。chapter 欄位用於記錄續讀位置。
#[tauri::command]
fn upsert_favorite(
    app: AppHandle,
    name: String,
    author: String,
    book_url: String,
    chapter_url: String,
    chapter_title: String,
) -> Result<(), CmdError> {
    if book_url.trim().is_empty() {
        return Ok(());
    }
    let mut list = favorites::load(&app);
    if let Some(f) = list.iter_mut().find(|f| f.book_url == book_url) {
        f.name = name;
        f.author = author;
        // 只在有提供章節時更新續讀位置
        if !chapter_url.is_empty() {
            f.chapter_url = chapter_url;
            f.chapter_title = chapter_title;
        }
    } else {
        list.push(favorites::Favorite {
            name,
            author,
            book_url,
            chapter_url,
            chapter_title,
        });
    }
    favorites::save(&app, &list).map_err(CmdError::other)
}

/// 僅更新某書的續讀章節（閱讀時呼叫；書不在最愛則略過）
#[tauri::command]
fn update_favorite_progress(
    app: AppHandle,
    book_url: String,
    chapter_url: String,
    chapter_title: String,
) -> Result<(), CmdError> {
    let mut list = favorites::load(&app);
    if let Some(f) = list.iter_mut().find(|f| f.book_url == book_url) {
        f.chapter_url = chapter_url;
        f.chapter_title = chapter_title;
        favorites::save(&app, &list).map_err(CmdError::other)?;
    }
    Ok(())
}

#[tauri::command]
fn remove_favorite(app: AppHandle, book_url: String) -> Result<(), CmdError> {
    let mut list = favorites::load(&app);
    list.retain(|f| f.book_url != book_url);
    favorites::save(&app, &list).map_err(CmdError::other)
}

#[tauri::command]
fn is_favorite(app: AppHandle, book_url: String) -> bool {
    favorites::load(&app).iter().any(|f| f.book_url == book_url)
}

// ---------- 離線預載 ----------
#[tauri::command]
fn preload_get_settings(app: AppHandle) -> preload::Settings {
    preload::get_settings(&app)
}

#[tauri::command]
fn preload_set_retain_days(app: AppHandle, days: u32) -> Result<(), CmdError> {
    preload::set_retain_days(&app, days).map_err(CmdError::other)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn preload_cache_chapter(
    app: AppHandle,
    book_url: String,
    name: String,
    author: String,
    url: String,
    title: String,
    text: String,
    next_url: Option<String>,
    prev_url: Option<String>,
) -> Result<(), CmdError> {
    let chapter = preload::CachedChapter {
        url,
        title,
        text,
        next_url,
        prev_url,
        fetched_at: 0, // cache_chapter 內會蓋上現在時間
    };
    preload::cache_chapter(&app, &book_url, &name, &author, chapter).map_err(CmdError::other)
}

#[tauri::command]
fn preload_cache_book_detail(
    app: AppHandle,
    book_url: String,
    name: String,
    author: String,
    toc: Vec<preload::TocItem>,
) -> Result<(), CmdError> {
    preload::cache_book_detail(&app, &book_url, &name, &author, toc).map_err(CmdError::other)
}

#[tauri::command]
fn preload_is_cached(app: AppHandle, book_url: String, url: String) -> bool {
    preload::is_chapter_cached(&app, &book_url, &url)
}

#[tauri::command]
fn preload_get_chapter(
    app: AppHandle,
    book_url: String,
    url: String,
) -> Option<preload::CachedChapter> {
    preload::get_cached_chapter(&app, &book_url, &url)
}

#[tauri::command]
fn preload_get_book_detail(app: AppHandle, book_url: String) -> Option<preload::BookMeta> {
    preload::get_cached_book_detail(&app, &book_url)
}

#[tauri::command]
fn preload_list(app: AppHandle) -> Vec<preload::PreloadBook> {
    preload::list_preloads(&app)
}

#[tauri::command]
fn preload_delete(app: AppHandle, book_url: String) -> Result<(), CmdError> {
    preload::delete_preload(&app, &book_url).map_err(CmdError::other)
}

#[tauri::command]
fn preload_delete_all(app: AppHandle) -> Result<(), CmdError> {
    preload::delete_all(&app).map_err(CmdError::other)
}

#[tauri::command]
fn preload_prune(app: AppHandle) -> u32 {
    preload::prune_expired(&app)
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
            open_browser,
            fetch_web_chapter,
            get_webnovels,
            upsert_webnovel,
            remove_webnovel,
            hjwzw_categories,
            hjwzw_book_list,
            hjwzw_search,
            hjwzw_book_detail,
            get_favorites,
            upsert_favorite,
            update_favorite_progress,
            remove_favorite,
            is_favorite,
            preload_get_settings,
            preload_set_retain_days,
            preload_cache_chapter,
            preload_cache_book_detail,
            preload_is_cached,
            preload_get_chapter,
            preload_get_book_detail,
            preload_list,
            preload_delete,
            preload_delete_all,
            preload_prune
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
