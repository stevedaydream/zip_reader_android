package com.comicreader.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * 朗讀期間的前景服務。持有前景服務狀態可讓 app 豁免 Doze 的背景網路限制，
 * 使螢幕關閉時仍能抓取下一章（換章不中斷）。
 *
 * 通知列同時提供「暫停/繼續」「停止」兩顆按鈕：離開 app 或鎖屏時也能直接
 * 控制朗讀。按鈕點擊經 onStartCommand 轉成 BridgePlugin 事件回 JS，跑既有邏輯。
 */
class TtsService : Service() {
    companion object {
        private const val CHANNEL_ID = "tts_playback"
        private const val NOTIF_ID = 1
        const val ACTION_TOGGLE = "com.comicreader.bridge.action.TOGGLE"
        const val ACTION_STOP = "com.comicreader.bridge.action.STOP"
        const val ACTION_UPDATE = "com.comicreader.bridge.action.UPDATE"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_TITLE = "title"
    }

    /** 是否正在朗讀（false = 已暫停），決定通知的圖示與按鈕文字 */
    private var playing = true

    /** 目前朗讀章節標題（空字串則顯示 app 名） */
    private var title = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE -> BridgePlugin.emitRemote("toggle")
            ACTION_STOP -> BridgePlugin.emitRemote("stop")
            ACTION_UPDATE -> {
                playing = intent.getBooleanExtra(EXTRA_PLAYING, true)
                title = intent.getStringExtra(EXTRA_TITLE) ?: ""
            }
            else -> playing = true // 首次啟動（beginSession）
        }
        startForegroundCompat()
        return START_NOT_STICKY
    }

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "朗讀", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotification(): Notification {
        val toggleIcon =
            if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val toggleLabel = if (playing) "暫停" else "繼續"
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(if (title.isBlank()) "漫畫閱讀器" else title)
            .setContentText(if (playing) "正在朗讀…" else "已暫停")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(toggleIcon, toggleLabel, servicePendingIntent(ACTION_TOGGLE, 1))
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "停止",
                servicePendingIntent(ACTION_STOP, 2)
            )
        launchAppPendingIntent()?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, TtsService::class.java).setAction(action)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getService(this, requestCode, intent, flags)
    }

    /** 點通知本體回到 app */
    private fun launchAppPendingIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(this, 0, launch, flags)
    }
}
