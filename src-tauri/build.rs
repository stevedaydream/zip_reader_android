fn main() {
    // Android 15+ 16KB page size 要求：LOAD 區段須以 16KB 對齊
    // （tauri CLI 會設 CARGO_TARGET_*_RUSTFLAGS，.cargo/config.toml 的
    //  rustflags 會被蓋掉，所以用 build.rs 的 link-arg 傳遞）
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "android" {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
