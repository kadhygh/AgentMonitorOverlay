package dev.amo.studio

import dev.amo.studio.res.Res
import dev.amo.studio.res.jetbrains_mono
import dev.amo.studio.res.noto_sans_sc
import dev.amo.studio.res.noto_serif_sc
import org.jetbrains.compose.resources.FontResource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The desktop's palette beyond Material's (base.css; status colours added 2026-10-31 for the phone redesign). */
data class AmoColors(
    val bubble: Color, val input: Color, val dim: Color,
    val line: Color = Color(0xffd9d3c7),
    val attention: Color = Color(0xff93570a), val attentionBg: Color = Color(0xfff4e7cd), val attentionLine: Color = Color(0xffdcc08a),
    val running: Color = Color(0xff3b7a4f), val quiet: Color = Color(0xff8d877c),
    val error: Color = Color(0xffa3302b), val errorBg: Color = Color(0xfff3dfdb),
    val code: Color = Color(0xfff1eee7), val selected: Color = Color(0xffe7dfcd),
    val added: Color = Color(0xffe3efe2), val addedText: Color = Color(0xff2f6b3f), val removed: Color = Color(0xfff6e0dc),
)
private val lightAmo = AmoColors(Color(0xffebe3d1), Color(0xfffbfaf7), Color(0xff5d5850))
private val darkAmo = AmoColors(
    Color(0xff2c2c2e), Color(0xff232324), Color(0xffa0a8b2), line = Color(0xff2b3036),
    attention = Color(0xfff2b544), attentionBg = Color(0xff2a2416), attentionLine = Color(0xff5a4a24),
    running = Color(0xff5cc98a), quiet = Color(0xff6b7480), error = Color(0xffff8a8a), errorBg = Color(0xff2a1617),
    code = Color(0xff0c0e10), selected = Color(0xff22272d), added = Color(0xff15261b), addedText = Color(0xff7fd39b), removed = Color(0xff2c1517),
)
val LocalAmoColors = staticCompositionLocalOf { lightAmo }
val LocalAmoCodeFont = staticCompositionLocalOf<FontFamily> { FontFamily.Monospace }

// The fonts are Compose resources (2026-11-02, shared with iOS); on Android they were res/font before.
@OptIn(ExperimentalTextApi::class)
@Composable
private fun variableFont(resource: FontResource): FontFamily = FontFamily(
    listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.SemiBold, FontWeight.Bold).map { weight ->
        org.jetbrains.compose.resources.Font(resource, weight = weight, variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)))
    }
)

@Composable
fun AmoTheme(preference: String, content: @Composable () -> Unit) {
    val dark = preference == "dark" || (preference == "system" && isSystemInDarkTheme())
    val scheme = if (dark) darkColorScheme(primary = Color(0xff7fb2ff), onPrimary = Color(0xff0b1626), background = Color(0xff111316), surface = Color(0xff181b1f), onBackground = Color(0xffe6e8eb), onSurface = Color(0xffe6e8eb), outline = Color(0xff2b3036), error = Color(0xffff8a8a))
    else lightColorScheme(primary = Color(0xff23436f), onPrimary = Color(0xfffbfaf7), background = Color(0xffefede8), surface = Color(0xfffbfaf7), onBackground = Color(0xff22201c), onSurface = Color(0xff22201c), outline = Color(0xffd9d3c7), error = Color(0xffa3302b))
    val colors = scheme.copy(
        secondary = scheme.primary, onSecondary = scheme.onPrimary,
        secondaryContainer = if (dark) Color(0xff22324a) else Color(0xffe4d6b8), onSecondaryContainer = scheme.onSurface,
        tertiary = scheme.primary, onTertiary = scheme.onPrimary,
        tertiaryContainer = if (dark) Color(0xff1b2633) else Color(0xffefe7d6), onTertiaryContainer = scheme.onSurface,
        primaryContainer = if (dark) Color(0xff22324a) else Color(0xffe7dfcd), onPrimaryContainer = scheme.onSurface,
        surfaceVariant = if (dark) Color(0xff1f2328) else Color(0xfff4f2ed), onSurfaceVariant = if (dark) Color(0xffa0a8b2) else Color(0xff5d5850),
        outlineVariant = scheme.outline, inverseSurface = if (dark) Color(0xffe6e8eb) else Color(0xff22201c), inverseOnSurface = scheme.surface, inversePrimary = if (dark) Color(0xff23436f) else Color(0xff7fb2ff),
        errorContainer = if (dark) Color(0xff2a1617) else Color(0xfff3dfdb), onErrorContainer = scheme.error, onError = if (dark) Color(0xff111316) else Color.White,
        surfaceTint = scheme.primary, surfaceBright = if (dark) Color(0xff1f2328) else Color(0xfffbfaf7), surfaceDim = scheme.background,
        surfaceContainerLowest = scheme.background, surfaceContainerLow = scheme.surface, surfaceContainer = scheme.surface,
        surfaceContainerHigh = if (dark) Color(0xff1f2328) else Color(0xfff4f2ed), surfaceContainerHighest = if (dark) Color(0xff22272d) else Color(0xffe7e3db)
    )
    val base = Typography()
    val sans = variableFont(Res.font.noto_sans_sc)
    val serif = variableFont(Res.font.noto_serif_sc)
    val codeFont = variableFont(Res.font.jetbrains_mono)
    val body = base.bodyLarge.copy(fontFamily = sans, fontSize = 14.sp, lineHeight = 22.sp)
    val title = base.titleLarge.copy(fontFamily = serif, fontSize = 19.sp, lineHeight = 29.sp)
    val typography = Typography(bodyLarge = body, bodyMedium = body, bodySmall = body.copy(fontSize = 13.sp, lineHeight = 21.sp), titleLarge = title, titleMedium = body.copy(fontSize = 16.sp, lineHeight = 25.sp, fontWeight = FontWeight.Medium), titleSmall = body.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium), displayLarge = title.copy(fontSize = 24.sp, lineHeight = 36.sp), displayMedium = title.copy(fontSize = 24.sp, lineHeight = 36.sp), displaySmall = title, headlineLarge = title.copy(fontSize = 24.sp, lineHeight = 36.sp), headlineMedium = title.copy(fontSize = 24.sp, lineHeight = 36.sp), headlineSmall = title, labelLarge = body.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium), labelMedium = body.copy(fontSize = 13.sp, fontWeight = FontWeight.Medium), labelSmall = body.copy(fontSize = 12.sp, fontWeight = FontWeight.Medium))
    CompositionLocalProvider(LocalAmoColors provides if (dark) darkAmo else lightAmo, LocalAmoCodeFont provides codeFont) {
        MaterialTheme(colorScheme = colors, typography = typography, shapes = Shapes(extraSmall = RoundedCornerShape(2.dp), small = RoundedCornerShape(3.dp), medium = RoundedCornerShape(4.dp), large = RoundedCornerShape(4.dp), extraLarge = RoundedCornerShape(4.dp)), content = content)
    }
}
