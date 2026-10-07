package com.comicreader.mobile

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.comicreader.bridge.BridgePlugin

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // WryActivity 透過此回呼提供 WebView 參考
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
  }

  override fun onPause() {
    super.onPause()
    // 螢幕關閉時 WryActivity 會 pause WebView，導致 JS 停擺、TTS 換段/換章中斷。
    // 朗讀進行中時立即恢復 WebView 與全域計時器，配合 BridgePlugin 的 WakeLock
    // 讓 CPU 不休眠，使「唸完一段→抓下一段/下一章→繼續朗讀」的鏈得以持續。
    if (BridgePlugin.isTtsActive) {
      webView?.onResume()
      webView?.resumeTimers()
    }
  }

  override fun onStop() {
    super.onStop()
    // 螢幕關閉後視窗變為不可見，新版 WebView（153+）會在約 1～2 分鐘後凍結
    // 「隱藏且無聲」的頁面（TTS 聲音由引擎進程播放，頁面被視為無聲），JS 鏈停擺。
    // 朗讀中延遲回報視窗仍可見（等系統的不可見通知先送達），讓頁面不被凍結。
    if (BridgePlugin.isTtsActive) {
      webView?.postDelayed({
        if (BridgePlugin.isTtsActive) {
          webView?.dispatchWindowVisibilityChanged(View.VISIBLE)
          webView?.onResume()
          webView?.resumeTimers()
        }
      }, 500)
    }
  }
}
