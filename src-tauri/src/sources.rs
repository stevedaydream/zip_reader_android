use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Source {
    pub name: String,
    pub url: String,
}

fn defaults() -> Vec<Source> {
    vec![
        Source {
            name: "CCC 追漫台".into(),
            url: "https://www.creative-comic.tw".into(),
        },
        Source {
            name: "WEBTOON".into(),
            url: "https://www.webtoons.com/zh-hant/".into(),
        },
        Source {
            name: "維基文庫".into(),
            url: "https://zh.wikisource.org".into(),
        },
        Source {
            name: "好讀".into(),
            url: "https://www.haodoo.net".into(),
        },
        Source {
            name: "twkan 台灣看書".into(),
            url: "https://twkan.com/".into(),
        },
        Source {
            name: "Project Gutenberg".into(),
            url: "https://www.gutenberg.org".into(),
        },
    ]
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("sources.json"))
}

pub fn load(app: &AppHandle) -> Vec<Source> {
    let Some(path) = store_path(app) else {
        return defaults();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return defaults();
    };
    serde_json::from_str(&content).unwrap_or_else(|_| defaults())
}

pub fn save(app: &AppHandle, list: &[Source]) -> Result<(), String> {
    let path = store_path(app).ok_or("無法取得設定目錄")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
