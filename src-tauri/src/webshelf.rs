use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 網路小說書架項目：記住書名與最後閱讀的章節網址
#[derive(Serialize, Deserialize, Clone)]
pub struct WebNovel {
    pub name: String,
    pub url: String,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("webnovels.json"))
}

pub fn load(app: &AppHandle) -> Vec<WebNovel> {
    let Some(path) = store_path(app) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save(app: &AppHandle, list: &[WebNovel]) -> Result<(), String> {
    let path = store_path(app).ok_or("無法取得設定目錄")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
