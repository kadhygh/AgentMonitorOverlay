package dev.amo.studio

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.viewinterop.UIKitView
import kotlinx.cinterop.ExperimentalForeignApi
import org.jetbrains.skia.Image
import org.jetbrains.skia.Rect
import org.jetbrains.skia.Surface
import platform.CoreGraphics.CGRectMake
import platform.Foundation.NSURL
import platform.WebKit.*
import platform.darwin.NSObject
import kotlin.io.encoding.Base64

// The same rules as Android's WebView (FileViews.android.kt), in WKWebView (2026-11-02, plans/ios.md 第 2d 步): no
// stored data (a non-persistent store), no new windows; isolatedHtml's CSP stops every load but inline script,
// style and data: images; every navigation but the page itself and its #fragments is cancelled, and a local link
// goes back through localFileTarget to the Host. Unverified: WKWebView has no blockNetworkLoads, the CSP is the guard.
@OptIn(ExperimentalForeignApi::class)
@Composable internal actual fun HtmlView(file: ViewedFile, open: (String) -> Unit, modifier: Modifier) {
    val currentFile by rememberUpdatedState(file)
    val currentOpen by rememberUpdatedState(open)
    // The web view holds its navigation delegate weakly: this keeps it.
    val navigation = remember { HtmlNavigation { target -> localFileTarget(target, currentFile.path)?.let(currentOpen) } }
    val key = file.path + file.bytes.contentHashCode()
    UIKitView(
        factory = {
            val config = WKWebViewConfiguration().apply {
                websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore()
                preferences.javaScriptCanOpenWindowsAutomatically = false
            }
            WKWebView(frame = CGRectMake(0.0, 0.0, 0.0, 0.0), configuration = config).apply { navigationDelegate = navigation }
        },
        update = { view ->
            if (navigation.loaded != key) {
                navigation.loaded = key
                val content = if (file.mime == "image/svg+xml") "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{margin:0}img{max-width:100%;height:auto}</style><img alt=\"SVG 图片\" src=\"data:image/svg+xml;base64,${Base64.encode(file.bytes)}\">" else file.bytes.decodeToString()
                view.loadHTMLString(withViewport(isolatedHtml(content)), baseURL = NSURL(string = "https://amo.invalid/"))
            }
        },
        onRelease = { it.stopLoading(); it.navigationDelegate = null },
        modifier = modifier,
    )
}

// Android's WebView lays a page without a viewport tag out at the phone's width; WKWebView at 980 px, too small to read.
// Put right after isolatedHtml's doctype, so the report keeps standards mode.
private fun withViewport(html: String) = if (Regex("(?i)<meta[^>]+name\\s*=\\s*[\"']?viewport").containsMatchIn(html)) html else html.replaceFirst("<!doctype html>", "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")

private class HtmlNavigation(private val link: (String) -> Unit) : NSObject(), WKNavigationDelegateProtocol {
    var loaded: String? = null
    override fun webView(webView: WKWebView, decidePolicyForNavigationAction: WKNavigationAction, decisionHandler: (WKNavigationActionPolicy) -> Unit) {
        val url = decidePolicyForNavigationAction.request.URL
        val samePage = url?.host == "amo.invalid" && (url.path.isNullOrEmpty() || url.path == "/")
        // The page itself (loadHTMLString with the base URL) and its own #fragments; anything else is a link.
        if (samePage && (url.fragment != null || decidePolicyForNavigationAction.navigationType == WKNavigationTypeOther)) {
            decisionHandler(WKNavigationActionPolicy.WKNavigationActionPolicyAllow); return
        }
        url?.absoluteString?.let(link)
        decisionHandler(WKNavigationActionPolicy.WKNavigationActionPolicyCancel)
    }
}

// As Android's BitmapFactory sampling: at most 4096 px a side and 8,388,608 px in all, so a huge image does not take
// the app's memory.
internal actual fun decodeImage(bytes: ByteArray): ImageBitmap? = runCatching {
    val image = Image.makeFromEncoded(bytes)
    var sample = 1
    while (image.width / sample > 4096 || image.height / sample > 4096 || (image.width.toLong() / sample) * (image.height / sample) > 8_388_608L) sample *= 2
    if (sample == 1) image.toComposeImageBitmap()
    else {
        val surface = Surface.makeRasterN32Premul(image.width / sample, image.height / sample)
        surface.canvas.drawImageRect(image, Rect.makeWH((image.width / sample).toFloat(), (image.height / sample).toFloat()))
        surface.makeImageSnapshot().toComposeImageBitmap()
    }
}.getOrNull()
