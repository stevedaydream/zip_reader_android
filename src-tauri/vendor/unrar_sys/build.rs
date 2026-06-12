fn main() {
    // 修正上游 bug：原本用 cfg!(windows) 判斷「主機」平台，
    // 從 Windows 交叉編譯到 Android 時會錯誤引入 Windows 專用設定。
    // 改以 CARGO_CFG_TARGET_OS 判斷「目標」平台。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let target_windows = target_os == "windows";

    if target_windows {
        println!("cargo:rustc-flags=-lpowrprof");
        println!("cargo:rustc-link-lib=shell32");
        if target_env == "gnu" {
            println!("cargo:rustc-link-lib=pthread");
        }
    } else if target_os != "android" {
        // Android bionic 的 pthread 內建於 libc，沒有獨立的 libpthread
        println!("cargo:rustc-link-lib=pthread");
    }
    let mut names: Vec<&str> = vec![
        "strlist",
        "strfn",
        "pathfn",
        "smallfn",
        "global",
        "file",
        "filefn",
        "filcreat",
        "archive",
        "arcread",
        "unicode",
        "system",
        "crypt",
        "crc",
        "rawread",
        "encname",
        "match",
        "timefn",
        "rdwrfn",
        "consio",
        "options",
        "errhnd",
        "rarvm",
        "secpassword",
        "rijndael",
        "getbits",
        "sha1",
        "sha256",
        "blake2s",
        "hash",
        "extinfo",
        "extract",
        "volume",
        "list",
        "find",
        "unpack",
        "headers",
        "threadpool",
        "rs16",
        "cmddata",
        "ui",
        "filestr",
        "scantree",
        "dll",
        "qopen",
    ];
    if target_windows {
        // isnt.cpp 使用 WinAPI（DWORD/OSVERSIONINFO），僅限 Windows 目標
        names.push("isnt");
    }
    let files: Vec<String> = names
        .iter()
        .map(|&s| format!("vendor/unrar/{s}.cpp"))
        .collect();
    cc::Build::new()
        .cpp(true) // Switch to C++ library compilation.
        .opt_level(2)
        .std("c++14")
        // by default cc crate tries to link against dynamic stdlib, which causes problems on windows-gnu target
        .cpp_link_stdlib(None)
        .warnings(false)
        .extra_warnings(false)
        .flag_if_supported("-stdlib=libc++")
        .flag_if_supported("-fPIC")
        .flag_if_supported("-Wno-switch")
        .flag_if_supported("-Wno-parentheses")
        .flag_if_supported("-Wno-macro-redefined")
        .flag_if_supported("-Wno-dangling-else")
        .flag_if_supported("-Wno-logical-op-parentheses")
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-unused-variable")
        .flag_if_supported("-Wno-unused-function")
        .flag_if_supported("-Wno-missing-braces")
        .flag_if_supported("-Wno-unknown-pragmas")
        .flag_if_supported("-Wno-deprecated-declarations")
        .define("_FILE_OFFSET_BITS", Some("64"))
        .define("_LARGEFILE_SOURCE", None)
        .define("RAR_SMP", None)
        .define("RARDLL", None)
        .files(&files)
        .compile("libunrar.a");

    // Android：上游設 cpp_link_stdlib(None) 導致 C++ 運行庫完全沒連結，
    // 載入 .so 時報 UnsatisfiedLinkError（缺 _ZTISt12length_error 等 libc++ 符號）。
    // 改為靜態連結 NDK 的 libc++（需在 libunrar.a 之後，供其解析符號）。
    if target_os == "android" {
        // rustc 自行解析 static= 函式庫，需給 NDK sysroot 的 -L 路徑
        let ndk = std::env::var("NDK_HOME")
            .or_else(|_| std::env::var("ANDROID_NDK_HOME"))
            .or_else(|_| std::env::var("ANDROID_NDK_ROOT"))
            .expect("NDK_HOME / ANDROID_NDK_HOME 未設定");
        // 這裡的 cfg! 判斷「主機」平台正確：NDK prebuilt 目錄以主機命名
        let host = if cfg!(target_os = "windows") {
            "windows-x86_64"
        } else if cfg!(target_os = "macos") {
            "darwin-x86_64"
        } else {
            "linux-x86_64"
        };
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        let triple = match arch.as_str() {
            "aarch64" => "aarch64-linux-android",
            "arm" => "arm-linux-androideabi",
            "x86" => "i686-linux-android",
            "x86_64" => "x86_64-linux-android",
            other => panic!("未支援的 Android 架構：{other}"),
        };
        // 注意：不可把整個 sysroot lib 目錄加進 -L —— 裡面還有靜態 libc.a，
        // 會讓 -lc 解析到靜態 bionic（getauxval 在啟動建構子中 segfault）。
        // 只複製需要的兩個 .a 到 OUT_DIR（cc 已將其加入搜尋路徑）。
        let libdir = format!("{ndk}/toolchains/llvm/prebuilt/{host}/sysroot/usr/lib/{triple}");
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR 未設定");
        for lib in ["libc++_static.a", "libc++abi.a"] {
            std::fs::copy(format!("{libdir}/{lib}"), format!("{out_dir}/{lib}"))
                .unwrap_or_else(|e| panic!("複製 {lib} 失敗：{e}"));
        }
        println!("cargo:rustc-link-search=native={out_dir}");
        println!("cargo:rustc-link-lib=static=c++_static");
        println!("cargo:rustc-link-lib=static=c++abi");
    }
}
