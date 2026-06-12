use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder};

static WIN_SEQ: AtomicU64 = AtomicU64::new(0);

/// 常見廣告／彈窗網域（含子網域比對）
const AD_HOSTS: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "adservice.google.com",
    "adnxs.com",
    "adsterra.com",
    "popads.net",
    "popcash.net",
    "propellerads.com",
    "exoclick.com",
    "juicyads.com",
    "onclickads.net",
    "onclkds.com",
    "mgid.com",
    "taboola.com",
    "outbrain.com",
    "revcontent.com",
    "trafficjunky.net",
    "tsyndicate.com",
    "adtng.com",
    "hilltopads.net",
    "clickadu.com",
    "adcash.com",
];

/// 注入每個頁面的廣告阻擋腳本：擋彈窗 + 隱藏常見廣告元素
const ADBLOCK_JS: &str = r##"
(() => {
  // 阻擋彈出視窗（彈窗廣告最常見的入口）
  try { window.open = () => null; } catch (_) {}

  const HIDE = [
    "ins.adsbygoogle", ".adsbygoogle",
    "[id^='google_ads_']", "[id^='div-gpt-ad']",
    "iframe[src*='doubleclick.net']", "iframe[src*='googlesyndication']",
    "iframe[src*='adsterra']", "iframe[src*='exoclick']", "iframe[src*='juicyads']",
    "iframe[src*='popads']", "iframe[src*='mgid.com']", "iframe[src*='taboola']",
    "#carbonads", ".ad-banner", ".ad-container", ".ad-wrapper", ".sponsored-ad"
  ].join(",");

  const inject = () => {
    const s = document.createElement("style");
    s.textContent = HIDE + "{display:none!important;visibility:hidden!important;height:0!important}";
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
"##;

fn is_blocked(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => {}
        // 非網頁協定一律阻擋（magnet、自訂 scheme 等）
        _ => return url.scheme() != "about",
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    AD_HOSTS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

pub fn open(app: &AppHandle, url: &str, title: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|e| format!("網址無效：{e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("僅支援 http / https 網址".into());
    }
    let label = format!("web-{}", WIN_SEQ.fetch_add(1, Ordering::Relaxed));
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1150.0, 820.0)
        .initialization_script(ADBLOCK_JS)
        .on_navigation(|url| !is_blocked(url))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
