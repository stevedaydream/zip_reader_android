# 改進計畫

## 1. 朗讀時要求通知權限（POST_NOTIFICATIONS）

**現況**：manifest 已宣告 `POST_NOTIFICATIONS`，但 app 從未在執行時要求權限。
Android 13+（targetSdk 36）預設拒絕 → 前景服務雖可運作，但「正在朗讀」通知與
通知列的「暫停/繼續」「停止」按鈕不顯示（實機 S25+ / Android 16 確認 `granted=false`）。

**目標**：使用者第一次按「朗讀」時，跳出系統通知權限詢問；拒絕也不影響朗讀。

**做法**：
1. BridgePlugin.kt 新增兩個 Command：
   - `hasNotificationPermission`：SDK < 33 回 true；否則 `checkSelfPermission(POST_NOTIFICATIONS)`。
   - `requestNotificationPermission`：用 Tauri 外掛的權限機制
     （`@TauriPlugin(permissions = [Permission(strings = [POST_NOTIFICATIONS], alias = "notifications")])`
     ＋ `requestPermissionForAlias`），回傳是否授予。
2. build.rs COMMANDS 加入兩個指令（camelCase），重新產生權限檔，
   `permissions/default.toml` 加 `allow-hasNotificationPermission`、`allow-requestNotificationPermission`。
3. novel.ts：開始朗讀（`speakFrom` 從非朗讀狀態啟動時）若 Android 且未授權、
   且本機未記錄「已詢問過」（localStorage `notifAsked`），先 await 要求權限再朗讀；
   只問一次，被拒後不再打擾。
4. 權限要在前景且朗讀開始**之前**要求：系統對話框會讓 Activity 進入 onPause，
   須確認不影響 beginSession 啟動前景服務的時機（先要權限、再 speak）。

**驗證**：
- 實機清除權限（`adb shell pm revoke com.comicreader.mobile android.permission.POST_NOTIFICATIONS`
  ＋ 清 localStorage 旗標或重裝）→ 按朗讀出現詢問 → 允許後通知列顯示章節標題與按鈕，按鈕可暫停/停止。
- 拒絕後朗讀照常、下次不再詢問。
- 關螢幕朗讀不中斷（回歸 project_bugfix.md -6）。
