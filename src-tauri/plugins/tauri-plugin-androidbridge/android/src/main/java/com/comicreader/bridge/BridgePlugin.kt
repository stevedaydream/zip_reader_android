package com.comicreader.bridge

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SpeakArgs {
    var text: String = ""
    var rate: Float = 1.0f
}

@TauriPlugin
class BridgePlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /** 朗讀進行中旗標，供 MainActivity 在螢幕關閉時保持 WebView/JS 存活 */
        @Volatile
        var isTtsActive: Boolean = false
    }

    private var tts: TextToSpeech? = null
    private var ready = false
    private var seq = 0
    private var wakeLock: PowerManager.WakeLock? = null

    /**
     * 開始朗讀會話：啟動前景服務（豁免 Doze 背景網路，換章不中斷）＋ wake lock。
     * 只在會話首次呼叫時啟動服務——必由使用者點「朗讀」時觸發（前景），
     * 避免螢幕關閉時於背景啟動前景服務遭系統拒絕。
     */
    private fun beginSession() {
        if (isTtsActive) return
        isTtsActive = true
        val intent = Intent(activity, TtsService::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
        if (wakeLock == null) {
            val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "comicreader:tts")
            wakeLock?.setReferenceCounted(false)
        }
        if (wakeLock?.isHeld != true) {
            wakeLock?.acquire(2 * 60 * 60 * 1000L) // 最長 2 小時保險，避免洩漏
        }
    }

    /** 結束朗讀會話：停止前景服務 ＋ 釋放 wake lock */
    private fun endSession() {
        isTtsActive = false
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
        activity.stopService(Intent(activity, TtsService::class.java))
    }

    override fun load(webView: WebView) {
        super.load(webView)
        tts = TextToSpeech(activity) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}

                    override fun onDone(utteranceId: String?) {
                        trigger("done", JSObject())
                    }

                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        trigger("error", JSObject())
                    }

                    override fun onError(utteranceId: String?, errorCode: Int) {
                        trigger("error", JSObject())
                    }
                })
            }
        }
    }

    /** 以指定語速朗讀一段文字；唸完觸發 "done" 事件 */
    @Command
    fun speak(invoke: Invoke) {
        val args = invoke.parseArgs(SpeakArgs::class.java)
        val engine = tts
        if (engine == null || !ready) {
            invoke.reject("語音引擎尚未就緒")
            return
        }
        beginSession()
        engine.setSpeechRate(args.rate.coerceIn(0.5f, 2.0f))
        engine.speak(args.text, TextToSpeech.QUEUE_FLUSH, null, "utt-${seq++}")
        invoke.resolve()
    }

    /** 僅中止目前朗讀（換段/換章/暫停用），不結束會話、不釋放前景服務 */
    @Command
    fun stopSpeak(invoke: Invoke) {
        tts?.stop()
        invoke.resolve()
    }

    /** 結束朗讀會話（使用者停止或全書讀完）：釋放前景服務與 wake lock */
    @Command
    fun endTts(invoke: Invoke) {
        tts?.stop()
        endSession()
        invoke.resolve()
    }

    /** Android 11+ 是否已授予「所有檔案存取」 */
    @Command
    fun hasAllFilesAccess(invoke: Invoke) {
        val granted = if (Build.VERSION.SDK_INT >= 30) {
            Environment.isExternalStorageManager()
        } else {
            true
        }
        val ret = JSObject()
        ret.put("granted", granted)
        invoke.resolve(ret)
    }

    /** 以系統資料夾選擇器（SAF）挑選資料夾，回傳實際檔案路徑 */
    @Command
    fun pickFolder(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        startActivityForResult(invoke, intent, "folderPicked")
    }

    @ActivityCallback
    fun folderPicked(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        if (result.resultCode == Activity.RESULT_OK) {
            val uri = result.data?.data
            val path = uri?.let { treeUriToPath(it) }
            if (path != null) {
                ret.put("path", path)
            }
        }
        invoke.resolve(ret) // 取消或無法轉換時 path 為空
    }

    /**
     * 把 SAF tree URI 轉成實際路徑。
     * primary:Comics → /storage/emulated/0/Comics
     * 1234-5678:Manga（SD 卡）→ /storage/1234-5678/Manga
     * 本 app 持有「所有檔案存取權」，直接以路徑讀取即可。
     */
    private fun treeUriToPath(uri: Uri): String? {
        return try {
            val docId = DocumentsContract.getTreeDocumentId(uri)
            val parts = docId.split(":", limit = 2)
            val type = parts[0]
            val rel = if (parts.size > 1) parts[1] else ""
            if (type.equals("primary", ignoreCase = true)) {
                "/storage/emulated/0/$rel".trimEnd('/')
            } else {
                "/storage/$type/$rel".trimEnd('/')
            }
        } catch (_: Exception) {
            null
        }
    }

    /** 開啟系統設定頁讓使用者授予「所有檔案存取」 */
    @Command
    fun requestAllFilesAccess(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + activity.packageName)
                )
                activity.startActivity(intent)
            } catch (_: Exception) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
        }
        invoke.resolve()
    }
}
