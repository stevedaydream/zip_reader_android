# 踩坑紀錄

## -5. 原生 TTS 引擎/語音清單空白、中文語音被濾光（2026-07）

**症狀**：閱讀設定的「引擎/語音」下拉點進去全空白。

**原因**（兩層）：
1. 前端只靠外掛的一次性 `ttsReady` 事件填清單，但外掛在 `load()`（webview 建立時）
   就 `trigger("ttsReady")`，早於 JS `addPluginListener` 註冊 → 事件被錯過，永不填。
2. 中文語音過濾只認 `locale.language == "zh"`，但 Google 等引擎的普通話語音語言碼是
   **`cmn`**（ISO 639-3），會被全數濾掉。

**解法**：前端啟動時**主動**呼 listEngines/listVoices 並輪詢（等 TTS 就緒），不單靠事件；
外掛 `isChinese()` 放寬為 `zh/cmn/yue/zho`。

## -4. widget/通知不顯示章節標題（updatePlayback 早於 beginSession，2026-07）

**症狀**：朗讀開始後 widget/通知的章節標題一直空白，要等暫停或換章才出現。

**原因**：`speakFrom` 裡 `reportPlayback(true)` 在 `speakCurrent()` **之前**呼叫，
此時原生 `beginSession` 尚未執行、`isTtsActive` 仍為 false → `updatePlayback` 被
「非朗讀中則忽略」的守衛擋掉，首次標題送不出去。

**解法**：改由 `speak` 指令帶 `title`，在 Kotlin `beginSession()` **之後**、標題有變時
才 `pushState(true, title)` 同步通知/widget，徹底避開 JS↔原生的會話啟動 race。

## -2. 螢幕關閉後 TTS 停止換段/換章（2026-06）

**症狀**：朗讀時關閉螢幕，過一段就停，無法自動換章。

**原因**（兩層）：
1. wry 的 `WryActivity.onPause()` 會呼叫 `mWebView.onPause()`，暫停 WebView 的
   JS 執行 → 我們「唸完一段(原生 done 事件)→ JS 抓下一段/下一章 → 再朗讀」的鏈停擺。
2. 螢幕關閉後 CPU 進入休眠，即使 JS 沒被暫停，計時器與網路也會凍結。

**解法**：
- BridgePlugin：朗讀時取得 `PARTIAL_WAKE_LOCK`（speak 時 acquire、stopSpeak 時 release，
  含 1 小時逾時保險），並設 companion `isTtsActive` 旗標。需在外掛 manifest 加 WAKE_LOCK。
- MainActivity（覆寫 `onWebViewCreate` 取得 webview、覆寫 `onPause`）：
  `super.onPause()` 後若 `BridgePlugin.isTtsActive` 為真，立即 `webView.onResume()` +
  `resumeTimers()` 抵銷 wry 的暫停，使 JS 鏈在螢幕關閉時持續。
- 注意：MainActivity 在 gen/android（已入庫）；app 模組已依賴外掛模組故可 import BridgePlugin。
- 若長時間螢幕關閉仍受 Doze 影響網路，下一步需改用前景服務（foreground service）。

## -1. Android 上 reqwest+rustls HTTPS 直接 panic（2026-06）

**症狀**：裝置上抓網路小說時閃退/卡住，logcat：
`thread 'tokio-rt-worker' panicked ... rustls-platform-verifier ... Expect rustls-platform-verifier to be initialized`。

**原因**：reqwest 0.13 啟用 `rustls` feature 時，若未提供根憑證會用
`rustls-platform-verifier`，它在 Android 需經 JNI 初始化（讀系統憑證庫），
未初始化即 panic。reqwest 內部**不會**用 `webpki-roots` feature（查證 reqwest 原始碼確認）。

**解法**（net.rs 共用 client）：用 `use_preconfigured_tls()` 自建 rustls ClientConfig，
以 `webpki_roots::TLS_SERVER_ROOTS` 灌入 RootCertStore，provider 用 `aws_lc_rs`
（與 reqwest 一致，已能交叉編譯）。完全繞過 platform verifier，桌面/Android 行為一致。
直接依賴需對齊 reqwest 鎖定版本：rustls 0.23、webpki-roots 1。

## 0. .so LOAD 區段需 16KB 對齊（Android 15+，2026-06）

Google Play 要求原生庫支援 16KB page size；未對齊的 .so 在 16KB 分頁裝置上無法載入。
tauri CLI 會設定 `CARGO_TARGET_*_RUSTFLAGS` 環境變數，導致 `.cargo/config.toml`
的 rustflags 被覆蓋無效 → 正解是在 **src-tauri/build.rs** 對 android 目標發
`cargo:rustc-link-arg=-Wl,-z,max-page-size=16384`。
驗證：`llvm-readelf -l libcomic_reader_lib.so`，LOAD 的 Align 應為 0x4000。

## 0a. 網頁小說解析：用 inner_html 評分會被導覽灌水（2026-06）

通用內文抽取若以「元素 inner_html 文字長度」評分挑最大區塊，MediaWiki 等
站點會選到含側邊欄/工具列的大容器，純文字裡混入「English / 工具 / 编辑」雜訊。
**解法**（webnovel.rs）：用 ego_tree 樹遍歷 `walk_text`，整段跳過
NOISE_TAGS（nav/header/footer/aside/script/style/form/button/svg），
評分改以「跳過雜訊後的純文字字數」。另加 `.mw-parser-output` 等已知容器選擇器。
注意 ego_tree 要在 Cargo.toml 顯式宣告（scraper 不 re-export），版本對齊 lock。

## 1. unrar_sys 從 Windows 交叉編譯 Android 失敗（2026-06）

**症狀**：`npx tauri android build` 時 cc-rs 報錯，先是
`use of undeclared identifier 'lutimes'`，後是 `unknown type name 'DWORD'`（isnt.cpp）。

**原因**（三層）：

1. `lutimes` 在 Android bionic 要 **API 26** 才有 → tauri.conf.json 設
   `bundle.android.minSdkVersion: 26`，且改完要刪 `src-tauri/gen` 重跑 `npx tauri android init`
   （cc 的 `--target=aarch64-linux-androidXX` 由 minSdk 決定）。
2. unrar_sys 0.5.8 的 build.rs 用 `cfg!(windows)` / `#[cfg(windows)]` 判斷的是
   **build script 的主機平台**，不是編譯目標 → 在 Windows 上交叉編譯 Android 時
   錯誤地編入 Windows 專用的 `isnt.cpp`、連結 `powrprof`。
   **解法**：vendor 到 `src-tauri/vendor/unrar_sys`，build.rs 改用
   `CARGO_CFG_TARGET_OS` 環境變數判斷，Cargo.toml 加 `[patch.crates-io]`。
3. 第三關連結錯誤 `unable to find library -lpthread`：Android bionic 的 pthread
   內建於 libc，沒有獨立 libpthread → build.rs 在 android 目標不要 emit
   `rustc-link-lib=pthread`。

## 2a. 行動外掛事件監聽也要授權（2026-06）

前端 `addPluginListener("androidbridge", "done", …)` 底層呼叫
`plugin:androidbridge|registerListener`，若 build.rs 的 COMMANDS 沒列
`registerListener` / `removeListener`，執行期 console 報
`androidbridge.registerListener not allowed. Command not found`（不會閃退、容易漏掉）。
COMMANDS 與 permissions/default.toml 都要加。

## 2. Tauri 行動外掛權限識別字保留 camelCase（2026-06）

build.rs 的 `COMMANDS` 寫 `stopSpeak` → 自動產生的權限是 `allow-stopSpeak`
（**不會**轉成 kebab-case 的 allow-stop-speak）。`permissions/default.toml`
寫錯會在 `tauri::generate_context!` 編譯期報
`SetPermissionNotFound { permission: "allow-stop-speak" }`。

## 3. Android 平台不支援的外掛要雙重隔離（2026-06）

`tauri-plugin-updater`、`tauri-plugin-process` 不支援 Android：

- Cargo.toml 放 `[target.'cfg(not(any(target_os = "android", …)))'.dependencies]`
- capabilities 也要拆檔：desktop.json 加 `"platforms": ["windows", "macOS", "linux"]`，
  否則 Android 編譯時 ACL 找不到 updater/process 權限直接編譯失敗。

## 4. Android WebView 無 speechSynthesis（2026-06）

`window.speechSynthesis` 在 Android System WebView 不可用（Chrome 才有）。
朗讀必須走原生 `TextToSpeech`，本專案以自寫外掛 `tauri-plugin-androidbridge` 橋接，
事件 `done` 推進下一段。原生 TTS 沒有 pause/resume，「暫停→繼續」以重唸目前段落實作。

## 5. Windows PowerShell 跑 tauri 參數被 npm 吃掉（2026-06）

`npm run tauri android build -- --apk` 在 PowerShell 下旗標會被 npm 解析掉
（warn "Unknown cli config"）。改用 `npx tauri android build --apk …` 直接呼叫。

## 6. Windows 需開啟「開發人員模式」（2026-06）

tauri android build 會把編好的 .so **符號連結**到 gen/android 的 jniLibs，
Windows 預設不允許非管理員建 symlink → 報
`Creation symbolic link is not allowed for this system`。
解法：設定 → 系統 → 開發人員選項 → 開發人員模式，或
`reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1`（需管理員）。

## 7. Gradle 需 JDK 17（2026-06）

系統 JAVA_HOME 若指向 JDK 11 會失敗；設
`$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"`（Android Studio 內建 17）。

## 8. ANDROID_SDK_ROOT 與 ANDROID_HOME 衝突（2026-06）

本機使用者環境變數 ANDROID_SDK_ROOT 曾被設成 Android Studio 的 jbr 路徑（JDK 而非 SDK），
Gradle 偵測到兩者不一致直接失敗。建置時需一併覆寫：
`$env:ANDROID_SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"`（或永久修正該變數）。

## 9. APK 啟動閃退：UnsatisfiedLinkError 缺 libc++ 符號（2026-06）

**症狀**：安裝後立即閃退，logcat crash buffer 顯示
`dlopen failed: cannot locate symbol "_ZTISt12length_error" referenced by libcomic_reader_lib.so`。

**原因**：unrar_sys 上游 build.rs 設了 `.cpp_link_stdlib(None)`（為繞 windows-gnu 問題），
C++ 運行庫完全沒被連結；Windows 桌面恰好沒事，Android 載入 .so 時就缺 libc++ 符號。

**解法**：vendored build.rs 在 `compile()` 之後（連結順序重要）對 android 目標補：
`cargo:rustc-link-lib=static=c++_static` + `static=c++abi`（NDK 靜態 libc++）。
偵錯指令：`adb logcat -d -b crash`。

**第二層地雷**：不可直接把 NDK 的 `sysroot/usr/lib/<triple>` 加進 `rustc-link-search` ——
該目錄含**靜態 bionic libc.a**，`-lc` 會被解析成靜態版，啟動建構子
`init_have_lse_atomics → getauxval` 立即 SIGSEGV（native crash，backtrace 顯示
getauxval 符號落在自家 .so 內就是這個徵兆）。正解：只把 `libc++_static.a`、
`libc++abi.a` 複製到 OUT_DIR 再 link-search OUT_DIR。

## 10. Kotlin 外掛沒有 onDetachedFromActivity（2026-06）

Tauri 的 `app.tauri.plugin.Plugin` 基底類別沒有 Capacitor 風格的生命週期方法，
`override fun onDetachedFromActivity()` 會報 "overrides nothing"。只能用 `load(webView)`。

## -3. 螢幕關閉換章仍卡住 → 前景服務豁免 Doze（2026-06）

**症狀**（接 -2 之後）：wake lock + WebView keepalive 後，螢幕關閉時 TTS 音訊與
換段都正常，但**換章仍卡住**。

**原因**：換章與換段唯一差別是換章要發**網路請求**抓下一章。螢幕關閉後 Android
**Doze** 凍結背景 app 的網路 → fetch 下一章失敗。wake lock 只保 CPU，擋不住 Doze 網路限制。

**解法**：TtsService（mediaPlayback 前景服務）。前景服務狀態使 app 豁免 Doze 網路限制。
會話生命週期重構：speak=beginSession（首次啟服務，必於使用者點朗讀的前景時機）、
stopSpeak=僅中止當前朗讀（換段/換章/暫停，不拆服務）、endTts=結束會話（停服務+釋放 wake）。
避免換章時拆服務又得在背景重啟（背景啟前景服務會被拒）。
manifest 需 FOREGROUND_SERVICE、FOREGROUND_SERVICE_MEDIA_PLAYBACK、POST_NOTIFICATIONS
及 <service foregroundServiceType="mediaPlayback">。
dumpsys 驗證：isForeground=true、types=0x2（MEDIA_PLAYBACK）。

## 11. 章節目錄文字被上下裁切（WebView grid 列高，2026-06）

**症狀**：底部章節目錄面板（`.nr-toc-list`）每行中文字只剩上半，下半被切掉。

**原因**：共用的 `.toc-list` 用 `display:grid` + `.toc-item` 的 `overflow:hidden`（為水平省略號）。
在 Android/BlueStacks WebView 下 grid 的列高被壓到比字身還小，襯線中文字（Noto Serif TC
字身偏高）就被上下裁。先試加 `line-height` 無效——壓列高的是 grid 不是行高。

**解法**（styles.css）：底部目錄改 **block 排版**覆蓋 grid——`.nr-toc-list{display:block}`、
`.nr-toc-list .toc-item{display:block;width:100%;min-height:46px;line-height:24px}`（用 px 行高）。
驗證：BlueStacks 上目錄章節標題完整顯示、目前章高亮定位正常。

## 12. backdrop-filter 毛玻璃不吃 border-radius，閱讀頁變方塊（2026-06）

**症狀**：右下角三色切換懸浮鈕（`.fab-glass` 用 `backdrop-filter` + `border-radius:50%`）
在純色閱讀背景上顯示成一整塊方形毛玻璃，圓角失效、擋到內文。

**原因**：Android WebView/Chromium 對 `backdrop-filter` 元素的 `border-radius` 裁切有缺陷，
模糊區會溢出成 bounding box（方形），純色背景上特別明顯。

**解法**（styles.css）：對做毛玻璃那層強制圓形裁切 `clip-path: circle(50%)` + `overflow:hidden`；
因 clip-path 會連外陰影一起裁掉，故把浮起用的外 `box-shadow` 移到父按鈕（圓形、未被裁），
玻璃層只留 inset 高光。父層加 `isolation:isolate` 自成堆疊脈絡。三色閱讀模式皆驗證為圓形。
