use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("passwords.json"))
}

pub fn load(app: &AppHandle) -> Vec<String> {
    let Some(path) = store_path(app) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save(app: &AppHandle, list: &[String]) -> Result<(), String> {
    let path = store_path(app).ok_or("無法取得設定目錄")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
