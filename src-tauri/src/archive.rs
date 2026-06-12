use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

const IMAGE_EXTS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];
pub const ARCHIVE_EXTS: [&str; 6] = ["zip", "cbz", "7z", "cb7", "rar", "cbr"];

#[derive(Debug)]
pub enum ArchiveError {
    /// 需要密碼或密碼錯誤
    NeedPassword,
    Other(String),
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveError::NeedPassword => write!(f, "需要密碼"),
            ArchiveError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl From<std::io::Error> for ArchiveError {
    fn from(e: std::io::Error) -> Self {
        ArchiveError::Other(e.to_string())
    }
}

enum Kind {
    Zip,
    SevenZ,
    Rar,
}

fn kind_of(path: &str) -> Result<Kind, ArchiveError> {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "zip" | "cbz" => Ok(Kind::Zip),
        "7z" | "cb7" => Ok(Kind::SevenZ),
        "rar" | "cbr" => Ok(Kind::Rar),
        _ => Err(ArchiveError::Other(format!("不支援的格式：{ext}"))),
    }
}

fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

pub fn mime_for(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "image/jpeg"
    }
}

/// 列出壓縮檔內所有圖片（自然排序），並讀取第一張驗證密碼有效。
pub fn list_and_validate(path: &str, password: Option<&str>) -> Result<Vec<String>, ArchiveError> {
    let mut entries = list_images(path, password)?;
    if entries.is_empty() {
        return Err(ArchiveError::Other("壓縮檔內沒有圖片".into()));
    }
    entries.sort_by(|a, b| natord::compare_ignore_case(a, b));
    // 讀第一張驗證密碼是否正確（加密內容只有實際解壓才會暴露密碼錯誤）
    read_entry(path, &entries[0], password)?;
    Ok(entries)
}

fn list_images(path: &str, password: Option<&str>) -> Result<Vec<String>, ArchiveError> {
    match kind_of(path)? {
        Kind::Zip => zip_list(path),
        Kind::SevenZ => sevenz_list(path, password),
        Kind::Rar => rar_list(path, password),
    }
}

pub fn read_entry(path: &str, entry: &str, password: Option<&str>) -> Result<Vec<u8>, ArchiveError> {
    match kind_of(path)? {
        Kind::Zip => zip_read(path, entry, password),
        Kind::SevenZ => sevenz_read(path, entry, password),
        Kind::Rar => rar_read(path, entry, password),
    }
}

// ---------- ZIP ----------

fn map_zip_err(e: zip::result::ZipError) -> ArchiveError {
    use zip::result::ZipError;
    match e {
        ZipError::InvalidPassword => ArchiveError::NeedPassword,
        ZipError::UnsupportedArchive(msg) if msg.to_lowercase().contains("password") => {
            ArchiveError::NeedPassword
        }
        other => ArchiveError::Other(other.to_string()),
    }
}

fn zip_open(path: &str) -> Result<zip::ZipArchive<BufReader<File>>, ArchiveError> {
    let file = File::open(path)?;
    zip::ZipArchive::new(BufReader::new(file)).map_err(map_zip_err)
}

fn zip_list(path: &str) -> Result<Vec<String>, ArchiveError> {
    // ZIP 的中央目錄不加密，列出檔名不需要密碼
    let archive = zip_open(path)?;
    Ok(archive
        .file_names()
        .filter(|n| is_image(n))
        .map(String::from)
        .collect())
}

fn zip_read(path: &str, entry: &str, password: Option<&str>) -> Result<Vec<u8>, ArchiveError> {
    let mut archive = zip_open(path)?;
    let mut file = match password {
        Some(pw) => archive
            .by_name_decrypt(entry, pw.as_bytes())
            .map_err(map_zip_err)?,
        None => archive.by_name(entry).map_err(map_zip_err)?,
    };
    let mut buf = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut buf)?;
    Ok(buf)
}

// ---------- 7Z ----------

fn map_7z_err(e: sevenz_rust::Error) -> ArchiveError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("password") || lower.contains("checksum") {
        ArchiveError::NeedPassword
    } else {
        ArchiveError::Other(msg)
    }
}

fn sevenz_open(
    path: &str,
    password: Option<&str>,
) -> Result<sevenz_rust::SevenZReader<File>, ArchiveError> {
    let pw = match password {
        Some(p) => sevenz_rust::Password::from(p),
        None => sevenz_rust::Password::empty(),
    };
    sevenz_rust::SevenZReader::open(path, pw).map_err(map_7z_err)
}

fn sevenz_list(path: &str, password: Option<&str>) -> Result<Vec<String>, ArchiveError> {
    let reader = sevenz_open(path, password)?;
    Ok(reader
        .archive()
        .files
        .iter()
        .filter(|e| !e.is_directory() && is_image(e.name()))
        .map(|e| e.name().to_string())
        .collect())
}

fn sevenz_read(path: &str, entry: &str, password: Option<&str>) -> Result<Vec<u8>, ArchiveError> {
    let mut reader = sevenz_open(path, password)?;
    let mut result: Option<Vec<u8>> = None;
    let mut read_err: Option<String> = None;
    reader
        .for_each_entries(|e, r| {
            if e.name() == entry {
                let mut buf = Vec::new();
                if let Err(err) = r.read_to_end(&mut buf) {
                    read_err = Some(err.to_string());
                } else {
                    result = Some(buf);
                }
                Ok(false) // 找到就停止
            } else {
                Ok(true)
            }
        })
        .map_err(map_7z_err)?;
    if let Some(err) = read_err {
        let lower = err.to_lowercase();
        if lower.contains("password") || lower.contains("checksum") {
            return Err(ArchiveError::NeedPassword);
        }
        return Err(ArchiveError::Other(err));
    }
    result.ok_or_else(|| ArchiveError::Other(format!("找不到檔案：{entry}")))
}

// ---------- RAR ----------

fn map_rar_err(e: unrar::error::UnrarError) -> ArchiveError {
    use unrar::error::Code;
    match e.code {
        Code::MissingPassword | Code::BadPassword => ArchiveError::NeedPassword,
        _ => ArchiveError::Other(e.to_string()),
    }
}

fn normalize(name: &str) -> String {
    name.replace('\\', "/")
}

fn rar_archive<'a>(path: &'a str, password: Option<&'a str>) -> unrar::Archive<'a> {
    match password {
        Some(pw) => unrar::Archive::with_password(path, pw),
        None => unrar::Archive::new(path),
    }
}

fn rar_list(path: &str, password: Option<&str>) -> Result<Vec<String>, ArchiveError> {
    let archive = rar_archive(path, password)
        .open_for_listing()
        .map_err(map_rar_err)?;
    let mut names = Vec::new();
    for item in archive {
        let header = item.map_err(map_rar_err)?;
        if header.is_file() {
            let name = normalize(&header.filename.to_string_lossy());
            if is_image(&name) {
                names.push(name);
            }
        }
    }
    Ok(names)
}

fn rar_read(path: &str, entry: &str, password: Option<&str>) -> Result<Vec<u8>, ArchiveError> {
    let mut archive = rar_archive(path, password)
        .open_for_processing()
        .map_err(map_rar_err)?;
    while let Some(header) = archive.read_header().map_err(map_rar_err)? {
        let name = normalize(&header.entry().filename.to_string_lossy());
        if header.entry().is_file() && name == entry {
            let (data, _) = header.read().map_err(map_rar_err)?;
            return Ok(data);
        }
        archive = header.skip().map_err(map_rar_err)?;
    }
    Err(ArchiveError::Other(format!("找不到檔案：{entry}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::unstable::write::FileOptionsExt;

    // 1x1 PNG
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn make_zip(path: &std::path::Path, password: Option<&str>) {
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let mut options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if let Some(pw) = password {
            options = options.with_deprecated_encryption(pw.as_bytes());
        }
        writer.start_file("page2.png", options).unwrap();
        writer.write_all(PNG).unwrap();
        writer.start_file("page10.png", options).unwrap();
        writer.write_all(PNG).unwrap();
        writer.start_file("note.txt", options).unwrap();
        writer.write_all(b"not an image").unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn plain_zip_lists_and_reads() {
        let dir = std::env::temp_dir().join("comic_reader_test_plain");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plain.zip");
        make_zip(&path, None);
        let p = path.to_string_lossy().to_string();

        let entries = list_and_validate(&p, None).unwrap();
        // 自然排序：page2 在 page10 前；txt 被過濾
        assert_eq!(entries, vec!["page2.png", "page10.png"]);
        let data = read_entry(&p, "page2.png", None).unwrap();
        assert_eq!(data, PNG);
    }

    #[test]
    fn encrypted_zip_password_flow() {
        let dir = std::env::temp_dir().join("comic_reader_test_enc");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("enc.zip");
        make_zip(&path, Some("secret123"));
        let p = path.to_string_lossy().to_string();

        // 無密碼 → NeedPassword
        assert!(matches!(
            list_and_validate(&p, None),
            Err(ArchiveError::NeedPassword)
        ));
        // 正確密碼 → 成功
        let entries = list_and_validate(&p, Some("secret123")).unwrap();
        assert_eq!(entries.len(), 2);
        let data = read_entry(&p, "page2.png", Some("secret123")).unwrap();
        assert_eq!(data, PNG);
    }
}
