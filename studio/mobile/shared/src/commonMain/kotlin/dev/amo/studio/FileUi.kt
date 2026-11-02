package dev.amo.studio

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

// Web content gets no network, file access, credentials or native bridge. Local scripts
// may drive the report's controls. CSP also prevents fetch, frames, forms and workers.
// Local links
// return to rt.file so the owning Host applies its task authorization checks again.
@Composable internal fun FileViewer(file: ViewedFile, open: (String) -> Unit) {
    when {
        file.kind == "html" || file.mime.contains("html") || file.mime == "image/svg+xml" -> HtmlView(file, open, Modifier.fillMaxSize())
        file.kind == "image" || file.mime.startsWith("image/") -> {
            val bitmap = remember(file.path, file.bytes.contentHashCode()) { decodeImage(file.bytes) }
            if (bitmap != null) Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { Image(bitmap, contentDescription = file.name, modifier = Modifier.fillMaxWidth().padding(12.dp)) } else Empty("无法显示此图片格式")
        }
        else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            if (file.kind == "markdown" || file.name.endsWith(".md", true)) MarkdownText(file.bytes.decodeToString()) { target -> localFileTarget(target, file.path)?.let(open) }
            else SelectionContainer { Text(file.bytes.decodeToString(), fontFamily = LocalAmoCodeFont.current) }
        }
    }
}

/**
 * HTML (and SVG) in the platform's web view, under isolatedHtml's policy, with no network, files or native bridge;
 * a click on a local link goes to `open` (localFileTarget), so the Host checks it again. Tagged "file-html-ready"
 * once the page is drawn (UiFlowTest waits for it).
 */
@Composable internal expect fun HtmlView(file: ViewedFile, open: (String) -> Unit, modifier: Modifier)

/** An image file as a bitmap, scaled down when it is huge; null when the format cannot be read. */
internal expect fun decodeImage(bytes: ByteArray): ImageBitmap?

// Public, not internal (2026-11-02): the app module's FilePolicyTest checks it from another module now.
fun isolatedHtml(source: String): String {
    val policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'\">"
    // The guard must precede all source nodes, including malformed pre-head scripts.
    // Keep a standards-mode doctype before it so existing report CSS stays faithful.
    return "<!doctype html>" + policy + source.replaceFirst(Regex("(?is)^\\s*<!doctype[^>]*>"), "")
}

fun localFileTarget(target: String, base: String = ""): String? {
    val clean = percentDecode(target.substringBefore('#').substringBefore('?'))
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

/** As Android's Uri.decode: %XX as UTF-8 (bad bytes become U+FFFD), '+' stays, a broken escape becomes U+FFFD. */
internal fun percentDecode(text: String): String {
    if ('%' !in text) return text
    val out = StringBuilder()
    val bytes = okio.Buffer()
    fun flush() { if (bytes.size > 0) out.append(bytes.readUtf8()) }
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c != '%') { flush(); out.append(c); i++; continue }
        var value = 0
        for (j in 1..2) {
            if (i + j >= text.length) { flush(); out.append('�'); return out.toString() }
            val digit = text[i + j].digitToIntOrNull(16)
            if (digit == null) { flush(); out.append('�'); i += j + 1; value = -1; break }
            value = value * 16 + digit
        }
        if (value >= 0) { bytes.writeByte(value); i += 3 }
    }
    flush()
    return out.toString()
}
