package com.balaji.reader

import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Rational
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import java.io.File
import java.util.Locale

class MainActivity : TauriActivity() {
  @Volatile private var volumePaging = true
  @Volatile private var pipEnabled = false
  @Volatile private var pendingFile: String? = null
  private var webView: WebView? = null

  // Android WebView lacks the Web Speech API, so TTS uses the native engine.
  private var tts: TextToSpeech? = null
  @Volatile private var ttsReady = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    volumePaging = getSharedPreferences("reader", Context.MODE_PRIVATE)
      .getBoolean("volumePaging", true)
    initTts()
    handleIntent(intent)
  }

  private fun initTts() {
    tts = TextToSpeech(this) { status ->
      if (status == TextToSpeech.SUCCESS) {
        tts?.language = Locale.getDefault()
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          override fun onStart(id: String?) {}
          override fun onDone(id: String?) = dispatchTts("tts-end", "")
          @Deprecated("deprecated") override fun onError(id: String?) = dispatchTts("tts-end", "")
          // word boundary (API 26+) → highlight the spoken word
          override fun onRangeStart(id: String?, start: Int, end: Int, frame: Int) =
            dispatchTts("tts-boundary", start.toString())
        })
        ttsReady = true
      }
    }
  }

  private fun dispatchTts(name: String, detail: String) {
    val wv = webView ?: return
    wv.post {
      wv.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('$name',{detail:${JSONObject.quote(detail)}}))",
        null,
      )
    }
  }

  override fun onDestroy() {
    tts?.shutdown()
    tts = null
    super.onDestroy()
  }

  // Called when the WebView is created — register the JS bridge BEFORE the page
  // loads so window.ReaderNative is reliably available (fixes the toggle never
  // reaching native, which left volume keys dead when paging was off).
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "ReaderNative")
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIntent(intent)
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (pipEnabled) enterPipMode()
  }

  inner class Bridge {
    @JavascriptInterface
    fun setVolumePaging(enabled: Boolean) {
      volumePaging = enabled
      getSharedPreferences("reader", Context.MODE_PRIVATE)
        .edit().putBoolean("volumePaging", enabled).apply()
    }

    // Picture-in-Picture: float the reader over other apps (YouTube-style).
    @JavascriptInterface
    fun enterPip() {
      runOnUiThread { enterPipMode() }
    }

    @JavascriptInterface
    fun setPipEnabled(enabled: Boolean) {
      pipEnabled = enabled
    }

    // File association: hand the cold-start opened file to the web layer.
    @JavascriptInterface
    fun getPendingFile(): String? {
      val f = pendingFile
      pendingFile = null
      return f
    }

    // --- Text to speech (native Android engine) ---
    @JavascriptInterface
    fun ttsAvailable(): Boolean = ttsReady

    @JavascriptInterface
    fun ttsSpeak(text: String, rate: Float) {
      val t = tts ?: return
      t.setSpeechRate(rate)
      t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "u")
    }

    @JavascriptInterface
    fun ttsStop() {
      tts?.stop()
    }
  }

  private fun enterPipMode() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val params = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(2, 3))
        .build()
      enterPictureInPictureMode(params)
    }
  }

  // Copy the incoming "Open with" file into cache and notify the web layer.
  private fun handleIntent(intent: Intent?) {
    val uri = intent?.data ?: return
    if (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_SEND) return
    try {
      val name = queryName(uri) ?: "book"
      val cacheFile = File(cacheDir, name)
      contentResolver.openInputStream(uri)?.use { input ->
        cacheFile.outputStream().use { output -> input.copyTo(output) }
      }
      val path = cacheFile.absolutePath
      pendingFile = path
      // also push it to the running page (listener attached on boot)
      val wv = webView ?: findWebView(window.decorView)
      wv?.postDelayed({
        wv.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('open-file-android',{detail:${JSONObject.quote(path)}}))",
          null,
        )
      }, 1200)
    } catch (e: Exception) {
      e.printStackTrace()
    }
  }

  private fun queryName(uri: Uri): String? {
    if (uri.scheme == "file") return uri.lastPathSegment
    return contentResolver.query(uri, null, null, null, null)?.use { cursor ->
      val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      if (idx >= 0 && cursor.moveToFirst()) cursor.getString(idx) else null
    }
  }

  private fun findWebView(view: View?): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findWebView(view.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (volumePaging) {
      val dir = when (keyCode) {
        KeyEvent.KEYCODE_VOLUME_DOWN -> "next"
        KeyEvent.KEYCODE_VOLUME_UP -> "prev"
        else -> null
      }
      if (dir != null) {
        val wv = webView ?: findWebView(window.decorView)
        wv?.post {
          wv.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('reader-volume',{detail:'$dir'}))",
            null,
          )
        }
        return true // consume → no system volume change while paging is on
      }
    }
    return super.onKeyDown(keyCode, event)
  }
}
