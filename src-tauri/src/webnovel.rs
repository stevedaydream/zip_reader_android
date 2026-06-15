use ego_tree::NodeRef;
use scraper::{Html, Node, Selector};
use url::Url;

/// 小說站常見的內文容器（依序嘗試，取文字最多者）
const CONTENT_SELECTORS: &[&str] = &[
    "#content",
    "#chaptercontent",
    "#chapter-content",
    "#booktxt",
    "#booktext",
    "#txt",
    "#nr1",
    "#article",
    "#htmlContent",
    ".content",
    ".read-content",
    ".novel-content",
    ".chapter-content",
    ".txtnav",
    ".showtxt",
    ".mw-parser-output",
    "#mw-content-text",
    "article",
];

/// 抽取內文時要整段跳過的雜訊標籤（導覽、頁首頁尾、側欄、腳本等）
const NOISE_TAGS: &[&str] = &[
    "script", "style", "nav", "header", "footer", "aside", "form", "button", "noscript", "svg",
];

/// 區塊級標籤，文字結尾補換行
const BLOCK_TAGS: &[&str] = &[
    "p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section",
];

#[derive(serde::Serialize)]
pub struct WebChapter {
    pub title: String,
    pub text: String,
    pub next_url: Option<String>,
    pub prev_url: Option<String>,
}

use crate::net::client;

pub async fn fetch_chapter(raw_url: &str) -> Result<WebChapter, String> {
    let base = Url::parse(raw_url).map_err(|e| format!("網址無效：{e}"))?;
    if base.scheme() != "http" && base.scheme() != "https" {
        return Err("僅支援 http / https 網址".into());
    }
    let resp = client()
        .get(base.clone())
        .send()
        .await
        .map_err(|e| format!("連線失敗：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("讀取失敗：{e}"))?;
    let html = decode_html(&bytes, &content_type);

    let chapter = extract(&html, &base);
    if chapter.text.trim().chars().count() < 50 {
        return Err("無法從此頁面解析出內文（可能是目錄頁或需要登入）".into());
    }
    Ok(chapter)
}

/// 解碼 HTML：優先 HTTP header charset → meta charset → chardetng 自動偵測
fn decode_html(bytes: &[u8], content_type: &str) -> String {
    if let Some(cs) = charset_label(content_type) {
        if let Some(enc) = encoding_rs::Encoding::for_label(cs.as_bytes()) {
            return enc.decode(bytes).0.into_owned();
        }
    }
    // 掃 head 前 2KB 找 <meta charset=...>
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_lowercase();
    if let Some(cs) = charset_label(&head) {
        if let Some(enc) = encoding_rs::Encoding::for_label(cs.as_bytes()) {
            return enc.decode(bytes).0.into_owned();
        }
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(None, true).decode(bytes).0.into_owned()
}

fn charset_label(text: &str) -> Option<String> {
    let pos = text.to_lowercase().find("charset=")?;
    let rest = &text[pos + "charset=".len()..];
    let label: String = rest
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

fn extract(html: &str, base: &Url) -> WebChapter {
    let doc = Html::parse_document(html);

    // ----- 標題：h1 優先，否則 <title> 去掉站名 -----
    let title = select_text(&doc, "h1")
        .filter(|t| !t.is_empty())
        .or_else(|| select_text(&doc, "title").map(|t| clean_title(&t)))
        .unwrap_or_default();

    // ----- 內文：已知選擇器 → 密度評分備援 -----
    // 以「跳過雜訊標籤後的純文字長度」評分，避免導覽/側欄灌水
    let mut best_text = String::new();
    let mut best_score = 0usize;
    for s in CONTENT_SELECTORS {
        let Ok(selector) = Selector::parse(s) else {
            continue;
        };
        for el in doc.select(&selector) {
            let text = clean_text(el);
            let len = text.chars().count();
            if len > best_score {
                best_score = len;
                best_text = text;
            }
        }
    }
    if best_score < 200 {
        // 備援：對所有區塊做文字密度評分（內文長、連結少、巢狀淺者勝）
        let block_sel = Selector::parse("div, section, td, article").unwrap();
        let a_sel = Selector::parse("a").unwrap();
        let div_sel = Selector::parse("div").unwrap();
        for el in doc.select(&block_sel) {
            let text = clean_text(el);
            let text_len = text.chars().count();
            let link_len: usize = el.select(&a_sel).flat_map(|a| a.text()).map(str::len).sum();
            let child_divs = el.select(&div_sel).count();
            let score = text_len.saturating_sub(link_len * 3) / (1 + child_divs);
            if score > best_score {
                best_score = score;
                best_text = text;
            }
        }
    }
    let text = normalize_lines(&best_text);

    // ----- 上一章 / 下一章連結 -----
    let mut next_url = None;
    let mut prev_url = None;
    if let Ok(a_sel) = Selector::parse("a[href]") {
        for a in doc.select(&a_sel) {
            let label: String = a.text().collect::<String>().trim().to_string();
            let Some(href) = a.value().attr("href") else {
                continue;
            };
            if href.is_empty() || href.starts_with("javascript") || href.starts_with('#') {
                continue;
            }
            let is_next = label.contains("下一章")
                || label.contains("下一頁")
                || label.contains("下一页")
                || label.contains("下章")
                || label.eq_ignore_ascii_case("next");
            let is_prev = label.contains("上一章")
                || label.contains("上一頁")
                || label.contains("上一页")
                || label.contains("上章")
                || label.eq_ignore_ascii_case("prev");
            if is_next && next_url.is_none() {
                next_url = base.join(href).ok().map(String::from);
            } else if is_prev && prev_url.is_none() {
                prev_url = base.join(href).ok().map(String::from);
            }
        }
    }

    WebChapter {
        title,
        text,
        next_url,
        prev_url,
    }
}

/// 遍歷元素子樹取出文字，整段跳過 NOISE_TAGS，區塊標籤後補換行。
fn clean_text(el: scraper::ElementRef) -> String {
    let mut out = String::new();
    walk_text(*el, &mut out);
    out
}

fn walk_text(node: NodeRef<Node>, out: &mut String) {
    for child in node.children() {
        match child.value() {
            Node::Text(t) => out.push_str(t),
            Node::Element(e) => {
                let tag = e.name();
                if NOISE_TAGS.contains(&tag) {
                    continue; // 整段略過導覽/腳本等
                }
                walk_text(child, out);
                if BLOCK_TAGS.contains(&tag) {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
}

/// 常見小說站浮水印／導覽殘留（整行命中即丟棄）
const BOILERPLATE: &[&str] = &[
    "請記住本站",
    "请记住本站",
    "請記住域名",
    "请记住域名",
    "手機版閱讀",
    "手机版阅读",
    "天才一秒記住",
    "天才一秒记住",
    "最快更新",
    "本章未完",
    "章節報錯",
    "加入書籤",
    "投推薦票",
    "請收藏本站",
    "请收藏本站",
];

fn is_boilerplate(line: &str) -> bool {
    if BOILERPLATE.iter().any(|p| line.contains(p)) {
        return true;
    }
    // 純網址行（站點浮水印常見）
    let lower = line.to_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www."))
        && !line.contains(' ')
}

/// 整理：每行 trim、去連續空行、濾掉站點浮水印
fn normalize_lines(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    for line in text.lines() {
        let line = line.trim();
        if !line.is_empty() && !is_boilerplate(line) {
            cleaned.push_str(line);
            cleaned.push('\n');
        }
    }
    cleaned
}

fn select_text(doc: &Html, selector: &str) -> Option<String> {
    let sel = Selector::parse(selector).ok()?;
    doc.select(&sel)
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
}

/// <title> 常見格式「章節名_書名_站名」→ 取第一段
fn clean_title(title: &str) -> String {
    title
        .split(['_', '|', '-'])
        .next()
        .unwrap_or(title)
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_content_title_and_nav() {
        let html = r#"<html><head><title>第三章 風起_某某小說_某站</title></head>
        <body><div class="nav"><a href="/index">目錄</a></div>
        <h1>第三章 風起</h1>
        <div id="content">山雨欲來風滿樓。<br><br>他抬起頭，望向遠方那座沉默的城，心裡明白今晚註定無眠。
        城牆上的燈火連成一線，把夜色割出一道傷口；風從北方來，捲著沙與舊事，吹進每一個不肯入睡的窗。</div>
        <div class="pager"><a href="/book/2.html">上一章</a><a href="/book/4.html">下一章</a></div>
        </body></html>"#;
        let base = Url::parse("https://example.com/book/3.html").unwrap();
        let ch = extract(html, &base);
        assert_eq!(ch.title, "第三章 風起");
        assert!(ch.text.contains("山雨欲來風滿樓"));
        assert!(!ch.text.contains("目錄"));
        assert_eq!(ch.next_url.as_deref(), Some("https://example.com/book/4.html"));
        assert_eq!(ch.prev_url.as_deref(), Some("https://example.com/book/2.html"));
    }

    // 實際抓取一個公開穩定的章節頁，驗證 fetch + 解碼 + 解析的完整管線。
    // 需要網路，預設略過：`cargo test --lib -- --ignored live_fetch`
    #[tokio::test]
    #[ignore]
    async fn live_fetch_wikisource() {
        let url = "https://zh.wikisource.org/wiki/%E4%B8%89%E5%9C%8B%E6%BC%94%E7%BE%A9/%E7%AC%AC001%E5%9B%9E";
        let ch = fetch_chapter(url).await.expect("fetch failed");
        println!("title = {}", ch.title);
        println!("text len = {} chars", ch.text.chars().count());
        println!("first 80: {}", ch.text.chars().take(80).collect::<String>());
        assert!(ch.text.chars().count() > 500, "內文太短，解析可能失敗");
    }
}
