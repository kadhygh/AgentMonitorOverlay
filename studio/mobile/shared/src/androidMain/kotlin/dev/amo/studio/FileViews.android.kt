package dev.amo.studio

import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.Base64
import android.webkit.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream

// Web content gets no network, file access, credentials or native bridge. Local scripts
// may drive the report's controls. CSP also prevents fetch, frames, forms and workers.
// Local links
// return to rt.file so the owning Host applies its task authorization checks again.
// (Moved out of FileUi.kt on 2026-11-02 when the viewer became shared with iOS; the code is as it was.)
@Composable internal actual fun HtmlView(file: ViewedFile, open: (String) -> Unit, modifier: Modifier) {
    var htmlReady by remember { mutableStateOf(false) }
    val currentFile by rememberUpdatedState(file)
    val currentOpen by rememberUpdatedState(open)
    AndroidView(factory = { context ->
        WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.blockNetworkLoads = true
            settings.domStorageEnabled = false
            settings.databaseEnabled = false
            settings.setSupportMultipleWindows(false)
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = object : WebViewClient() {
                override fun onPageCommitVisible(view: WebView?, url: String?) {
                    val committed = view ?: return
                    val expected = committed.tag
                    committed.postVisualStateCallback(SystemClock.uptimeMillis(), object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) { if (committed.tag == expected) htmlReady = true }
                    })
                }
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse = WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean { val uri = request?.url; if (uri?.host == "amo.invalid" && uri.path == "/" && uri.fragment != null) return false; uri?.toString()?.let { target -> localFileTarget(target, currentFile.path)?.let(currentOpen) }; return true }
            }
        }
    }, update = { view -> if (view.tag != file.path + file.bytes.contentHashCode()) { htmlReady = false; view.tag = file.path + file.bytes.contentHashCode(); val content = if (file.mime == "image/svg+xml") "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{margin:0}img{max-width:100%;height:auto}</style><img alt=\"SVG 图片\" src=\"data:image/svg+xml;base64,${Base64.encodeToString(file.bytes, Base64.NO_WRAP)}\">" else file.bytes.toString(Charsets.UTF_8); view.loadDataWithBaseURL("https://amo.invalid/", isolatedHtml(content), "text/html", "UTF-8", null) } }, onRelease = { it.stopLoading(); it.destroy() }, modifier = modifier.testTag(if (htmlReady) "file-html-ready" else "file-html-loading"))
}

internal actual fun decodeImage(bytes: ByteArray): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > 4096 || bounds.outHeight / sample > 4096 || (bounds.outWidth.toLong() / sample) * (bounds.outHeight / sample) > 8_388_608L) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}
