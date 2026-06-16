//! 離線預載快取：把書源章節內文存到 app 資料夾，供搭機等離線情境閱讀。
//!
//! 結構：
//!   app_data/preload/settings.json          全域設定（保留天數）
//!   app_data/preload/<bookkey>/meta.json     書籍資訊＋目錄快取
//!   app_data/preload/<bookkey>/ch_<key>.json 單章內文（CachedChapter）
//! bookkey / 章節 key 用 FNV-1a 雜湊網址，避免檔名非法字元與長度問題。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct CachedChapter {
    pub url: String,
    pub title: String,
    pub text: String,
    pub next_url: Option<String>,
    pub prev_url: Option<String>,
    pub fetched_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TocItem {
    pub title: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct BookMeta {
    pub book_url: String,
    pub name: String,
    pub author: String,
    #[serde(default)]
    pub toc: Vec<TocItem>,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
pub struct Settings {
    pub retain_days: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self { retain_days: 7 }
    }
}

/// 管理面板用的單本快取摘要
#[derive(Serialize)]
pub struct PreloadBook {
    pub book_url: String,
    pub name: String,
    pub author: String,
    pub chapter_count: u32,
    pub total_bytes: u64,
    pub oldest: u64,
    pub newest: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn fnv1a(s: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

fn root(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("preload"))
}

fn book_dir(app: &AppHandle, book_url: &str) -> Option<PathBuf> {
    Some(root(app)?.join(fnv1a(book_url)))
}

fn chap_path(dir: &PathBuf, url: &str) -> PathBuf {
    dir.join(format!("ch_{}.json", fnv1a(url)))
}

// ---------- 設定 ----------
pub fn get_settings(app: &AppHandle) -> Settings {
    let Some(path) = root(app).map(|r| r.join("settings.json")) else {
        return Settings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn set_retain_days(app: &AppHandle, days: u32) -> Result<(), String> {
    let dir = root(app).ok_or("無法取得設定目錄")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&Settings { retain_days: days })
        .map_err(|e| e.to_string())?;
    fs::write(dir.join("settings.json"), json).map_err(|e| e.to_string())
}

// ---------- meta ----------
fn load_meta(dir: &PathBuf) -> BookMeta {
    fs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn save_meta(dir: &PathBuf, meta: &BookMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(dir.join("meta.json"), json).map_err(|e| e.to_string())
}

// ---------- 寫入 ----------
pub fn cache_chapter(
    app: &AppHandle,
    book_url: &str,
    name: &str,
    author: &str,
    mut chapter: CachedChapter,
) -> Result<(), String> {
    let dir = book_dir(app, book_url).ok_or("無法取得快取目錄")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut meta = load_meta(&dir);
    meta.book_url = book_url.to_string();
    if !name.is_empty() {
        meta.name = name.to_string();
    }
    if !author.is_empty() {
        meta.author = author.to_string();
    }
    meta.updated_at = now();
    save_meta(&dir, &meta)?;
    chapter.fetched_at = now();
    let json = serde_json::to_string(&chapter).map_err(|e| e.to_string())?;
    fs::write(chap_path(&dir, &chapter.url), json).map_err(|e| e.to_string())
}

pub fn cache_book_detail(
    app: &AppHandle,
    book_url: &str,
    name: &str,
    author: &str,
    toc: Vec<TocItem>,
) -> Result<(), String> {
    let dir = book_dir(app, book_url).ok_or("無法取得快取目錄")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut meta = load_meta(&dir);
    meta.book_url = book_url.to_string();
    if !name.is_empty() {
        meta.name = name.to_string();
    }
    if !author.is_empty() {
        meta.author = author.to_string();
    }
    meta.toc = toc;
    meta.updated_at = now();
    save_meta(&dir, &meta)
}

// ---------- 讀取 ----------
pub fn is_chapter_cached(app: &AppHandle, book_url: &str, url: &str) -> bool {
    book_dir(app, book_url)
        .map(|d| chap_path(&d, url).is_file())
        .unwrap_or(false)
}

pub fn get_cached_chapter(app: &AppHandle, book_url: &str, url: &str) -> Option<CachedChapter> {
    let dir = book_dir(app, book_url)?;
    let content = fs::read_to_string(chap_path(&dir, url)).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn get_cached_book_detail(app: &AppHandle, book_url: &str) -> Option<BookMeta> {
    let dir = book_dir(app, book_url)?;
    if !dir.join("meta.json").is_file() {
        return None;
    }
    let meta = load_meta(&dir);
    if meta.toc.is_empty() {
        None
    } else {
        Some(meta)
    }
}

// ---------- 管理 ----------
fn scan_book(dir: &PathBuf) -> Option<PreloadBook> {
    let meta = load_meta(dir);
    let mut count = 0u32;
    let mut total = 0u64;
    let mut oldest = u64::MAX;
    let mut newest = 0u64;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        let is_chapter = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("ch_") && n.ends_with(".json"))
            .unwrap_or(false);
        if !is_chapter {
            continue;
        }
        count += 1;
        if let Ok(md) = entry.metadata() {
            total += md.len();
            if let Ok(modified) = md.modified() {
                if let Ok(secs) = modified.duration_since(UNIX_EPOCH) {
                    let t = secs.as_secs();
                    oldest = oldest.min(t);
                    newest = newest.max(t);
                }
            }
        }
    }
    if count == 0 {
        return None;
    }
    Some(PreloadBook {
        book_url: meta.book_url,
        name: meta.name,
        author: meta.author,
        chapter_count: count,
        total_bytes: total,
        oldest: if oldest == u64::MAX { 0 } else { oldest },
        newest,
    })
}

pub fn list_preloads(app: &AppHandle) -> Vec<PreloadBook> {
    let Some(r) = root(app) else {
        return Vec::new();
    };
    let mut books = Vec::new();
    if let Ok(entries) = fs::read_dir(&r) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(b) = scan_book(&p) {
                    books.push(b);
                }
            }
        }
    }
    books.sort_by(|a, b| b.newest.cmp(&a.newest));
    books
}

pub fn delete_preload(app: &AppHandle, book_url: &str) -> Result<(), String> {
    let dir = book_dir(app, book_url).ok_or("無法取得快取目錄")?;
    if dir.is_dir() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn delete_all(app: &AppHandle) -> Result<(), String> {
    let Some(r) = root(app) else {
        return Ok(());
    };
    if let Ok(entries) = fs::read_dir(&r) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            }
        }
    }
    Ok(())
}

/// 清除過期章節（依保留天數）。retain_days 為 0 表示永久保留。回傳刪除章節數。
pub fn prune_expired(app: &AppHandle) -> u32 {
    let retain = get_settings(app).retain_days;
    if retain == 0 {
        return 0;
    }
    let Some(r) = root(app) else {
        return 0;
    };
    let cutoff = now().saturating_sub(retain as u64 * 86400);
    let mut removed = 0u32;
    let Ok(books) = fs::read_dir(&r) else {
        return 0;
    };
    for book in books.flatten() {
        let bdir = book.path();
        if !bdir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&bdir) else {
            continue;
        };
        let mut remaining = 0u32;
        for f in files.flatten() {
            let p = f.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !(name.starts_with("ch_") && name.ends_with(".json")) {
                continue;
            }
            let expired = f
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() < cutoff)
                .unwrap_or(false);
            if expired {
                if fs::remove_file(&p).is_ok() {
                    removed += 1;
                }
            } else {
                remaining += 1;
            }
        }
        // 整本都過期 → 連 meta 一起清掉
        if remaining == 0 {
            let _ = fs::remove_dir_all(&bdir);
        }
    }
    removed
}
