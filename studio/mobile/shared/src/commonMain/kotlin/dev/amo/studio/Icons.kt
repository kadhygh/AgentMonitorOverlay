package dev.amo.studio

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

// Line icons drawn here (2026-10-31): the app ships no icon library, and these few match the desktop's thin strokes.
private fun icon(name: String, fill: Boolean = false, block: PathBuilder.() -> Unit): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
    if (fill) path(fill = SolidColor(Color.Black), pathBuilder = block)
    else path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathBuilder = block)
}.build()

private fun PathBuilder.circle(x: Float, y: Float, r: Float) { moveTo(x - r, y); arcTo(r, r, 0f, false, true, x + r, y); arcTo(r, r, 0f, false, true, x - r, y); close() }

internal object AmoIcons {
    val Back = icon("back") { moveTo(15f, 5f); lineTo(8f, 12f); lineTo(15f, 19f) }
    val More = icon("more", fill = true) { circle(5f, 12f, 1.7f); circle(12f, 12f, 1.7f); circle(19f, 12f, 1.7f) }
    val Plus = icon("plus") { moveTo(12f, 5f); lineTo(12f, 19f); moveTo(5f, 12f); lineTo(19f, 12f) }
    val Send = icon("send") { moveTo(12f, 19f); lineTo(12f, 5f); moveTo(6f, 11f); lineTo(12f, 5f); lineTo(18f, 11f) }
    val Stop = icon("stop", fill = true) { moveTo(7f, 7f); lineTo(17f, 7f); lineTo(17f, 17f); lineTo(7f, 17f); close() }
    val Down = icon("down") { moveTo(12f, 5f); lineTo(12f, 19f); moveTo(6f, 13f); lineTo(12f, 19f); lineTo(18f, 13f) }
    val ChevronRight = icon("chevron-right") { moveTo(9f, 6f); lineTo(15f, 12f); lineTo(9f, 18f) }
    val ChevronDown = icon("chevron-down") { moveTo(6f, 9f); lineTo(12f, 15f); lineTo(18f, 9f) }
    val Close = icon("close") { moveTo(6f, 6f); lineTo(18f, 18f); moveTo(18f, 6f); lineTo(6f, 18f) }
    val Refresh = icon("refresh") { moveTo(19f, 12f); arcTo(7f, 7f, 0f, true, true, 16.9f, 7f); moveTo(17f, 3f); lineTo(17f, 7.2f); lineTo(12.8f, 7.2f) }
    val Settings = icon("settings") {
        circle(12f, 12f, 3f)
        // Eight short spokes around the hub: a plain cog that reads at 20 dp.
        for (i in 0 until 8) {
            val a = Math.toRadians(i * 45.0)
            moveTo(12f + 6f * Math.cos(a).toFloat(), 12f + 6f * Math.sin(a).toFloat()); lineTo(12f + 8.5f * Math.cos(a).toFloat(), 12f + 8.5f * Math.sin(a).toFloat())
        }
    }
    val Computer = icon("computer") { moveTo(4f, 5f); lineTo(20f, 5f); lineTo(20f, 15f); lineTo(4f, 15f); close(); moveTo(9f, 19f); lineTo(15f, 19f); moveTo(12f, 15f); lineTo(12f, 19f) }
    val File = icon("file") { moveTo(6f, 3f); lineTo(14f, 3f); lineTo(19f, 8f); lineTo(19f, 21f); lineTo(6f, 21f); close(); moveTo(14f, 3f); lineTo(14f, 8f); lineTo(19f, 8f) }
}
