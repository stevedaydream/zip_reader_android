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
                      hasAllFilesAccess / requestAllFilesAccess（MANAGE_EXTERNAL_STORAGE）
  android/src/main/AndroidManifest.xml
                      宣告儲存權限（經 manifest merge 併入 app，免手動改 gen）
src/util.ts           isAndroid 偵測、pickFolderAndroid（路徑輸入對話框）
src/main.ts           GITHUB_REPO 常數（Android 更新檢查用，發佈前要改）、
                      更新檢查分流（Android 查 Releases API → openUrl 下載 APK）、觸控滑動翻頁
src/novel.ts          TTS 雙後端：桌面 speechSynthesis / Android 原生（done 事件推進段落；
                      暫停→繼續 = 重唸目前段落）
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

- [ ] src/main.ts 的 `GITHUB_REPO` 改成實際 owner/repo
- [ ] 產生 keystore + GitHub Secrets：ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS
- [ ] gen/android/app/build.gradle.kts 加 signingConfig（見 README）

## 狀態（2026-06-13）

- 前端 build 通過、桌面 cargo check 通過
- ✅ Android debug APK 建置成功：
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
  （debug 含符號約 143MB，release 會小很多）
- 環境注意：系統 ANDROID_SDK_ROOT 使用者環境變數曾指錯位置（jbr），建置時需覆寫
