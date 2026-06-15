//! 黃金屋中文網（tw.hjwzw.com）書源解析。
//! 分類瀏覽 / 全站搜尋 / 書籍詳情＋目錄。章節內文沿用通用 webnovel::fetch_chapter。

use crate::net::client;
use scraper::{Html, Selector};
use serde::Serialize;

const BASE: &str = "https://tw.hjwzw.com";

/// 站上的分類頻道（/Channel/{name}）
const CHANNELS: &[&str] = &[
    "玄幻", "奇幻", "武俠", "仙俠", "都市", "言情", "歷史", "軍事", "游戲", "競技", "科幻",
    "靈異", "全本",
];

#[derive(Serialize)]
pub struct Category {
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct BookEntry {
    pub name: String,
    pub author: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct Chapter {
    pub title: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct BookDetail {
    pub name: String,
    pub author: String,
    pub category: String,
    pub status: String,
    pub intro: String,
    pub url: String,
    pub chapters: Vec<Chapter>,
}

async fn fetch(url: &str) -> Result<String, String> {
    let resp = client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("連線失敗：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("讀取失敗：{e}"))?;
    // 站點為 UTF-8；保險起見以 chardetng 收尾
    let mut det = chardetng::EncodingDetector::new();
    det.feed(&bytes, true);
    Ok(det.guess(None, true).decode(&bytes).0.into_owned())
}

/// 分類清單（靜態頻道，URL 編碼中文）
pub fn categories() -> Vec<Category> {
    CHANNELS
        .iter()
        .map(|name| Category {
            name: name.to_string(),
            url: format!("{BASE}/Channel/{}", urlencode(name)),
        })
        .collect()
}

/// 解析分類頁 / 搜尋結果頁的書籍列表
pub async fn book_list(url: &str) -> Result<Vec<BookEntry>, String> {
    let html = fetch(url).await?;
    Ok(parse_book_list(&html))
}

/// 全站搜尋（導向 /List/{關鍵字}）
pub async fn search(keyword: &str) -> Result<Vec<BookEntry>, String> {
    let kw = keyword.trim();
    if kw.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{BASE}/List/{}", urlencode(kw));
    let html = fetch(&url).await?;
    Ok(parse_book_list(&html))
}

/// 書籍詳情＋完整目錄
pub async fn book_detail(book_url: &str) -> Result<BookDetail, String> {
    let detail_html = fetch(book_url).await?;
    // scraper::Html 非 Send，必須在 .await 前解析完並丟棄，避免跨 await 持有
    let (name, author, category, status, intro) = parse_meta(&detail_html);

    // 由 /Book/{id} 取出 id，改抓完整目錄頁 /Book/Chapter/{id}
    let book_id = book_url
        .rsplit('/')
        .next()
        .and_then(|s| s.split(',').next())
        .unwrap_or("")
        .to_string();
    let toc_url = format!("{BASE}/Book/Chapter/{book_id}");
    let toc_html = fetch(&toc_url).await?;
    let chapters = parse_chapters(&toc_html);

    Ok(BookDetail {
        name,
        author,
        category,
        status,
        intro,
        url: book_url.to_string(),
        chapters,
    })
}

/// 解析書籍詳情頁的 og:* meta（同步，不跨 await）
fn parse_meta(html: &str) -> (String, String, String, String, String) {
    let doc = Html::parse_document(html);
    let meta = |prop: &str| -> String {
        let sel = Selector::parse(&format!(r#"meta[property="{prop}"]"#)).unwrap();
        doc.select(&sel)
            .next()
            .and_then(|e| e.value().attr("content"))
            .unwrap_or_default()
            .to_string()
    };
    (
        meta("og:title"),
        meta("og:novel:author"),
        meta("og:novel:category"),
        meta("og:novel:status"),
        meta("og:description"),
    )
}

fn parse_book_list(html: &str) -> Vec<BookEntry> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"a[href^="/Book/"]"#).unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for a in doc.select(&sel) {
        let href = a.value().attr("href").unwrap_or("");
        // 僅書籍詳情連結 /Book/{數字}，排除 /Book/Read、/Book/Chapter
        let rest = href.trim_start_matches("/Book/");
        if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let text = a.text().collect::<String>().trim().to_string();
        if text.is_empty() {
            continue; // 略過純圖示連結，書名取自有文字者
        }
        if !seen.insert(rest.to_string()) {
            continue;
        }
        let title_attr = a.value().attr("title").unwrap_or("");
        let author = parse_author(title_attr, &text);
        out.push(BookEntry {
            name: text,
            author,
            url: format!("{BASE}{href}"),
        });
    }
    out
}

/// title 形如「完美世界 作者:辰東 ...」或「萬道龍皇 牧童聽竹」
fn parse_author(title_attr: &str, name: &str) -> String {
    if let Some(pos) = title_attr.find("作者:") {
        let after = &title_attr[pos + "作者:".len()..];
        // 去掉尾巴「 TXT下載 手打」等
        return after
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
    }
    // 「書名 作者」格式：去掉書名取其餘
    let rest = title_attr.trim().strip_prefix(name).unwrap_or("").trim();
    rest.split_whitespace().next().unwrap_or("").to_string()
}

fn parse_chapters(html: &str) -> Vec<Chapter> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"a[href^="/Book/Read/"]"#).unwrap();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for a in doc.select(&sel) {
        let href = a.value().attr("href").unwrap_or("");
        let title = a.text().collect::<String>().trim().to_string();
        if title.is_empty() || !seen.insert(href.to_string()) {
            continue;
        }
        out.push(Chapter {
            title,
            url: format!("{BASE}{href}"),
        });
    }
    out
}

/// 最小 URL 編碼（中文 → %XX），用於路徑片段
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_book_list_and_author() {
        let html = r#"<html><body>
        <a href="/Book/33827" title="完美世界 作者:辰東 TXT下載 手打"></a>
        <a href="/Book/33827" title="完美世界 作者:辰東 ">完美世界</a>
        <a href="/Book/37831" title="萬道龍皇 牧童聽竹">萬道龍皇</a>
        <a href="/Book/Read/1,2">某章節</a>
        <a href="/Book/Chapter/1">目錄</a>
        </body></html>"#;
        let list = parse_book_list(html);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "完美世界");
        assert_eq!(list[0].author, "辰東");
        assert_eq!(list[0].url, "https://tw.hjwzw.com/Book/33827");
        assert_eq!(list[1].name, "萬道龍皇");
        assert_eq!(list[1].author, "牧童聽竹");
    }

    #[test]
    fn parses_chapters() {
        let html = r#"<html><body>
        <a href="/Book/Read/33827,7074633" title="x">序章 大荒</a>
        <a href="/Book/Read/33827,7074634">第一章 朝氣蓬勃</a>
        <a href="/Book/Read/33827,7074634">第一章 朝氣蓬勃</a>
        </body></html>"#;
        let ch = parse_chapters(html);
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].title, "序章 大荒");
        assert_eq!(ch[0].url, "https://tw.hjwzw.com/Book/Read/33827,7074633");
    }

    #[tokio::test]
    #[ignore]
    async fn live_search_and_detail() {
        let results = search("完美世界").await.unwrap();
        assert!(!results.is_empty());
        println!("search hit: {} / {}", results[0].name, results[0].author);
        let detail = book_detail(&results[0].url).await.unwrap();
        println!(
            "detail: {} 作者={} 分類={} 章數={}",
            detail.name,
            detail.author,
            detail.category,
            detail.chapters.len()
        );
        assert!(!detail.chapters.is_empty());
    }
}
