//! 我的最愛：記錄書名、作者、書籍詳情頁、以及最後閱讀章節（標題＋網址），供續讀。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Favorite {
    pub name: String,
    pub author: String,
    pub book_url: String,
    #[serde(default)]
    pub chapter_url: String,
    #[serde(default)]
    pub chapter_title: String,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("favorites.json"))
}

pub fn load(app: &AppHandle) -> Vec<Favorite> {
    let Some(path) = store_path(app) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save(app: &AppHandle, list: &[Favorite]) -> Result<(), String> {
    let path = store_path(app).ok_or("無法取得設定目錄")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
