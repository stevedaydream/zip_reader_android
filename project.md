# 專案總覽：漫畫壓縮檔閱讀器 Android 版

由桌面版 `I:\project\zip_reader` 衍生（2026-06-12），同功能移植到 Android（Tauri 2 mobile）。
桌面仍可執行（`npm run tauri dev`），平台差異在前端以 `isAndroid` 分流。

## 技術棧

- **後端**：Rust（Tauri 2）— 與桌面版相同（zip / sevenz-rust / unrar / epub / mobi / chardetng）
- **前端**：Vite + vanilla TypeScript
- **Android 原生**：自寫 Tauri 行動外掛 `tauri-plugin-androidbridge`（Kotlin）

## 與桌面版的架構差異

```
src-tauri/plugins/tauri-plugin-androidbridge/
  src/lib.rs          註冊 Android 外掛（桌面 no-op）
  build.rs            COMMANDS（camelCase！權限識別字也是 camelCase：allow-stopSpeak）
  permissions/default.toml
  android/…/BridgePlugin.kt
                      原生 TextToSpeech（speak/stopSpeak + done/error 事件）、
                      hasAllFilesAccess / requestAllFilesAccess（MANAGE_EXTERNAL_STORAGE）、
                      朗讀遙控：emitRemote 把通知/widget 按鈕轉成 "remoteControl" 事件回 JS，
                      updatePlayback 命令由 JS 回報播放狀態（同步通知圖示＋widget）
  android/…/TtsService.kt
                      朗讀前景服務；通知列帶「暫停/繼續」「停止」兩顆按鈕（離開 app／鎖屏即可停），
                      按鈕經 onStartCommand → BridgePlugin.emitRemote → JS
  android/…/NovelWidgetProvider.kt
                      桌面遙控 widget（同兩顆控制，共用 emitRemote）；僅朗讀中可用、閒置轉灰
                      （res/layout/novel_widget.xml、res/xml/novel_widget_info.xml）
  android/src/main/AndroidManifest.xml
                      宣告儲存權限＋widget receiver（經 manifest merge 併入 app，免手動改 gen）
src-tauri/src/webnovel.rs
                      網路小說抓取＋純淨化解析（reqwest + scraper）：
                      編碼偵測（header/meta/chardetng）、已知內文選擇器＋文字密度備援、
                      上一章/下一章連結偵測（含單元測試）
src-tauri/src/webshelf.rs
                      網路小說書架（webnovels.json：書名→最後閱讀章節網址）
src-tauri/src/hjwzw.rs
                      黃金屋書源（tw.hjwzw.com）：分類清單、分類/搜尋書籍列表、
                      書籍詳情＋完整目錄（/Book/Chapter/{id}）。章節內文沿用 webnovel。
                      注意：scraper::Html 非 Send，async command 內須在 .await 前解析完並 drop。
src-tauri/src/favorites.rs
                      我的最愛（favorites.json：書名/作者/書籍頁/續讀章節）
src-tauri/src/preload.rs
                      離線預載快取：app_data/preload/<bookkey>/meta.json＋ch_*.json
                      （FNV-1a 雜湊網址當檔名）；全域 settings.json 存保留天數；
                      指令 preload_* 在 lib.rs（cache/get/list/delete/prune）；
                      啟動時 preload_prune 清過期（main.ts 呼叫）
src/browse.ts         書源瀏覽器 overlay：分類→書籍列表→詳情（目錄＋收藏）→閱讀；
                      全站搜尋、我的最愛（點擊從續讀章節接續）；底部工具列自動隱藏
src/util.ts           isAndroid 偵測、pickFolderAndroid（路徑輸入＋原生 SAF 瀏覽）；
                      setupAutoHideBar（全 App 共用：底部列下滑收起、底部邊緣上滑/點拉把叫出）
src/main.ts           GITHUB_REPO 常數（Android 更新檢查用，發佈前要改）、
                      更新檢查分流（Android 查 Releases API → openUrl 下載 APK）、觸控滑動翻頁；
                      所有頂部列改置螢幕底部、自動隱藏（chrome-hidden）：首頁刊頭＋分頁＋工具列
                      用 flex order 排到底部並收合；漫畫閱讀列固定底部、翻頁時收起；
                      三色模式（body[data-theme] = washi/green/dark，存 localStorage）：
                      右下角毛玻璃懸浮鈕循環切換（CSS 變數重定義整個調色盤）
src/novel.ts          TTS 雙後端：桌面 speechSynthesis / Android 原生（done 事件推進段落；
                      暫停→繼續 = 重唸目前段落）；
                      網路小說模式（書架、上一/下一章、唸完整章自動接下一章）；
                      閱讀列一律置底自動隱藏（chrome-hidden 切換）：
                      非書源用 paper-bar（含語速·字體·朗讀）；書源模式（sourceMode，黃金屋）
                      改用精簡列 返回書庫/上一章/目錄/下一章/朗讀切換鈕/設定，隱藏 paper-bar；
                      目錄點 hjwzw_book_detail 升起面板（高亮目前章節，連不上退離線快取目錄）；
                      設定鈕升起面板放語速滑桿＋字體 A−/A＋（與 paper-bar 控制項同步）；
                      離線預載：設定面板「往後 50/100/自訂章」逐章抓內文存本地（循序＋延遲、可取消），
                      閱讀時命中快取即離線讀；小說分頁「離線預載」開管理對話框（列各書/大小/日期、
                      刪除、全部清除、全域保留天數）
src/sources.ts        Android 用系統瀏覽器開啟（單視窗限制，無廣告阻擋）
capabilities/         default.json（含 androidbridge:default）+ desktop.json（updater/process 桌面限定）
.github/workflows/release-android.yml   推 v* tag 建置簽章 APK 上傳 Release
```

## 重要決策與踩坑

1. **minSdkVersion = 26**（tauri.conf.json bundle.android）：unrar 的 C++ 用到 `lutimes`，
   bionic 要 API 26 才有；24 會編譯失敗（`use of undeclared identifier 'lutimes'`）。
   改 minSdk 後要刪掉 `src-tauri/gen` 重跑 `npx tauri android init`。
2. **外掛權限識別字保留 camelCase**：build.rs COMMANDS 寫 `stopSpeak` → 產生 `allow-stopSpeak`
   （不是 kebab-case），default.toml 要對應。
3. **Android WebView 不支援 speechSynthesis** → 必須走原生 TextToSpeech 外掛。
4. **process/updater 外掛不支援 Android**：Cargo target-gate + capabilities 拆 desktop.json
   （含 `platforms` 欄位），否則 Android 編譯時 ACL 解析失敗。
5. **建置環境**：Gradle 需 JDK 17（用 Android Studio 內建 jbr），
   `ANDROID_HOME` / `NDK_HOME` 需自行設定（見 README）。
6. **gen/android 入庫**（CI 簽章需要）；keystore 相關檔已在 .gitignore 排除。

## 發佈前待辦

- [x] src/main.ts 的 `GITHUB_REPO` = stevedaydream/zip_reader_android（tauri.conf.json updater endpoint 同步）
- [ ] 產生 keystore + GitHub Secrets：ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS
- [ ] gen/android/app/build.gradle.kts 加 signingConfig（見 README）

## 狀態（2026-07-01）

- 朗讀遙控：通知列「暫停/繼續」「停止」按鈕 ＋ 桌面遙控 widget（僅朗讀中可用）已實作，
  前端 tsc/vite build 通過；待手機實裝驗證（通知按鈕、鎖屏可停、widget 加到桌面能停）。

## 狀態（2026-06-14）

- 前端 build 通過、cargo test 4/4 通過（含 webnovel 解析測試）
- ✅ Android debug APK 建置成功：
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
  （debug 含符號約 143MB，release 會小很多）
- ✅ 已實裝驗證：啟動無閃退、16KB 對齊、原生資料夾選擇器、TTS
- 🔲 網路小說功能已完成並建出 APK，待手機重新連線後實裝驗證
- 環境注意：系統 ANDROID_SDK_ROOT 使用者環境變數曾指錯位置（jbr），建置時需覆寫
