# 漫畫壓縮檔閱讀器 Android 版（Comic Reader Mobile）

以 Tauri 2 開發的 Android 漫畫／小說閱讀器（與桌面版 `zip_reader` 同功能）。
同一份程式碼也能在桌面執行（`npm run tauri dev`），方便開發測試。

## 功能

- **漫畫**
  - 多格式：ZIP / CBZ / 7Z / CB7 / RAR / CBR
  - 密碼清單記憶：自動依序嘗試已存密碼，新密碼可記住、可管理
  - 觸控翻頁（點左右側、左右滑動）/ 自動翻頁（0.5 秒起可自訂）
  - 適應高度／寬度顯示模式
- **小說**
  - TXT（自動偵測 UTF-8 / Big5 / GBK）、EPUB、MOBI、AZW、AZW3
  - **網路小說**（Legado 式純淨閱讀）：貼上章節網址即自動解析純內文（去廣告去導覽），
    自動偵測「上一章/下一章」連續閱讀；書架記住每本書最後閱讀章節；
    通用解析器（常見內文容器＋文字密度備援），編碼自動偵測（GBK/Big5 站可讀）
  - **黃金屋書源**（tw.hjwzw.com）：小說分頁點「瀏覽黃金屋」進入書源瀏覽器
    — 分類瀏覽（玄幻/武俠/仙俠…）、全站搜尋、書籍詳情＋完整目錄；
    「我的最愛」記錄書名/作者/續讀章節，下次一鍵從中斷處接續閱讀
  - 護眼紙頁排版、字級可調
  - **原生 TextToSpeech 朗讀**（本地語音、不需網路）：點任一段落開始、逐段高亮自動捲動、
    語速 0.5–2（0.1 刻度，預設 1）；語音請於系統「文字轉語音」設定中選擇
- **線上資源**：自訂連結清單，以系統瀏覽器開啟（Android 單視窗限制，無內建廣告阻擋）
- **更新檢查**：查 GitHub Releases，有新版引導下載 APK

## 與桌面版的差異

| 項目 | 桌面版 | Android 版 |
|------|--------|-----------|
| 資料夾選擇 | 系統選擇器 | 路徑輸入＋常用位置快選，需授予「所有檔案存取權」 |
| TTS | Web Speech API（可選語音） | 原生 TextToSpeech（語音由系統設定）；「暫停→繼續」會從目前段落重唸 |
| 線上資源 | 獨立視窗＋廣告阻擋 | 系統瀏覽器開啟 |
| 自動更新 | updater 外掛全自動 | 檢查 GitHub Releases 後引導下載 APK 安裝 |
| 全螢幕 | F11／按鈕 | 不適用（自動隱藏） |

## 建置需求

- Node.js 22+、Rust（stable）+ Android targets：
  `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Android Studio（SDK + NDK 27+）
- 環境變數（PowerShell 範例）：
  ```powershell
  $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
  $env:NDK_HOME = "$env:LOCALAPPDATA\Android\Sdk\ndk\<版本>"
  $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"   # 需 JDK 17，用 Android Studio 內建即可
  ```

## 建置指令

```powershell
npm install
npx tauri android init                                  # 首次：產生 gen/android 工程
npx tauri android dev                                   # 連接裝置/模擬器即時開發
npx tauri android build --apk --target aarch64 --debug  # debug APK（可直接安裝測試）
npx tauri android build --apk                           # release APK（需簽章，見下）
```

APK 輸出於 `src-tauri/gen/android/app/build/outputs/apk/`。

## Release 簽章（發佈前必做）

1. 產生 keystore：
   ```powershell
   keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```
2. 建立 `src-tauri/gen/android/keystore.properties`：
   ```properties
   password=<keystore 密碼>
   keyAlias=upload
   storeFile=<upload-keystore.jks 絕對路徑>
   ```
3. 參考 Tauri 文件在 `gen/android/app/build.gradle.kts` 加入 signingConfig
   （https://tauri.app/distribute/sign/android/）。
4. ⚠️ keystore 與 keystore.properties 切勿提交到儲存庫。

## 更新檢查設定

編輯 [src/main.ts](src/main.ts) 開頭的 `GITHUB_REPO`，改成你發佈 APK 的 `owner/repo`。
推 `v*` tag 後，[.github/workflows/release-android.yml](.github/workflows/release-android.yml)
會自動建置並上傳 APK 到 GitHub Release，app 啟動時即可偵測新版本。

## 首次使用

1. 安裝 APK 後開啟，點「選擇資料夾」
2. 點「授權存取」→ 在系統設定中允許「所有檔案存取」
3. 回到 app，選擇常用位置（如 Download）或輸入自訂路徑 → 確定

## 資料儲存位置

密碼清單與來源清單存於 app 私有目錄（`/data/data/com.comicreader.mobile/`），解除安裝即清除。
