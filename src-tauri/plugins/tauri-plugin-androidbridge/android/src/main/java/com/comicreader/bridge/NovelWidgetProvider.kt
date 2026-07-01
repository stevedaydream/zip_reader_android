package com.comicreader.bridge

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.RemoteViews

/**
 * 桌面遙控 widget：與通知列同一批控制（暫停/繼續、停止），共用 BridgePlugin.emitRemote 橋。
 * 只在朗讀會話進行中可用；未在朗讀時按鈕轉灰、點擊被 emitRemote 忽略，不會誤啟服務。
 */
class NovelWidgetProvider : AppWidgetProvider() {
    companion object {
        const val ACTION_TOGGLE = "com.comicreader.bridge.widget.TOGGLE"
        const val ACTION_STOP = "com.comicreader.bridge.widget.STOP"

        /** 依朗讀狀態重繪所有 widget 實例 */
        fun render(context: Context, playing: Boolean, active: Boolean, title: String) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(
                ComponentName(context, NovelWidgetProvider::class.java)
            )
            if (ids == null || ids.isEmpty()) return
            mgr.updateAppWidget(ids, buildViews(context, playing, active, title))
        }

        private fun buildViews(
            context: Context,
            playing: Boolean,
            active: Boolean,
            title: String
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.novel_widget)
            views.setTextViewText(
                R.id.widget_status,
                if (!active) "未在朗讀" else if (playing) "朗讀中" else "已暫停"
            )
            // 章節標題：朗讀中且有標題才顯示
            if (active && title.isNotBlank()) {
                views.setViewVisibility(R.id.widget_title, android.view.View.VISIBLE)
                views.setTextViewText(R.id.widget_title, title)
            } else {
                views.setViewVisibility(R.id.widget_title, android.view.View.GONE)
            }
            views.setTextViewText(R.id.widget_toggle, if (playing) "暫停" else "繼續")
            views.setBoolean(R.id.widget_toggle, "setEnabled", active)
            views.setBoolean(R.id.widget_stop, "setEnabled", active)
            views.setOnClickPendingIntent(
                R.id.widget_toggle, pendingIntent(context, ACTION_TOGGLE, 11)
            )
            views.setOnClickPendingIntent(
                R.id.widget_stop, pendingIntent(context, ACTION_STOP, 12)
            )
            return views
        }

        private fun pendingIntent(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, NovelWidgetProvider::class.java).setAction(action)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getBroadcast(context, requestCode, intent, flags)
        }
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        appWidgetManager.updateAppWidget(
            appWidgetIds,
            buildViews(
                context,
                BridgePlugin.isPlaying,
                BridgePlugin.isTtsActive,
                BridgePlugin.currentTitle
            )
        )
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            ACTION_TOGGLE -> BridgePlugin.emitRemote("toggle")
            ACTION_STOP -> BridgePlugin.emitRemote("stop")
        }
    }
}
