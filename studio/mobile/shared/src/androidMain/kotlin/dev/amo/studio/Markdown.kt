package dev.amo.studio

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.util.WeakHashMap

// Markdown for the phone (2026-10-31). The app has no Markdown library offline, and the old renderer went line by
// line (each code line its own strip, no ordered lists, quotes or italics, fixed 160 dp table columns). This is a
// small block parser — fenced code, headings, quotes, nested lists, tables, rules, paragraphs — and an inline one for
// code, bold, italic, strike-through and links. Parses are kept per item (WeakHashMap by JSON identity): an item's
// JSON never changes after it arrives, so a list redrawn while a reply streams parses only the streaming item.

@Immutable sealed interface Md
@Immutable data class MdHeading(val level: Int, val text: String) : Md
@Immutable data class MdParagraph(val text: String) : Md
@Immutable data class MdCode(val language: String, val text: String) : Md
@Immutable data class MdQuote(val blocks: List<Md>) : Md
@Immutable data class MdList(val ordered: Boolean, val start: Int, val items: List<List<Md>>) : Md
@Immutable data class MdTable(val header: List<String>, val align: List<TextAlign>, val rows: List<List<String>>) : Md
@Immutable data object MdRule : Md

private val FENCE = Regex("^ {0,3}(`{3,}|~{3,})\\s*([^`\\s]*).*$")
private val HEADING = Regex("^ {0,3}(#{1,6})(?:\\s+(.*?))?\\s*#*\\s*$")
private val RULE = Regex("^ {0,3}([-*_])(?:\\s*\\1){2,}\\s*$")
private val ITEM = Regex("^(\\s*)([-*+]|\\d{1,9}[.)])(\\s+(.*))?$")
private val QUOTE = Regex("^ {0,3}> ?(.*)$")
private val SEPARATOR = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")

private fun indentOf(line: String): Int { var n = 0; for (ch in line) { if (ch == ' ') n++ else if (ch == '\t') n += 4 else break }; return n }
private fun dedent(line: String, by: Int): String { var i = 0; var n = 0; while (i < line.length && n < by && (line[i] == ' ' || line[i] == '\t')) { n += if (line[i] == '\t') 4 else 1; i++ }; return line.substring(i) }
private fun startsBlock(line: String) = FENCE.matches(line) || HEADING.matches(line) || QUOTE.matches(line) || RULE.matches(line) || ITEM.matches(line)
private fun cells(line: String): List<String> {
    val t = line.trim().removePrefix("|").let { if (it.endsWith("|") && !it.endsWith("\\|")) it.dropLast(1) else it }
    val out = mutableListOf<String>(); val cur = StringBuilder(); var i = 0
    while (i < t.length) { val ch = t[i]; if (ch == '\\' && i + 1 < t.length && t[i + 1] == '|') { cur.append('|'); i += 2; continue }; if (ch == '|') { out += cur.toString().trim(); cur.clear() } else cur.append(ch); i++ }
    out += cur.toString().trim(); return out
}

fun parseMarkdown(source: String): List<Md> = blocks(source.replace("\r\n", "\n").replace('\r', '\n').split('\n'))

private fun blocks(lines: List<String>): List<Md> {
    val out = mutableListOf<Md>(); val paragraph = mutableListOf<String>()
    fun flush() { if (paragraph.isNotEmpty()) { out += MdParagraph(paragraph.joinToString("\n")); paragraph.clear() } }
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        if (line.isBlank()) { flush(); i++; continue }
        val fence = FENCE.matchEntire(line)
        if (fence != null) {
            flush(); val marker = fence.groupValues[1]; val indent = indentOf(line); val body = mutableListOf<String>(); i++
            while (i < lines.size && !(lines[i].trim().length >= marker.length && lines[i].trim().all { it == marker[0] })) { body += dedent(lines[i], indent); i++ }
            out += MdCode(fence.groupValues[2], body.joinToString("\n")); i++; continue
        }
        val heading = HEADING.matchEntire(line)
        if (heading != null) { flush(); out += MdHeading(heading.groupValues[1].length, heading.groupValues[2]); i++; continue }
        if (RULE.matches(line)) { flush(); out += MdRule; i++; continue }
        if (QUOTE.matches(line)) {
            flush(); val inner = mutableListOf<String>()
            while (i < lines.size && lines[i].isNotBlank()) { val q = QUOTE.matchEntire(lines[i]); if (q != null) inner += q.groupValues[1] else if (startsBlock(lines[i])) break else inner += lines[i]; i++ }
            out += MdQuote(blocks(inner)); continue
        }
        val item = ITEM.matchEntire(line)
        if (item != null && (paragraph.isEmpty() || item.groupValues[4].isNotBlank())) {
            flush()
            val base = indentOf(line); val ordered = item.groupValues[2].first().isDigit()
            val start = if (ordered) item.groupValues[2].dropLast(1).toIntOrNull() ?: 1 else 1
            val items = mutableListOf<MutableList<String>>(); var content = 0; var lastBlank = false
            while (i < lines.size) {
                val l = lines[i]
                val m = ITEM.matchEntire(l)
                if (m != null && indentOf(l) <= base + 1 && m.groupValues[2].first().isDigit() == ordered) {
                    items += mutableListOf(m.groupValues[4]); content = indentOf(l) + m.groupValues[2].length + 1; lastBlank = false; i++; continue
                }
                if (l.isBlank()) {
                    // A blank line ends the list unless what follows still belongs to it.
                    val next = lines.drop(i + 1).firstOrNull { it.isNotBlank() } ?: break
                    val nm = ITEM.matchEntire(next)
                    if (indentOf(next) > base || (nm != null && indentOf(next) <= base + 1 && nm.groupValues[2].first().isDigit() == ordered)) { items.last() += ""; lastBlank = true; i++; continue }
                    break
                }
                if (indentOf(l) > base) { items.last() += dedent(l, content.coerceAtMost(indentOf(l))); lastBlank = false; i++; continue }
                if (!lastBlank && !startsBlock(l) && !(l.contains('|') && lines.getOrNull(i + 1)?.let(SEPARATOR::matches) == true)) { items.last() += l.trim(); i++; continue }
                break
            }
            out += MdList(ordered, start, items.map(::blocks)); continue
        }
        if (line.contains('|') && i + 1 < lines.size && SEPARATOR.matches(lines[i + 1]) && lines[i + 1].contains('-')) {
            flush()
            val header = cells(line)
            val align = cells(lines[i + 1]).map { c -> val t = c.trim(); when { t.startsWith(':') && t.endsWith(':') -> TextAlign.Center; t.endsWith(':') -> TextAlign.End; else -> TextAlign.Start } }
            i += 2; val rows = mutableListOf<List<String>>()
            while (i < lines.size && lines[i].isNotBlank() && lines[i].contains('|')) { rows += cells(lines[i]); i++ }
            out += MdTable(header, align, rows); continue
        }
        paragraph += line.trim(); i++
    }
    flush(); return out
}

private object MarkdownCache {
    private val parsed = WeakHashMap<JSONObject, Pair<String, List<Md>>>()
    fun of(item: JSONObject, text: String): List<Md> = parsed[item]?.takeIf { it.first == text }?.second ?: parseMarkdown(text).also { parsed[item] = text to it }
}
internal fun markdownOf(item: JSONObject, field: String): List<Md> = MarkdownCache.of(item, item.str(field))

/** Inline Markdown: `code`, **bold**, *italic*, ~~strike~~, [links](target), <https://…> and bare https:// links. */
internal fun inlineMarkdown(source: String, link: Color, code: Color, codeFont: FontFamily, open: (String) -> Unit): AnnotatedString = buildAnnotatedString { inline(this, source, link, code, codeFont, open) }

private fun isWord(ch: Char?) = ch != null && (ch.isLetterOrDigit())
private fun inline(b: AnnotatedString.Builder, s: String, link: Color, code: Color, codeFont: FontFamily, open: (String) -> Unit) {
    var i = 0
    fun addLink(text: String, target: String) {
        val external = target.startsWith("http://") || target.startsWith("https://")
        b.pushLink(if (external) LinkAnnotation.Url(target, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))
            else LinkAnnotation.Clickable(target, TextLinkStyles(SpanStyle(color = link)), LinkInteractionListener { localFileTarget(target)?.let(open) }))
        inline(b, text, link, code, codeFont, open); b.pop()
    }
    while (i < s.length) {
        val ch = s[i]
        if (ch == '\\' && i + 1 < s.length && s[i + 1] in "\\`*_{}[]()#+-.!|~<>") { b.append(s[i + 1]); i += 2; continue }
        if (ch == '`') {
            var n = 0; while (i + n < s.length && s[i + n] == '`') n++
            val fence = "`".repeat(n); val end = s.indexOf(fence, i + n)
            if (end > 0) { b.withStyle(SpanStyle(fontFamily = codeFont, background = code, fontSize = 0.92.em)) { append(s.substring(i + n, end).trim()) }; i = end + n; continue }
            b.append(fence); i += n; continue
        }
        if ((s.startsWith("**", i) || s.startsWith("__", i)) && i + 2 < s.length && !s[i + 2].isWhitespace()) {
            val marker = s.substring(i, i + 2); val end = s.indexOf(marker, i + 2)
            if (end > i + 2 && !(marker == "__" && isWord(s.getOrNull(end + 2)))) { b.withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { inline(this, s.substring(i + 2, end), link, code, codeFont, open) }; i = end + 2; continue }
        }
        if (s.startsWith("~~", i)) { val end = s.indexOf("~~", i + 2); if (end > i + 2) { b.withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { inline(this, s.substring(i + 2, end), link, code, codeFont, open) }; i = end + 2; continue } }
        if ((ch == '*' || ch == '_') && i + 1 < s.length && !s[i + 1].isWhitespace() && s[i + 1] != ch && !(ch == '_' && isWord(s.getOrNull(i - 1)))) {
            var end = i + 1
            while (true) { end = s.indexOf(ch, end); if (end < 0 || (s.getOrNull(end + 1) != ch && !s[end - 1].isWhitespace() && !(ch == '_' && isWord(s.getOrNull(end + 1))))) break; end += 2 }
            if (end > i + 1) { b.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { inline(this, s.substring(i + 1, end), link, code, codeFont, open) }; i = end + 1; continue }
        }
        if (ch == '[') {
            val close = s.indexOf("](", i + 1)
            if (close > i) {
                var depth = 0; var end = close + 2
                while (end < s.length) { if (s[end] == '(') depth++ else if (s[end] == ')') { if (depth == 0) break; depth-- }; end++ }
                if (end < s.length) { addLink(s.substring(i + 1, close), s.substring(close + 2, end).trim().removeSurrounding("<", ">").substringBefore(" \"")); i = end + 1; continue }
            }
        }
        if (ch == '<') { val end = s.indexOf('>', i); val target = if (end > 0) s.substring(i + 1, end) else ""; if (target.startsWith("http://") || target.startsWith("https://")) { addLink(target, target); i = end + 1; continue } }
        if ((s.startsWith("https://", i) || s.startsWith("http://", i)) && !isWord(s.getOrNull(i - 1))) {
            var end = i; while (end < s.length && !s[end].isWhitespace() && s[end] !in "<>\"'）】，。") end++
            while (end > i && s[end - 1] in ".,;:!?)") end--
            val target = s.substring(i, end); b.pushLink(LinkAnnotation.Url(target, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))); b.append(target); b.pop(); i = end; continue
        }
        b.append(ch); i++
    }
}

@Composable internal fun MarkdownText(markdown: String, open: (String) -> Unit) { val blocks = remember(markdown) { parseMarkdown(markdown) }; MarkdownBlocks(blocks, open) }

@Composable internal fun MarkdownBlocks(blocks: List<Md>, open: (String) -> Unit, depth: Int = 0, color: Color = MaterialTheme.colorScheme.onSurface) {
    Column(verticalArrangement = Arrangement.spacedBy(if (depth > 0) 4.dp else 8.dp), modifier = Modifier.fillMaxWidth()) {
        for (block in blocks) MarkdownBlock(block, open, depth, color)
    }
}

@Composable private fun MarkdownBlock(block: Md, open: (String) -> Unit, depth: Int, color: Color) {
    val c = LocalAmoColors.current; val primary = MaterialTheme.colorScheme.primary; val codeFont = LocalAmoCodeFont.current
    val body = MaterialTheme.typography.bodyLarge.copy(color = color)
    fun inl(text: String) = inlineMarkdown(text, primary, c.code, codeFont, open)
    when (block) {
        is MdHeading -> {
            val style = when (block.level) {
                1 -> MaterialTheme.typography.titleLarge.copy(fontSize = 18.sp, lineHeight = 27.sp)
                2 -> MaterialTheme.typography.titleLarge.copy(fontSize = 16.5.sp, lineHeight = 25.sp)
                else -> body.copy(fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            }
            Text(remember(block) { inl(block.text) }, style = style.copy(color = color), modifier = Modifier.padding(top = if (block.level <= 2) 4.dp else 2.dp))
        }
        is MdParagraph -> Text(remember(block) { inl(block.text) }, style = body)
        is MdCode -> Column(Modifier.fillMaxWidth().background(c.code, MaterialTheme.shapes.small).border(1.dp, c.line, MaterialTheme.shapes.small)) {
            if (block.language.isNotBlank()) Text(block.language, style = MaterialTheme.typography.labelSmall, color = c.dim, modifier = Modifier.padding(start = 10.dp, top = 6.dp))
            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp)) {
                Text(block.text, fontFamily = codeFont, fontSize = 12.5.sp, lineHeight = 19.sp, softWrap = false, color = color)
            }
        }
        is MdQuote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(c.line))
            Box(Modifier.padding(start = 10.dp)) { MarkdownBlocks(block.blocks, open, depth + 1, c.dim) }
        }
        is MdList -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            block.items.forEachIndexed { index, item ->
                Row {
                    val marker = if (block.ordered) "${block.start + index}." else listOf("•", "◦", "▪")[depth.coerceAtMost(2)]
                    Text(marker, style = body.copy(color = if (block.ordered) color else c.dim), textAlign = TextAlign.End, modifier = Modifier.width(if (block.ordered) 24.dp else 16.dp).padding(end = 6.dp))
                    Box(Modifier.weight(1f)) { MarkdownBlocks(item, open, depth + 1, color) }
                }
            }
        }
        is MdTable -> Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) { TableGrid(block, ::inl, body) }
        MdRule -> HorizontalDivider(color = c.line, modifier = Modifier.padding(vertical = 4.dp))
    }
}

/** Columns as wide as their widest cell (up to 260 dp), rows as tall as their tallest; thin grid lines. */
@Composable private fun TableGrid(table: MdTable, inl: (String) -> AnnotatedString, body: TextStyle) {
    val c = LocalAmoColors.current
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    val grid = remember(table) { object { var xs = IntArray(0); var ys = IntArray(0) } }
    val small = body.copy(fontSize = 13.sp, lineHeight = 20.sp)
    Layout(
        content = {
            (listOf(table.header) + table.rows).forEachIndexed { r, row ->
                for (col in 0 until columns) Text(remember(table, r, col) { inl(row.getOrElse(col) { "" }) }, style = if (r == 0) small.copy(fontWeight = FontWeight.SemiBold) else small, textAlign = table.align.getOrElse(col) { TextAlign.Start }, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
            }
        },
        modifier = Modifier.drawBehind {
            if (grid.xs.isEmpty() || grid.ys.size < 2) return@drawBehind
            drawRect(c.code, topLeft = Offset.Zero, size = Size(size.width, grid.ys[1].toFloat()))
            val w = 1.dp.toPx()
            grid.ys.forEach { y -> drawRect(c.line, Offset(0f, (y.toFloat() - w / 2).coerceIn(0f, size.height - w)), Size(size.width, w)) }
            grid.xs.forEach { x -> drawRect(c.line, Offset((x.toFloat() - w / 2).coerceIn(0f, size.width - w), 0f), Size(w, size.height)) }
        },
    ) { measurables, _ ->
        val cap = 260.dp.roundToPx(); val least = 36.dp.roundToPx()
        val rows = measurables.size / columns.coerceAtLeast(1)
        val widths = IntArray(columns) { least }
        // First the natural widths, then each cell again at its column's width so wrapped cells get their true height.
        measurables.forEachIndexed { i, m -> widths[i % columns] = maxOf(widths[i % columns], m.maxIntrinsicWidth(Constraints.Infinity).coerceAtMost(cap)) }
        val placeables = measurables.mapIndexed { i, m -> m.measure(Constraints(minWidth = widths[i % columns], maxWidth = widths[i % columns])) }
        val heights = IntArray(rows) { r -> (0 until columns).maxOf { placeables[r * columns + it].height } }
        val xs = IntArray(columns + 1).also { for (k in 1..columns) it[k] = it[k - 1] + widths[k - 1] }
        val ys = IntArray(rows + 1).also { for (k in 1..rows) it[k] = it[k - 1] + heights[k - 1] }
        grid.xs = xs; grid.ys = ys
        layout(xs[columns], ys[rows]) { placeables.forEachIndexed { i, p -> p.place(xs[i % columns], ys[i / columns]) } }
    }
}

/** A unified diff for the phone: one column, added and removed lines tinted, hunk headers dimmed. */
@Composable internal fun DiffView(diff: String) {
    val c = LocalAmoColors.current; val codeFont = LocalAmoCodeFont.current
    val lines = remember(diff) { diff.split('\n').take(2000) }
    Box(Modifier.fillMaxWidth().background(c.code, MaterialTheme.shapes.small).border(1.dp, c.line, MaterialTheme.shapes.small).horizontalScroll(rememberScrollState())) {
        Column(Modifier.padding(vertical = 6.dp).width(IntrinsicSize.Max)) {
            for (line in lines) {
                val (bg, fg) = when {
                    line.startsWith("@@") -> Color.Transparent to c.dim
                    line.startsWith("+") && !line.startsWith("+++") -> c.added to c.addedText
                    line.startsWith("-") && !line.startsWith("---") -> c.removed to c.error
                    else -> Color.Transparent to MaterialTheme.colorScheme.onSurface
                }
                Text(line.ifEmpty { " " }, fontFamily = codeFont, fontSize = 12.sp, lineHeight = 18.sp, softWrap = false, color = fg, modifier = Modifier.fillMaxWidth().background(bg).padding(horizontal = 10.dp))
            }
        }
    }
}

