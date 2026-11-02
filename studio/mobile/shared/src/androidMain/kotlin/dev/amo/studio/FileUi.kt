package dev.amo.studio

import android.graphics.BitmapFactory
import android.net.Uri
import android.os.SystemClock
import android.util.Base64
import android.webkit.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream

// Web content gets no network, file access, credentials or native bridge. Local scripts
// may drive the report's controls. CSP also prevents fetch, frames, forms and workers.
// Local links
// return to rt.file so the owning Host applies its task authorization checks again.
@Composable internal fun FileViewer(file: ViewedFile, open: (String) -> Unit) {
    var htmlReady by remember { mutableStateOf(false) }
    val currentFile by rememberUpdatedState(file)
    val currentOpen by rememberUpdatedState(open)
    when {
        file.kind == "html" || file.mime.contains("html") || file.mime == "image/svg+xml" -> AndroidView(factory = { context ->
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
        }, update = { view -> if (view.tag != file.path + file.bytes.contentHashCode()) { htmlReady = false; view.tag = file.path + file.bytes.contentHashCode(); val content = if (file.mime == "image/svg+xml") "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{margin:0}img{max-width:100%;height:auto}</style><img alt=\"SVG 图片\" src=\"data:image/svg+xml;base64,${Base64.encodeToString(file.bytes, Base64.NO_WRAP)}\">" else file.bytes.toString(Charsets.UTF_8); view.loadDataWithBaseURL("https://amo.invalid/", isolatedHtml(content), "text/html", "UTF-8", null) } }, onRelease = { it.stopLoading(); it.destroy() }, modifier = Modifier.fillMaxSize().testTag(if (htmlReady) "file-html-ready" else "file-html-loading"))
        file.kind == "image" || file.mime.startsWith("image/") -> {
            val bitmap = remember(file.path, file.bytes.contentHashCode()) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) null else {
                    var sample = 1
                    while (bounds.outWidth / sample > 4096 || bounds.outHeight / sample > 4096 || (bounds.outWidth.toLong() / sample) * (bounds.outHeight / sample) > 8_388_608L) sample *= 2
                    BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                }
            }
            if (bitmap != null) Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { Image(bitmap.asImageBitmap(), contentDescription = file.name, modifier = Modifier.fillMaxWidth().padding(12.dp)) } else Empty("无法显示此图片格式")
        }
        else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            if (file.kind == "markdown" || file.name.endsWith(".md", true)) MarkdownText(file.bytes.toString(Charsets.UTF_8)) { target -> localFileTarget(target, file.path)?.let(open) }
            else SelectionContainer { Text(file.bytes.toString(Charsets.UTF_8), fontFamily = LocalAmoCodeFont.current) }
        }
    }
}

// Public, not internal (2026-11-02): the app module's FilePolicyTest checks it from another module now.
fun isolatedHtml(source: String): String {
    val policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'\">"
    // The guard must precede all source nodes, including malformed pre-head scripts.
    // Keep a standards-mode doctype before it so existing report CSS stays faithful.
    return "<!doctype html>" + policy + source.replaceFirst(Regex("(?is)^\\s*<!doctype[^>]*>"), "")
}

fun localFileTarget(target: String, base: String = ""): String? {
    val clean = Uri.decode(target.substringBefore('#').substringBefore('?'))
    if (clean.isBlank()) return null
    if (clean.startsWith("https://amo.invalid/")) return clean.removePrefix("https://amo.invalid/").takeIf { it.isNotBlank() }?.let { resolveLocal(base, it) }
    if (clean.startsWith("file://")) return clean.removePrefix("file://").removePrefix("/").let { if (it.length > 1 && it[1] == ':') it else "/$it" }
    if (Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(clean) || clean.startsWith('/')) return clean
    if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(clean)) return null
    return resolveLocal(base, clean)
}
private fun resolveLocal(base: String, target: String): String {
    if (base.isBlank()) return target
    val normalized = base.replace('\\', '/')
    val directory = normalized.substringBeforeLast('/', "")
    return if (directory.isBlank()) target else "$directory/$target"
}
