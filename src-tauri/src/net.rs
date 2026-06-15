//! 共用 HTTP client。
//! Android 上 reqwest+rustls 預設用 rustls-platform-verifier，但它需經 JNI 初始化，
//! 未初始化會在 TLS 握手時 panic。改用 use_preconfigured_tls 灌入 webpki 內建根憑證，
//! 完全繞過 platform verifier（桌面與 Android 行為一致）。

use std::sync::{Arc, OnceLock};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

fn tls_config() -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("rustls protocol versions")
    .with_root_certificates(roots)
    .with_no_client_auth()
}

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .timeout(std::time::Duration::from_secs(20))
            .use_preconfigured_tls(tls_config())
            .build()
            .expect("build http client")
    })
}
