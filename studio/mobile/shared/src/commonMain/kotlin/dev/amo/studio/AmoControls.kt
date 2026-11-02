package dev.amo.studio

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The phone's own small components (2026-10-31 redesign): a top bar with icons, list rows divided by thin lines,
// status dots, quiet buttons and a floating notice — the desktop's look, laid out for a thumb.

@Composable
internal fun AmoTextButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    TextButton(onClick = onClick, modifier = modifier, enabled = enabled, shape = MaterialTheme.shapes.small, content = content)
}

/** 48 dp to touch, the icon itself 22 dp. */
@Composable internal fun IconAction(icon: ImageVector, label: String, tag: String? = null, enabled: Boolean = true, tint: Color = MaterialTheme.colorScheme.onSurface, onClick: () -> Unit) {
    Box(
        Modifier.size(48.dp).clip(CircleShape).clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick).semantics { contentDescription = label }.let { if (tag != null) it.testTag(tag) else it },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = null, tint = if (enabled) tint else tint.copy(alpha = 0.35f), modifier = Modifier.size(22.dp)) }
}

@Composable internal fun TopBar(title: String, subtitle: String? = null, back: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = if (back == null) 16.dp else 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (back != null) IconAction(AmoIcons.Back, "返回", "back", onClick = back)
            Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge.copy(fontSize = 17.sp, lineHeight = 24.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp), color = LocalAmoColors.current.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            actions()
        }
        HorizontalDivider(color = LocalAmoColors.current.line)
    }
}

@Composable internal fun toneColor(tone: Tone): Color = when (tone) {
    Tone.Attention -> LocalAmoColors.current.attention
    Tone.Running -> LocalAmoColors.current.running
    Tone.Error -> LocalAmoColors.current.error
    Tone.Quiet -> LocalAmoColors.current.quiet
}
/** The desktop's status dot; a hollow ring for quiet ones so the colour is not the only sign. */
@Composable internal fun StatusDot(tone: Tone, modifier: Modifier = Modifier) {
    val color = toneColor(tone)
    Box(modifier.size(8.dp).clip(CircleShape).let { if (tone == Tone.Quiet) it.border(1.5.dp, color, CircleShape) else it.background(color) })
}

/** A list row: dot, title, one grey line, time on the right; rows are divided by a hairline, not boxed. */
@Composable internal fun ListRow(title: String, subtitle: String = "", tone: Tone? = null, trailing: String = "", tag: String = "entry", indent: Int = 0, highlight: Boolean = false, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(if (highlight) LocalAmoColors.current.attentionBg else Color.Transparent).clickable(onClick = onClick).testTag(tag)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp + (indent * 20).dp, end = 16.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (tone != null) { StatusDot(tone); Spacer(Modifier.width(12.dp)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, lineHeight = 18.sp), color = LocalAmoColors.current.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (trailing.isNotBlank()) Text(trailing, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal), color = LocalAmoColors.current.dim, modifier = Modifier.padding(start = 8.dp))
        }
        HorizontalDivider(color = LocalAmoColors.current.line, modifier = Modifier.padding(start = 16.dp + (indent * 20).dp))
    }
}

@Composable internal fun SectionHeader(text: String, trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 18.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = LocalAmoColors.current.dim, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

@Composable internal fun PrimaryButton(label: String, tag: String = label, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp), modifier = modifier.heightIn(min = 44.dp).testTag(tag)) { Text(label) }
}
@Composable internal fun SecondaryButton(label: String, tag: String = label, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, shape = MaterialTheme.shapes.small, border = BorderStroke(1.dp, LocalAmoColors.current.line), contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp), modifier = modifier.heightIn(min = 44.dp).testTag(tag)) { Text(label, color = MaterialTheme.colorScheme.onSurface) }
}

/** The round 「+」 at the bottom right of the lists. */
@Composable internal fun Fab(label: String, tag: String, enabled: Boolean, onClick: () -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    Box(
        Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(if (enabled) primary else primary.copy(alpha = 0.35f)).clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick).semantics { contentDescription = label }.testTag(tag),
        contentAlignment = Alignment.Center,
    ) { Icon(AmoIcons.Plus, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(26.dp)) }
}

/** A notice floating over the top of the page (errors, connection): it does not push the page down. */
@Composable internal fun Notice(text: String, tone: Tone, action: String? = null, onAction: (() -> Unit)? = null, onClose: (() -> Unit)? = null, tag: String = "notice") {
    val c = LocalAmoColors.current
    val (bg, fg) = when (tone) { Tone.Error -> c.errorBg to c.error; Tone.Attention -> c.attentionBg to c.attention; else -> MaterialTheme.colorScheme.surface to MaterialTheme.colorScheme.onSurface }
    Surface(color = bg, shape = MaterialTheme.shapes.medium, border = BorderStroke(1.dp, c.line), shadowElevation = 2.dp, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag(tag)) {
        Row(Modifier.padding(start = 14.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            SelectionContainer(Modifier.weight(1f).padding(vertical = 8.dp)) { Text(text, color = fg, style = MaterialTheme.typography.bodySmall) }
            if (action != null && onAction != null) AmoTextButton(onClick = onAction) { Text(action) }
            if (onClose != null) IconAction(AmoIcons.Close, "关闭", tint = c.dim, onClick = onClose)
        }
    }
}

@Composable internal fun Choice(label: String, options: List<Pair<String, String>>, selected: String, tag: String = "choice-$label", choose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = LocalAmoColors.current.dim)
        Box {
            Row(Modifier.fillMaxWidth().padding(top = 4.dp).clip(MaterialTheme.shapes.small).border(1.dp, LocalAmoColors.current.line, MaterialTheme.shapes.small).clickable { expanded = true }.heightIn(min = 44.dp).padding(horizontal = 12.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
                Text(options.find { it.first == selected }?.second ?: "请选择", modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(AmoIcons.ChevronDown, contentDescription = null, tint = LocalAmoColors.current.dim, modifier = Modifier.size(18.dp))
            }
            DropdownMenu(expanded, { expanded = false }) { options.forEach { (id, text) -> DropdownMenuItem(text = { Text(text) }, onClick = { choose(id); expanded = false }) } }
        }
    }
}
@Composable internal fun Field(value: String, change: (String) -> Unit, label: String, tag: String = label, enabled: Boolean = true) { OutlinedTextField(value, change, label = { Text(label) }, singleLine = true, enabled = enabled, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth().testTag(tag)) }
@Composable internal fun Empty(text: String, modifier: Modifier = Modifier) { Text(text, modifier.padding(horizontal = 20.dp, vertical = 24.dp), color = LocalAmoColors.current.dim) }
@Composable internal fun ScrollPage(content: @Composable ColumnScope.() -> Unit) { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp), content = content) }
