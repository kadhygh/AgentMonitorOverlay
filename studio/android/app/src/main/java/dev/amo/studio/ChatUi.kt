package dev.amo.studio

import android.content.Context
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

// The conversation page (2026-10-31 redesign, plans/android-mobile-redesign.md 第 3 步): a turn's tool calls and thinking
// fold into one line, Markdown renders as blocks, the composer starts at one line with the send button inside it,
// approvals and questions waiting for you are pinned above it, and 「↓」 brings you back to the newest message.

/** One row of the conversation: an item, or a run of tool calls and thinking folded together. */
@Immutable internal sealed interface ChatRow { val key: String }
@Immutable internal data class ItemRow(val entry: Entry) : ChatRow { override val key get() = entry.id }
@Immutable internal data class OpsRow(override val key: String, val entries: List<Entry>) : ChatRow

internal fun chatRows(items: List<JSONObject>): List<ChatRow> {
    val rows = ArrayList<ChatRow>(items.size / 2); var ops = ArrayList<Entry>()
    fun flush() { if (ops.isNotEmpty()) { rows += OpsRow("ops-" + ops.first().id, ops); ops = ArrayList() } }
    for (json in items) {
        val e = Entry(json)
        when (e.type) {
            "tool", "reasoning" -> ops += e
            // A turn's end shows only when it went wrong or was stopped.
            "turn" -> { flush(); if (json.str("error").isNotBlank() || json.str("state") in listOf("failed", "interrupted")) rows += ItemRow(e) }
            "suggestion" -> {}
            else -> { flush(); rows += ItemRow(e) }
        }
    }
    flush(); return rows
}
private fun pending(e: Entry) = (e.type == "approval" || e.type == "question") && e.json.str("state") == "pending"

@Composable internal fun ChatScreen(state: StudioState, repo: StudioRepository, back: () -> Unit, newSession: () -> Unit, openTask: () -> Unit) {
    val session = state.selectedSession
    val identity = listOf(state.account?.server, state.account?.name, state.selectedPeer?.identity, state.selectedTask?.id, session?.id ?: "").joinToString("\n")
    val draftKey = remember(identity) { MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it) } }
    val prefs = LocalContext.current.applicationContext.getSharedPreferences("chat-drafts", Context.MODE_PRIVATE)
    var draft by remember(draftKey) { mutableStateOf(prefs.getString("draft-$draftKey", "") ?: "") }
    var submitted by remember(draftKey) { mutableStateOf(prefs.getString("pending-$draftKey", "") ?: "") }
    var sentAfter by remember(draftKey) { mutableStateOf(prefs.getLong("after-$draftKey", -1L)) }
    var verify by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var detail by rememberSaveable { mutableStateOf<String?>(null) }
    val expanded = rememberSaveable(saver = listSaver(save = { it.toList() }, restore = { it.toMutableStateList() })) { mutableStateListOf<String>() }
    fun saveDraft(value: String) { draft = value; prefs.edit().putString("draft-$draftKey", value).apply() }
    fun clearPending() { submitted = ""; prefs.edit().remove("pending-$draftKey").remove("after-$draftKey").apply() }
    val task = state.selectedTask
    val writable = state.connected && !state.busy && task?.peer?.online == true && !task.revoked && session?.archived != true
    val running = session?.state == "running"
    val rows = remember(state.items) { chatRows(state.items) }
    val reversed = remember(rows) { rows.asReversed() }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(state.items) {
        if (submitted.isNotEmpty() && state.items.any { it.str("type") == "user" && it.str("text").trim() == submitted.trim() && it.optLong("seq", -1L) > sentAfter }) { if (draft.trim() == submitted.trim()) saveDraft(""); clearPending() }
    }
    // Following the newest message: kept while you are at the bottom; scrolling up lets go until you come back.
    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 80 } }
    var stick by remember { mutableStateOf(true) }
    LaunchedEffect(list) { snapshotFlow { list.isScrollInProgress to atBottom }.collect { (scrolling, bottom) -> if (scrolling || bottom) stick = bottom } }
    val newest = rows.lastOrNull()?.key
    var seen by remember(session?.id) { mutableStateOf(newest) }
    LaunchedEffect(newest) { if (stick) { list.scrollToItem(0); seen = newest } }
    LaunchedEffect(atBottom, newest) { if (atBottom) seen = newest }
    val pinned = remember(rows) { reversed.indexOfFirst { it is ItemRow && pending(it.entry) } }
    val pinnedVisible = pinned >= 0 && list.layoutInfo.visibleItemsInfo.any { it.index == pinned }
    val status = session?.let { s -> listOfNotNull(if (s.archived) "已归档" else if (running) "正在回复…" else sessionStatusLabel(s.state), state.profiles.find { it.first == s.profileId }?.second).joinToString(" · ") }

    Column(Modifier.fillMaxSize()) {
        TopBar(session?.title?.ifBlank { null } ?: "未命名会话", status, back = back) {
            Box {
                IconAction(AmoIcons.More, "更多", "chat-menu") { menu = true }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("新会话") }, enabled = writable || (state.connected && task?.peer?.online == true && !task.revoked), onClick = { menu = false; newSession() })
                    DropdownMenuItem(text = { Text("这个任务的全部会话") }, onClick = { menu = false; openTask() })
                    DropdownMenuItem(text = { Text("刷新") }, onClick = { menu = false; repo.refresh(force = true) })
                }
            }
        }
        if (task?.revoked == true) Notice("授权已撤回，只能看已同步的内容。", Tone.Attention)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (rows.isEmpty()) {
                if (state.loadingItems) Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp); Text("正在读取对话…", color = LocalAmoColors.current.dim, modifier = Modifier.padding(top = 10.dp)) }
                else Empty("这里会显示会话内容。", Modifier.align(Alignment.Center))
            }
            LazyColumn(state = list, reverseLayout = true, modifier = Modifier.fillMaxSize().testTag("chat-messages"), contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                items(reversed, key = { it.key }, contentType = { if (it is OpsRow) "ops" else (it as ItemRow).entry.type }) { row ->
                    when (row) {
                        is OpsRow -> OpsLine(row, row.key in expanded, { if (row.key in expanded) expanded.remove(row.key) else expanded.add(row.key) }) { detail = it }
                        is ItemRow -> ChatItem(row.entry, writable, repo, state.sessions)
                    }
                }
            }
            if (!atBottom && rows.isNotEmpty()) {
                val fresh = newest != seen
                Surface(onClick = { scope.launch { list.animateScrollToItem(0) } }, shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, LocalAmoColors.current.line), shadowElevation = 3.dp, modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp).testTag("chat-latest")) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(AmoIcons.Down, contentDescription = null, modifier = Modifier.size(16.dp), tint = if (fresh) MaterialTheme.colorScheme.primary else LocalAmoColors.current.dim)
                        if (fresh) Text("新消息", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 4.dp))
                    }
                }
            }
        }
        if (pinned >= 0 && !pinnedVisible) {
            val e = (reversed[pinned] as ItemRow).entry
            Notice(if (e.type == "approval") "等你审批：${e.json.str("summary").ifBlank { e.json.str("detail") }.take(80)}" else "模型在等你回答", Tone.Attention, "查看", { scope.launch { list.animateScrollToItem(pinned) } }, tag = "chat-pinned")
        }
        if (submitted.isNotEmpty()) Notice("这条消息还没确认送到；草稿留在手机上。先刷新核对最新对话。", Tone.Attention, "已核对", { verify = true }, tag = "chat-unconfirmed")
        if (verify) AlertDialog(onDismissRequest = { verify = false }, title = { Text("处理待确认消息") }, text = { Text("请先在最新对话或电脑上核对这条消息。解除等待后可以继续编辑并发送；若原消息实际已送达，重发会让模型再次执行。") }, confirmButton = { AmoTextButton(onClick = { clearPending(); verify = false }) { Text("已确认未送达，继续编辑") } }, dismissButton = { AmoTextButton(onClick = { verify = false }) { Text("继续等待") } })
        Composer(draft, ::saveDraft, running, writable, canSend = writable && draft.isNotBlank() && submitted.isEmpty(), stop = repo::interrupt) {
            sentAfter = state.items.maxOfOrNull { it.optLong("seq", -1L) } ?: -1L; submitted = draft.trim(); saveDraft(submitted)
            prefs.edit().putString("pending-$draftKey", submitted).putLong("after-$draftKey", sentAfter).commit(); repo.send(submitted); stick = true
        }
    }
    detail?.let { id -> state.items.find { it.str("id") == id }?.let { item -> DetailSheet(item, { detail = null }) { path, cwd -> detail = null; repo.openFile(path, cwd) } } ?: run { detail = null } }
}

@Composable private fun Composer(draft: String, change: (String) -> Unit, running: Boolean, writable: Boolean, canSend: Boolean, stop: () -> Unit, send: () -> Unit) {
    val c = LocalAmoColors.current
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        HorizontalDivider(color = c.line)
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp).clip(RoundedCornerShape(20.dp)).background(c.input).border(1.dp, c.line, RoundedCornerShape(20.dp)), verticalAlignment = Alignment.Bottom) {
            Box(Modifier.weight(1f).padding(start = 16.dp, top = 12.dp, bottom = 12.dp)) {
                BasicTextField(draft, change, minLines = 1, maxLines = 6, textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface), cursorBrush = SolidColor(MaterialTheme.colorScheme.primary), modifier = Modifier.fillMaxWidth().testTag("chat-input"),
                    decorationBox = { inner -> if (draft.isEmpty()) Text(if (writable) "给模型发消息…" else "现在发不了消息", color = c.dim, style = MaterialTheme.typography.bodyLarge); inner() })
            }
            if (running) IconAction(AmoIcons.Stop, "停止", "chat-interrupt", enabled = writable, tint = c.error, onClick = stop)
            if (!running || draft.isNotBlank()) Box(Modifier.padding(4.dp).size(40.dp).clip(CircleShape).background(if (canSend) MaterialTheme.colorScheme.primary else c.line), contentAlignment = Alignment.Center) {
                IconAction(AmoIcons.Send, "发送", "chat-send", enabled = canSend, tint = if (canSend) MaterialTheme.colorScheme.onPrimary else c.dim, onClick = send)
            }
        }
    }
}

/** 「12 个操作 · 改了 2 个文件 · 1 个失败」, and when opened one line per call; a call opens its details. */
@Composable private fun OpsLine(row: OpsRow, open: Boolean, toggle: () -> Unit, show: (String) -> Unit) {
    val c = LocalAmoColors.current
    val tools = row.entries.filter { it.type == "tool" }
    val files = remember(row) { tools.flatMap { t -> t.json.objects("files").map { it.str("path") } }.distinct().size }
    val failed = tools.count { it.json.str("status") == "failed" }
    val live = row.entries.lastOrNull { it.json.str("status") == "running" || it.json.optBoolean("streaming") }
    val label = buildString {
        if (tools.isEmpty()) append("思考") else append("${tools.size} 个操作")
        if (files > 0) append(" · 改了 $files 个文件")
    }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(onClick = toggle).heightIn(min = 36.dp).padding(horizontal = 4.dp).testTag("ops-row"), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (open) AmoIcons.ChevronDown else AmoIcons.ChevronRight, contentDescription = null, tint = c.dim, modifier = Modifier.size(16.dp))
            if (live != null) { Spacer(Modifier.width(6.dp)); StatusDot(Tone.Running) }
            Text(label, style = MaterialTheme.typography.bodySmall, color = c.dim, modifier = Modifier.padding(start = 6.dp))
            if (failed > 0) Text(" · $failed 个失败", style = MaterialTheme.typography.bodySmall, color = c.error)
            if (live != null && !open) Text(" · " + (if (live.type == "reasoning") "正在思考" else "正在执行 ${live.json.str("summary", live.json.str("name"))}"), style = MaterialTheme.typography.bodySmall, color = c.dim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        }
        if (open) Column(Modifier.padding(start = 12.dp)) {
            for (e in row.entries) {
                val j = e.json
                val (mark, color) = when {
                    e.type == "reasoning" -> "·" to c.dim
                    j.str("status") == "failed" -> "✗" to c.error
                    j.str("status") == "running" -> "◐" to c.running
                    j.str("status") == "declined" -> "⊘" to c.attention
                    else -> "✓" to c.dim
                }
                Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable { show(e.id) }.heightIn(min = 36.dp).padding(horizontal = 4.dp).testTag("tool-row"), verticalAlignment = Alignment.CenterVertically) {
                    Text(mark, color = color, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.width(18.dp))
                    Text(if (e.type == "reasoning") "思考" else j.str("name", "工具"), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(end = 6.dp))
                    Text(if (e.type == "reasoning") j.str("text").replace('\n', ' ') else j.str("summary"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = if (e.type == "reasoning") null else LocalAmoCodeFont.current, fontSize = 12.sp), color = c.dim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/** A tool call or thinking in full: input, output, the changes it made (as a diff), files to open. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun DetailSheet(item: JSONObject, close: () -> Unit, open: (String, String?) -> Unit) {
    val c = LocalAmoColors.current; val codeFont = LocalAmoCodeFont.current
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp).testTag("tool-detail"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (item.str("type") == "reasoning") {
                Text("思考过程", style = MaterialTheme.typography.titleMedium)
                SelectionContainer { Text(item.str("text"), color = c.dim) }
                return@Column
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.str("name", "工具"), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                val st = item.str("status")
                Text(listOfNotNull(toolStatusLabel(st), item.optInt("exitCode", Int.MIN_VALUE).takeIf { it != Int.MIN_VALUE }?.let { "退出码 $it" }, item.optLong("durationMs").takeIf { it > 0 }?.let { "%.1f 秒".format(it / 1000.0) }).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (st == "failed") c.error else c.dim)
            }
            if (item.str("summary").isNotBlank()) SelectionContainer { Text(item.str("summary"), fontFamily = codeFont, fontSize = 13.sp) }
            val input = remember(item) { prettyInput(item.str("input")) }
            if (input.isNotBlank()) { Label("输入"); CodeBox(input) }
            val output = listOf(item.str("detail"), item.str("progress")).filter { it.isNotBlank() }.joinToString("\n")
            if (output.isNotBlank()) { Label("输出"); CodeBox(if (output.length > 40_000) output.take(40_000) + "\n…（只显示前 40000 个字符）" else output) }
            val files = item.objects("files")
            if (files.isNotEmpty()) Label("改动")
            for (f in files) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(f.str("path"), fontFamily = codeFont, fontSize = 12.5.sp, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("+${f.optInt("added")} −${f.optInt("removed")}", style = MaterialTheme.typography.labelSmall, color = c.dim, modifier = Modifier.padding(horizontal = 6.dp))
                    if (f.str("change") != "delete") AmoTextButton(onClick = { open(f.str("path"), item.str("cwd").ifBlank { null }) }) { Text("打开") }
                }
                if (f.str("diff").isNotBlank()) DiffView(f.str("diff"))
            }
            item.objects("images").forEachIndexed { i, image -> AmoTextButton(onClick = { open(image.str("path"), item.str("cwd").ifBlank { null }) }) { Text("查看图片 ${i + 1}") } }
        }
    }
}
@Composable private fun Label(text: String) = Text(text, style = MaterialTheme.typography.labelMedium, color = LocalAmoColors.current.dim)
@Composable private fun CodeBox(text: String) {
    val c = LocalAmoColors.current
    Box(Modifier.fillMaxWidth().heightIn(max = 420.dp).background(c.code, MaterialTheme.shapes.small).border(1.dp, c.line, MaterialTheme.shapes.small).verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(10.dp)) {
        SelectionContainer { Text(text, fontFamily = LocalAmoCodeFont.current, fontSize = 12.sp, lineHeight = 18.sp, softWrap = false) }
    }
}
/** A JSON tool input as `key: value` lines; anything else as it is. */
private fun prettyInput(input: String): String {
    val o = runCatching { JSONObject(input) }.getOrNull() ?: return input
    return o.keys().asSequence().joinToString("\n") { k -> val v = o.opt(k); "$k: " + if (v is String) v else v.toString() }
}

@Composable private fun ChatItem(e: Entry, enabled: Boolean, repo: StudioRepository, sessions: List<RemoteSession>) {
    val item = e.json; val c = LocalAmoColors.current
    when (e.type) {
        "user" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Spacer(Modifier.width(40.dp))
            Surface(color = c.bubble, shape = RoundedCornerShape(12.dp, 12.dp, 3.dp, 12.dp), modifier = Modifier.weight(1f, fill = false)) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                    if (item.str("text").isNotBlank()) SelectionContainer { Text(item.str("text")) }
                    item.objects("images").forEachIndexed { index, image -> AmoTextButton(onClick = { repo.openFile(image.str("path")) }) { Text("查看图片 ${index + 1}：${image.str("path").replace('\\', '/').substringAfterLast('/')}") } }
                }
            }
        }
        "agent" -> Column {
            val blocks = markdownOf(item, "markdown")
            if (blocks.isEmpty() && item.optBoolean("streaming")) Text("正在回复…", color = c.dim)
            else SelectionContainer { MarkdownBlocks(blocks, { repo.openFile(it) }) }
        }
        "approval" -> ApprovalCard(item, enabled, repo)
        "question" -> QuestionCard(item, enabled) { repo.answer(item, it) }
        "subagent" -> {
            val child = sessions.find { it.id == item.str("childSessionId") }
            Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).border(1.dp, c.line, MaterialTheme.shapes.small).clickable(enabled = child != null) { child?.let { repo.selectSession(it) } }.padding(horizontal = 12.dp, vertical = 10.dp).testTag("subagent-row"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("子代理" + (child?.let { " · " + sessionStatusLabel(it.state) } ?: ""), style = MaterialTheme.typography.labelMedium, color = c.dim)
                    Text(item.str("summary").ifBlank { child?.title ?: "" }, maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                }
                if (child != null) Icon(AmoIcons.ChevronRight, contentDescription = "打开子会话", tint = c.dim, modifier = Modifier.size(18.dp))
            }
        }
        "notice" -> Strip(item.str("message", item.str("text")), if (item.str("level") == "error") Tone.Error else if (item.str("level") == "warning") Tone.Attention else Tone.Quiet)
        "error" -> Strip(item.str("message", item.str("text", "出错了")), Tone.Error)
        "turn" -> Strip(if (item.str("state") == "interrupted") "这一轮被中断了" else "这一轮出错：" + item.str("error", "未知错误"), if (item.str("state") == "interrupted") Tone.Quiet else Tone.Error)
        "compaction" -> {
            val before = item.optLong("beforeTokens"); val after = item.optLong("afterTokens")
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(Modifier.weight(1f), color = c.line)
                Text(if (item.str("state") == "running") "正在压缩上下文…" else "上下文已压缩" + if (before > 0 && after > 0) " ${before / 1000}k → ${after / 1000}k" else "", style = MaterialTheme.typography.labelSmall, color = c.dim, modifier = Modifier.padding(horizontal = 8.dp))
                HorizontalDivider(Modifier.weight(1f), color = c.line)
            }
        }
        "command" -> {
            var open by rememberSaveable(e.id) { mutableStateOf(false) }
            Column {
                Row(Modifier.clip(MaterialTheme.shapes.small).clickable { open = !open }.heightIn(min = 36.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (open) AmoIcons.ChevronDown else AmoIcons.ChevronRight, contentDescription = null, tint = c.dim, modifier = Modifier.size(16.dp))
                    Text("/" + item.str("name").removePrefix("/"), fontFamily = LocalAmoCodeFont.current, fontSize = 13.sp, color = c.dim, modifier = Modifier.padding(start = 6.dp))
                }
                if (open && item.str("output").isNotBlank()) CodeBox(item.str("output"))
            }
        }
        else -> { val text = item.str("text", item.str("summary", item.str("message"))); if (text.isNotBlank()) Text(text, style = MaterialTheme.typography.bodySmall, color = c.dim) }
    }
}

/** A one-line note in the conversation (notices, errors): tinted, not a card. */
@Composable private fun Strip(text: String, tone: Tone) {
    val c = LocalAmoColors.current
    val (bg, fg) = when (tone) { Tone.Error -> c.errorBg to c.error; Tone.Attention -> c.attentionBg to c.attention; else -> c.code to c.dim }
    SelectionContainer { Text(text, style = MaterialTheme.typography.bodySmall, color = fg, modifier = Modifier.fillMaxWidth().background(bg, MaterialTheme.shapes.small).padding(horizontal = 10.dp, vertical = 7.dp)) }
}

@Composable private fun ApprovalCard(item: JSONObject, enabled: Boolean, repo: StudioRepository) {
    val c = LocalAmoColors.current
    val waiting = item.str("state") == "pending"
    var open by rememberSaveable(item.str("id")) { mutableStateOf(false) }
    var overflow by remember { mutableStateOf(false) }
    Surface(color = if (waiting) c.attentionBg else MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.medium, border = BorderStroke(1.dp, if (waiting) c.attentionLine else c.line), modifier = Modifier.fillMaxWidth().testTag("approval")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (waiting) Tone.Attention else Tone.Quiet)
                Text(approvalStateLabel(item.str("state")), style = MaterialTheme.typography.labelMedium, color = if (waiting) c.attention else c.dim, modifier = Modifier.padding(start = 8.dp))
                if (item.str("kind").isNotBlank()) Text(" · " + when (item.str("kind")) { "command" -> "执行命令"; "edit", "file" -> "改文件"; "network" -> "联网"; "mcp" -> "MCP 工具"; else -> item.str("kind") }, style = MaterialTheme.typography.labelMedium, color = c.dim)
            }
            if (item.str("summary").isNotBlank()) Text(item.str("summary"), style = MaterialTheme.typography.titleSmall)
            val detail = item.str("detail")
            if (detail.isNotBlank() && detail != item.str("summary")) {
                SelectionContainer { Text(detail, fontFamily = LocalAmoCodeFont.current, fontSize = 12.5.sp, lineHeight = 19.sp, maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis, onTextLayout = { if (!open) overflow = it.hasVisualOverflow }, modifier = Modifier.fillMaxWidth().background(c.code, MaterialTheme.shapes.small).padding(8.dp)) }
                if (overflow || open) Text(if (open) "收起" else "展开全部", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium, modifier = Modifier.clip(MaterialTheme.shapes.small).clickable { open = !open }.padding(vertical = 4.dp))
            }
            if (waiting) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                SecondaryButton("拒绝", "approval-decline", enabled) { repo.approve(item, "decline") }
                PrimaryButton("允许", "approval-accept", enabled) { repo.approve(item, "accept") }
            }
        }
    }
}

@Composable private fun QuestionCard(item: JSONObject, enabled: Boolean, reply: (JSONObject) -> Unit) {
    val c = LocalAmoColors.current
    var sent by remember(item.str("id"), item.str("state")) { mutableStateOf(false) }
    val waiting = item.str("state") == "pending"
    val active = enabled && waiting && !sent
    val values = remember(item.str("id")) { mutableStateMapOf<String, String>() }
    val picks = remember(item.str("id")) { mutableStateMapOf<String, Set<String>>() }
    fun submit(value: JSONObject) { sent = true; reply(value) }
    Surface(color = if (waiting) c.attentionBg else MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.medium, border = BorderStroke(1.dp, if (waiting) c.attentionLine else c.line), modifier = Modifier.fillMaxWidth().testTag("question")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (waiting) Tone.Attention else Tone.Quiet)
                Text(if (item.str("source") == "plan-review") "计划等你确认" else questionStateLabel(item.str("state")), style = MaterialTheme.typography.labelMedium, color = if (waiting) c.attention else c.dim, modifier = Modifier.padding(start = 8.dp))
            }
            when (item.str("source")) {
                "plan-review" -> {
                    MarkdownText(item.str("plan")) {}
                    if (waiting) {
                        Field(values["feedback"] ?: "", { values["feedback"] = it }, "修改意见", enabled = active)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                            SecondaryButton("要求修改", enabled = active && !values["feedback"].isNullOrBlank()) { submit(JSONObject().put("action", "revise").put("feedback", values["feedback"])) }
                            PrimaryButton("批准并开始", enabled = active) { submit(JSONObject().put("action", "approve")) }
                        }
                    }
                }
                "mcp-form" -> {
                    Text(item.str("message"))
                    val fields = item.objects("form")
                    fields.forEach { field ->
                        val name = field.str("name"); val kind = field.str("kind")
                        when (kind) {
                            "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(values[name] == "true", { values[name] = it.toString() }, enabled = active); Text(field.str("title", name)) }
                            "select" -> Choice(field.str("title", name), field.objects("options").map { it.str("value") to it.str("label") }, values[name] ?: field.str("default")) { values[name] = it }
                            "multi" -> { Text(field.str("title", name)); field.objects("options").forEach { option -> val value = option.str("value"); Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(picks[name].orEmpty().contains(value), { checked -> picks[name] = if (checked) picks[name].orEmpty() + value else picks[name].orEmpty() - value }, enabled = active); Text(option.str("label")) } } }
                            else -> Field(values[name] ?: field.str("default"), { values[name] = it }, field.str("title", name), enabled = active)
                        }
                        if (field.str("description").isNotBlank()) Text(field.str("description"), style = MaterialTheme.typography.bodySmall, color = c.dim)
                    }
                    val valid = fields.all { field -> val value = values[field.str("name")] ?: field.str("default"); (!field.optBoolean("required") || if (field.str("kind") == "multi") picks[field.str("name")].orEmpty().isNotEmpty() else value.isNotBlank()) && (field.str("kind") !in listOf("number", "integer") || value.isBlank() || (value.toDoubleOrNull() != null && (field.str("kind") != "integer" || value.toLongOrNull() != null))) }
                    if (waiting) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { PrimaryButton("提交", enabled = active && valid) { val out = JSONObject(); fields.forEach { field -> val name = field.str("name"); val value = values[name] ?: field.str("default"); if (value.isNotBlank() || field.str("kind") == "multi") out.put(name, when (field.str("kind")) { "boolean" -> value.toBoolean(); "number" -> value.toDoubleOrNull(); "integer" -> value.toLongOrNull(); "multi" -> JSONArray(picks[name].orEmpty().toList()); else -> value }) }; submit(JSONObject().put("action", "submit").put("values", out)) } }
                }
                else -> {
                    val questions = item.objects("questions")
                    questions.forEach { q ->
                        val id = q.str("id"); val multi = q.optBoolean("multiSelect")
                        if (q.str("header").isNotBlank()) Text(q.str("header"), style = MaterialTheme.typography.labelMedium, color = c.dim)
                        Text(q.str("question"), style = MaterialTheme.typography.titleSmall)
                        q.objects("options").forEach { option ->
                            val label = option.str("label"); val on = picks[id].orEmpty().contains(label)
                            fun flip() { picks[id] = if (on) picks[id].orEmpty() - label else if (multi) picks[id].orEmpty() + label else setOf(label) }
                            Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(enabled = active) { flip() }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (multi) Checkbox(on, { flip() }, enabled = active) else RadioButton(on, { flip() }, enabled = active)
                                Column(Modifier.weight(1f)) {
                                    Text(label)
                                    if (option.str("description").isNotBlank()) Text(option.str("description"), style = MaterialTheme.typography.bodySmall, color = c.dim)
                                    if (option.str("preview").isNotBlank()) SelectionContainer { Text(option.str("preview"), style = MaterialTheme.typography.bodySmall, fontFamily = LocalAmoCodeFont.current) }
                                }
                            }
                        }
                        if (waiting && (q.objects("options").isEmpty() || q.optBoolean("other"))) OutlinedTextField(values[id] ?: "", { values[id] = it }, enabled = active, label = { Text(if (q.objects("options").isEmpty()) "回答" else "其他回答") }, visualTransformation = if (q.optBoolean("secret")) PasswordVisualTransformation() else VisualTransformation.None, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth())
                    }
                    if (waiting) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { PrimaryButton("提交回答", "question-submit", active && questions.isNotEmpty() && questions.all { picks[it.str("id")].orEmpty().isNotEmpty() || !values[it.str("id")].isNullOrBlank() }) { val answers = JSONArray(); questions.forEach { q -> val id = q.str("id"); answers.put(JSONObject().put("id", id).put("selected", JSONArray(picks[id].orEmpty().toList())).put("other", values[id] ?: "")) }; submit(JSONObject().put("action", "answer").put("answers", answers)); values.clear() } }
                }
            }
            if (waiting) Text("暂不回答", color = if (active) MaterialTheme.colorScheme.primary else c.dim, style = MaterialTheme.typography.labelMedium, modifier = Modifier.clip(MaterialTheme.shapes.small).clickable(enabled = active) { submit(JSONObject().put("action", "dismiss")) }.padding(vertical = 6.dp))
            if (sent) Text("已提交，等电脑确认。", style = MaterialTheme.typography.bodySmall, color = c.dim)
        }
    }
}

