use std::path::Path;

pub const NOVEL_EXTS: [&str; 5] = ["txt", "epub", "mobi", "azw", "azw3"];

/// 依副檔名讀取小說內容，回傳純文字（段落以換行分隔）
pub fn read_novel(path: &str) -> Result<String, String> {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "txt" => read_txt(path),
        "epub" => read_epub(path),
        "mobi" | "azw" | "azw3" => read_mobi(path),
        _ => Err(format!("不支援的格式：{ext}")),
    }
}

/// TXT：自動偵測編碼（UTF-8 / Big5 / GBK…）
fn read_txt(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(&bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, _) = encoding.decode(&bytes);
    Ok(text.into_owned())
}

/// EPUB：依 spine 順序取出各章 XHTML，去除標籤
fn read_epub(path: &str) -> Result<String, String> {
    let mut doc = epub::doc::EpubDoc::new(path).map_err(|e| e.to_string())?;
    let mut out = String::new();
    let chapters = doc.get_num_chapters();
    for i in 0..chapters {
        doc.set_current_chapter(i);
        if let Some((content, _mime)) = doc.get_current_str() {
            out.push_str(&html_to_text(&content));
            out.push('\n');
        }
    }
    if out.trim().is_empty() {
        return Err("EPUB 內容為空或無法解析".into());
    }
    Ok(out)
}

/// MOBI / AZW / AZW3：取出 HTML 內容後去除標籤
fn read_mobi(path: &str) -> Result<String, String> {
    let m = mobi::Mobi::from_path(path).map_err(|e| e.to_string())?;
    let html = m.content_as_string_lossy();
    let text = html_to_text(&html);
    if text.trim().is_empty() {
        return Err("無法從此檔案取出文字內容".into());
    }
    Ok(text)
}

/// 簡易 HTML → 純文字：移除 script/style、區塊標籤轉換行、解碼常見實體
pub fn html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len() / 2);
    let bytes = html.as_bytes();
    let lower = html.to_lowercase();

    let mut i = 0;
    while i < html.len() {
        if bytes[i] == b'<' {
            // 跳過 script / style 整個區塊
            if lower[i..].starts_with("<script") {
                if let Some(end) = lower[i..].find("</script>") {
                    i += end + "</script>".len();
                    continue;
                }
            }
            if lower[i..].starts_with("<style") {
                if let Some(end) = lower[i..].find("</style>") {
                    i += end + "</style>".len();
                    continue;
                }
            }
            // 找標籤結尾
            if let Some(end) = html[i..].find('>') {
                let tag = &lower[i..i + end + 1];
                // 區塊級標籤結束 → 換行
                if tag.starts_with("</p")
                    || tag.starts_with("<br")
                    || tag.starts_with("</div")
                    || tag.starts_with("</h1")
                    || tag.starts_with("</h2")
                    || tag.starts_with("</h3")
                    || tag.starts_with("</h4")
                    || tag.starts_with("</h5")
                    || tag.starts_with("</h6")
                    || tag.starts_with("</li")
                    || tag.starts_with("</tr")
                    || tag.starts_with("</blockquote")
                {
                    text.push('\n');
                }
                i += end + 1;
                continue;
            } else {
                break;
            }
        }
        // 實體解碼
        if bytes[i] == b'&' {
            if let Some(semi) = html[i..].find(';') {
                if semi <= 10 {
                    let entity = &html[i + 1..i + semi];
                    let decoded: Option<String> = match entity {
                        "amp" => Some("&".into()),
                        "lt" => Some("<".into()),
                        "gt" => Some(">".into()),
                        "quot" => Some("\"".into()),
                        "apos" | "#39" => Some("'".into()),
                        "nbsp" => Some(" ".into()),
                        "hellip" => Some("…".into()),
                        "mdash" => Some("—".into()),
                        "ldquo" => Some("“".into()),
                        "rdquo" => Some("”".into()),
                        _ => {
                            if let Some(num) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
                                u32::from_str_radix(num, 16)
                                    .ok()
                                    .and_then(char::from_u32)
                                    .map(|c| c.to_string())
                            } else if let Some(num) = entity.strip_prefix('#') {
                                num.parse::<u32>()
                                    .ok()
                                    .and_then(char::from_u32)
                                    .map(|c| c.to_string())
                            } else {
                                None
                            }
                        }
                    };
                    if let Some(d) = decoded {
                        text.push_str(&d);
                        i += semi + 1;
                        continue;
                    }
                }
            }
        }
        // 一般字元
        let ch_len = {
            let mut l = 1;
            while i + l < html.len() && (bytes[i + l] & 0xC0) == 0x80 {
                l += 1;
            }
            l
        };
        text.push_str(&html[i..i + ch_len]);
        i += ch_len;
    }

    // 整理空白：每行 trim、壓掉連續空行
    let mut cleaned = String::with_capacity(text.len());
    for line in text.lines() {
        let line = line.trim();
        if !line.is_empty() {
            cleaned.push_str(line);
            cleaned.push('\n');
        }
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tags_and_decodes_entities() {
        let html = r#"<html><head><style>p{color:red}</style>
            <script>var x = "<p>";</script></head>
            <body><h1>第一章</h1><p>「你好」&amp;再見&hellip;</p>
            <p>第二段&#x4E2D;文</p><div>尾聲</div></body></html>"#;
        let text = html_to_text(html);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines, vec!["第一章", "「你好」&再見…", "第二段中文", "尾聲"]);
    }
}
