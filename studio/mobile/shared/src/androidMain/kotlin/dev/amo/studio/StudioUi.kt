package dev.amo.studio

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

// Pages (2026-10-31 redesign): 工作台 (what waits for you, then tasks by activity) → a task's sessions as a tree → the
// conversation; 设置 holds the computers and pairing. Opening the app goes back to the last conversation (设置 can turn
// that off); new tasks and sessions start from the 「+」 at the bottom right, in a sheet.

@Composable
fun StudioUi(state: StudioState, repo: StudioRepository) {
    val stack = rememberSaveable(saver = listSaver(save = { it.toList() }, restore = { it.toMutableStateList() })) { mutableStateListOf("home") }
    var sheet by rememberSaveable { mutableStateOf("") }
    var handledSession by rememberSaveable { mutableStateOf(state.selectedSession?.id) }
    var resumed by rememberSaveable { mutableStateOf(false) }
    fun go(page: String) { if (stack.lastOrNull() != page) stack.add(page) }
    fun reset(vararg pages: String) { stack.clear(); stack.addAll(pages) }
    LaunchedEffect(state.selectedSession?.id) {
        val id = state.selectedSession?.id
        if (id != null && id != handledSession) { sheet = ""; if (stack.lastOrNull() != "chat") { reset("home", "task", "chat") } }
        handledSession = id
    }
    LaunchedEffect(state.account?.name) { if (state.account == null) { reset("home"); sheet = ""; resumed = false } }
    // Back to the last conversation once the phone's copy of the tasks is there.
    LaunchedEffect(state.account?.name, state.tasks.isNotEmpty()) {
        if (resumed || state.account == null || state.tasks.isEmpty()) return@LaunchedEffect
        resumed = true
        // Only while still on 工作台: someone who already went elsewhere is not pulled away.
        if (!state.resumeLast || state.selectedSession != null || stack.size > 1 || sheet.isNotEmpty()) return@LaunchedEffect
        val (peer, taskId, sessionId) = repo.lastLocation() ?: return@LaunchedEffect
        val task = state.tasks.find { it.peer.identity == peer && it.id == taskId } ?: return@LaunchedEffect
        repo.selectTask(task)
        task.sessions.find { it.id == sessionId }?.let(repo::selectSession) ?: reset("home", "task")
    }
    val message by rememberUpdatedState(state.message)
    LaunchedEffect(state.message) {
        val m = state.message ?: return@LaunchedEffect
        // Plain news goes away by itself; anything about an unconfirmed result or the login stays until closed.
        if (listOf("未确认", "失效", "替换", "重试").none { m.contains(it) }) { delay(8000); if (message == m) repo.clearMessage() }
    }
    val page = stack.lastOrNull() ?: "home"
    fun back() {
        when {
            state.file != null || state.fileLoading != null -> repo.closeFile()
            sheet.isNotEmpty() -> sheet = ""
            stack.size > 1 -> { val left = stack.removeAt(stack.lastIndex); if (left == "task") repo.leaveTask() }
        }
    }
    BackHandler(state.file != null || state.fileLoading != null || sheet.isNotEmpty() || stack.size > 1) { back() }
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.fillMaxSize()) {
                when {
                    state.account == null -> Login(state, repo)
                    state.file != null -> { TopBar(state.file.name, state.file.path.takeIf { it != state.file.name }, back = repo::closeFile); Box(Modifier.weight(1f)) { FileViewer(state.file) { repo.openFile(it) } } }
                    page == "settings" -> Settings(state, repo) { back() }
                    page == "chat" && state.selectedSession != null -> ChatScreen(state, repo, back = { back() }, newSession = { sheet = "session" }, openTask = { back() })
                    (page == "task" || page == "chat") && state.selectedTask != null -> TaskPage(state, repo, back = { stack.clear(); stack.add("home"); repo.leaveTask() }) { sheet = "session" }
                    else -> Home(state, repo, settings = { go("settings") }, create = { sheet = "task" }, open = { task, session -> repo.selectTask(task); if (session != null) repo.selectSession(session) else go("task") })
                }
            }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp).align(Alignment.TopCenter))
            Column(Modifier.align(Alignment.BottomCenter).padding(bottom = if (page == "chat") 76.dp else 84.dp)) {
                if (state.account != null && !state.connected) Notice(if (state.connecting) "正在连接团队服务器…" else "连接断了 · 草稿留在手机上", if (state.connecting) Tone.Quiet else Tone.Attention, if (state.connecting) null else "重连", repo::retry, tag = "connection")
                state.fileLoading?.let { path -> Notice("正在读取 ${path.replace('\\', '/').substringAfterLast('/')}", Tone.Quiet, "取消", repo::closeFile, tag = "file-loading") }
                state.message?.let { Notice(it, Tone.Attention, onClose = repo::clearMessage, tag = "message") }
            }
        }
    }
    if (sheet.isNotEmpty() && state.account != null) CreateSheet(state, repo, sheet == "task") { sheet = "" }
    LaunchedEffect(state.message) { if (state.message == "已提交，等待电脑确认") sheet = "" }
}

// ---- 工作台

private fun taskTone(t: RemoteTask): Tone {
    if (t.revoked) return Tone.Quiet
    val live = t.sessions.filterNot { it.archived }
    return when {
        live.any { needsYou(it.state) || it.state == "awaiting-review" } -> Tone.Attention
        live.any { it.state == "running" } -> Tone.Running
        live.maxByOrNull { it.updatedAt }?.state == "error" -> Tone.Error
        else -> Tone.Quiet
    }
}

@Composable private fun Home(state: StudioState, repo: StudioRepository, settings: () -> Unit, create: () -> Unit, open: (RemoteTask, RemoteSession?) -> Unit) {
    val computers = state.peers.filter { it.role == "guest" }
    var filter by rememberSaveable { mutableStateOf("") }
    val shown = state.tasks.filter { filter.isEmpty() || it.peer.identity == filter }.sortedByDescending { it.activeAt }
    val waiting = shown.filterNot { it.revoked }.flatMap { t -> t.sessions.filter { !it.archived && needsYou(it.state) }.map { t to it } }.sortedByDescending { it.second.updatedAt }
    val subtitle = when {
        state.connecting -> "正在连接…"
        !state.connected -> "未连接"
        computers.isEmpty() -> "还没有配对电脑"
        else -> computers.count { it.online }.let { n -> if (computers.size == 1) "${computers[0].name} · ${if (n > 0) "在线" else "离线"}" else "$n / ${computers.size} 台电脑在线" }
    }
    Column(Modifier.fillMaxSize()) {
        TopBar("工作台", subtitle) { IconAction(AmoIcons.Refresh, "刷新", "refresh", enabled = state.connected) { repo.refresh(force = true) }; IconAction(AmoIcons.Settings, "设置", "settings", onClick = settings) }
        Box(Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("tasks"), contentPadding = PaddingValues(bottom = 96.dp)) {
                state.update.latest?.let { latest -> item("update") { ListRow("有新版本 ${latest.version}", "点这里去下载安装", Tone.Attention, tag = "update-banner", onClick = settings) } }
                if (computers.isEmpty()) item("pair") { Column { SectionHeader("配对电脑"); Text("在电脑上确认配对后，这里会列出它授权给手机的任务。", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)); PairingList(state, repo) } }
                if (computers.size > 1) item("computers") {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Chip("全部", filter.isEmpty(), null) { filter = "" }
                        computers.forEach { p -> Chip(p.name, filter == p.identity, if (p.online) Tone.Running else Tone.Quiet) { filter = p.identity; repo.selectPeer(p) } }
                    }
                }
                if (waiting.isNotEmpty()) {
                    item("waiting-head") { SectionHeader("等你处理 · ${waiting.size}") }
                    items(waiting, key = { "w-" + it.first.key + "/" + it.second.id }) { (t, s) -> ListRow(s.title.ifBlank { "未命名会话" }, "${sessionStatusLabel(s.state)} · ${t.title}", Tone.Attention, shortTime(s.updatedAt), tag = "attention-row", highlight = true) { open(t, s) } }
                }
                item("tasks-head") { SectionHeader(if (shown.isEmpty()) "任务" else "任务 · ${shown.size}") }
                items(shown, key = { it.key }) { t ->
                    val live = t.sessions.filterNot { it.archived }
                    val parts = buildList {
                        when { t.revoked -> add("授权已撤回"); !t.peer.online -> add("电脑离线") }
                        live.count { it.state == "running" }.takeIf { it > 0 }?.let { add("$it 个在跑") }
                        live.count { needsYou(it.state) }.takeIf { it > 0 }?.let { add("$it 个等你") }
                        if (none()) add(if (live.isEmpty()) "还没有会话" else "${live.size} 个会话")
                        if (computers.size > 1 && filter.isEmpty()) add(t.peer.name)
                        if (t.description.isNotBlank()) add(t.description.lineSequence().first())
                    }
                    ListRow(t.title.ifBlank { "未命名任务" }, parts.joinToString(" · "), taskTone(t), shortTime(t.activeAt), tag = "task-row") { open(t, null) }
                }
                if (shown.isEmpty() && computers.isNotEmpty()) item("empty") { Empty(if (state.connected) "还没有授权给手机的任务。可以点右下角的「+」在电脑上新建一个，或者在电脑的任务页把任务授权给这台手机。" else "连上之后会列出授权给手机的任务。") }
            }
            Box(Modifier.align(Alignment.BottomEnd).padding(20.dp)) { Fab("新建任务", "task-create", state.connected && state.selectedPeer?.online == true && state.selectedPeer.role == "guest", create) }
        }
    }
}

@Composable private fun Chip(label: String, selected: Boolean, tone: Tone?, onClick: () -> Unit) {
    val c = LocalAmoColors.current
    Row(Modifier.clip(RoundedCornerShape(16.dp)).background(if (selected) c.selected else MaterialTheme.colorScheme.surface).border(1.dp, c.line, RoundedCornerShape(16.dp)).clickable(onClick = onClick).heightIn(min = 36.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        if (tone != null) { StatusDot(tone); Spacer(Modifier.width(6.dp)) }
        Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

/** Same-account devices online to pair with, and how the requests stand. */
@Composable private fun PairingList(state: StudioState, repo: StudioRepository) {
    val available = state.onlineDevices.filter { online -> state.peers.none { it.identity == online.identity } }
    Column {
        available.forEach { p -> ListRow(p.name, "点一下请求配对，然后在这台电脑上确认", Tone.Quiet, tag = "peer-available") { repo.requestPair(p.account, p.device) } }
        if (available.isEmpty()) Empty(if (state.peers.any { it.role == "guest" }) "同账号没有别的在线电脑要配对。" else "没有找到同账号在线的电脑。请确认电脑上的 AMO Studio 开着、登录的是同一个账号。")
        state.pairing.filter { it.str("state") != "allowed" }.forEach { pair -> Text(if (pair.str("state") == "refused") "配对请求被电脑拒绝了" else "配对请求已发出，等电脑确认", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
    }
}

// ---- a task's sessions

@Composable private fun TaskPage(state: StudioState, repo: StudioRepository, back: () -> Unit, create: () -> Unit) {
    val task = state.selectedTask ?: return
    val c = LocalAmoColors.current
    val open = rememberSaveable(task.key, saver = listSaver(save = { it.toList() }, restore = { it.toMutableStateList() })) { mutableStateListOf<String>() }
    var archivedOpen by rememberSaveable(task.key) { mutableStateOf(false) }
    var descriptionOpen by rememberSaveable(task.key) { mutableStateOf(false) }
    val live = state.sessions.filterNot { it.archived }
    val archived = state.sessions.filter { it.archived }.sortedByDescending { it.updatedAt }
    val ids = live.map { it.id }.toSet()
    val children = live.filter { it.parentId != null && it.parentId in ids }.groupBy { it.parentId!! }
    val roots = live.filter { it.parentId == null || it.parentId !in ids }.sortedByDescending { it.updatedAt }
    fun model(s: RemoteSession) = state.profiles.find { it.first == s.profileId }?.second
    val subtitle = listOfNotNull(task.peer.name + if (task.peer.online) "" else "（离线）", "${live.size} 个会话", if (task.revoked) "授权已撤回" else null).joinToString(" · ")
    Column(Modifier.fillMaxSize()) {
        TopBar(task.title.ifBlank { "未命名任务" }, subtitle, back = back) { IconAction(AmoIcons.Refresh, "刷新", enabled = state.connected) { repo.refresh(force = true) } }
        Box(Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("sessions"), contentPadding = PaddingValues(bottom = 96.dp)) {
                if (task.description.isNotBlank()) item("description") {
                    SelectionContainer { Text(task.description, style = MaterialTheme.typography.bodySmall, color = c.dim, maxLines = if (descriptionOpen) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clickable { descriptionOpen = !descriptionOpen }.padding(horizontal = 16.dp, vertical = 12.dp)) }
                    HorizontalDivider(color = c.line)
                }
                fun LazyListScope.branch(s: RemoteSession, depth: Int) {
                    val kids = children[s.id].orEmpty().sortedByDescending { it.updatedAt }
                    item(s.id) {
                        val parts = listOfNotNull(sessionStatusLabel(s.state), when (s.kind) { "sub" -> "子代理"; "fork" -> "分支"; else -> null }, model(s), if (kids.isNotEmpty()) "${kids.size} 个子会话" else null)
                        ListRow(s.title.ifBlank { "未命名会话" }, parts.joinToString(" · "), toneOf(s.state), shortTime(s.updatedAt), tag = "session-row", indent = depth.coerceAtMost(3)) { repo.selectSession(s) }
                    }
                    if (kids.isNotEmpty()) {
                        val shown = s.id in open
                        item(s.id + "-kids") {
                            Row(Modifier.fillMaxWidth().clickable { if (shown) open.remove(s.id) else open.add(s.id) }.heightIn(min = 40.dp).padding(start = 16.dp + ((depth + 1).coerceAtMost(3) * 20).dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(if (shown) AmoIcons.ChevronDown else AmoIcons.ChevronRight, contentDescription = null, tint = c.dim, modifier = Modifier.size(16.dp))
                                Text(if (shown) "收起 ${kids.size} 个子会话" else "${kids.size} 个子会话" + (kids.count { it.state == "running" }.takeIf { it > 0 }?.let { "（$it 个在跑）" } ?: ""), style = MaterialTheme.typography.bodySmall, color = c.dim, modifier = Modifier.padding(start = 6.dp))
                            }
                        }
                        if (shown) kids.forEach { branch(it, depth + 1) }
                    }
                }
                roots.forEach { branch(it, 0) }
                if (live.isEmpty()) item("empty") { Empty("这个任务还没有会话。点右下角的「+」开一个。") }
                if (archived.isNotEmpty()) {
                    item("archived-head") {
                        Row(Modifier.fillMaxWidth().clickable { archivedOpen = !archivedOpen }.heightIn(min = 44.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (archivedOpen) AmoIcons.ChevronDown else AmoIcons.ChevronRight, contentDescription = null, tint = c.dim, modifier = Modifier.size(16.dp))
                            Text("已归档 ${archived.size} 个", style = MaterialTheme.typography.labelMedium, color = c.dim, modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                    if (archivedOpen) items(archived, key = { "a-" + it.id }) { s -> ListRow(s.title.ifBlank { "未命名会话" }, listOfNotNull("已归档", model(s)).joinToString(" · "), Tone.Quiet, shortTime(s.updatedAt), tag = "session-row") { repo.selectSession(s) } }
                }
            }
            Box(Modifier.align(Alignment.BottomEnd).padding(20.dp)) { Fab("新建会话", "session-create", state.connected && !state.busy && task.peer.online && !task.revoked, create) }
        }
    }
}

// ---- new task / new session

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun CreateSheet(state: StudioState, repo: StudioRepository, task: Boolean, close: () -> Unit) {
    var title by rememberSaveable(task) { mutableStateOf("") }
    var text by rememberSaveable(task) { mutableStateOf("") }
    var profile by rememberSaveable(task) { mutableStateOf("") }
    var project by rememberSaveable { mutableStateOf("") }
    var topic by rememberSaveable { mutableStateOf("") }
    val models = if (task) state.catalog?.objects("models").orEmpty().map { it.str("id") to it.str("label") } else state.profiles
    LaunchedEffect(models) { if (models.none { it.first == profile }) profile = models.firstOrNull()?.first ?: "" }
    val projects = state.catalog?.objects("projects").orEmpty().map { it.str("id") to it.str("name") }
    val common = state.catalog?.optBoolean("allowCommon") == true
    LaunchedEffect(projects) { if (project.isBlank() && !common) project = projects.firstOrNull()?.first ?: "" }
    val computers = state.peers.filter { it.role == "guest" && it.online }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 20.dp).padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (task) "新建任务" else "新会话 · ${state.selectedTask?.title ?: ""}", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (task) {
                if (computers.size > 1) Choice("电脑", computers.map { it.identity to it.name }, state.selectedPeer?.identity ?: "") { id -> computers.find { it.identity == id }?.let(repo::selectPeer) }
                Field(title, { title = it }, "任务名称（可不填）", "create-title")
                Choice("项目", (if (common) listOf("" to "公共目录") else emptyList()) + projects, project) { project = it }
                Choice("主题", listOf("" to "无主题") + state.catalog?.objects("topics").orEmpty().map { it.str("id") to it.str("title") }, topic) { topic = it }
            }
            Choice("模型", models, profile) { profile = it }
            OutlinedTextField(text, { text = it }, label = { Text("给模型的第一条消息") }, minLines = 3, maxLines = 8, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth().testTag("create-text"))
            if (models.isEmpty()) Text("电脑还没有允许手机用的模型，请在电脑的「远程」设置里打开。", style = MaterialTheme.typography.bodySmall, color = LocalAmoColors.current.attention)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                Text(if (task) "建好后马上开始第一个会话" else "在这个任务下开一个新会话", style = MaterialTheme.typography.bodySmall, color = LocalAmoColors.current.dim, modifier = Modifier.weight(1f))
                PrimaryButton(if (state.busy) "正在提交…" else "开始", "create-submit", state.connected && !state.busy && profile.isNotEmpty() && text.isNotBlank() && (!task || common || project.isNotBlank())) {
                    if (task) repo.createTask(title.trim(), text, project.ifBlank { null }, topic.ifBlank { null }, profile) else repo.startSession(profile, text)
                }
            }
        }
    }
}

// ---- 设置

@Composable private fun Settings(state: StudioState, repo: StudioRepository, back: () -> Unit) {
    val account = state.account ?: return
    val c = LocalAmoColors.current
    Column(Modifier.fillMaxSize()) {
        TopBar("设置", back = back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            SectionHeader("外观")
            listOf("light" to "浅色", "dark" to "深色", "system" to "跟随系统").forEach { (id, label) ->
                Row(Modifier.fillMaxWidth().clickable { repo.setTheme(id) }.heightIn(min = 48.dp).padding(horizontal = 8.dp).testTag("theme-$id"), verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = state.theme == id, onClick = { repo.setTheme(id) }); Text(label) }
            }
            SectionHeader("打开应用时")
            Row(Modifier.fillMaxWidth().clickable { repo.setResumeLast(!state.resumeLast) }.heightIn(min = 56.dp).padding(horizontal = 16.dp).testTag("resume-last"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text("回到上次的对话"); Text("关掉后每次从工作台开始", style = MaterialTheme.typography.bodySmall, color = c.dim) }
                Switch(state.resumeLast, { repo.setResumeLast(it) })
            }
            SectionHeader("电脑") { AmoTextButton(onClick = { repo.refresh(force = true) }, enabled = state.connected) { Text("刷新") } }
            state.peers.filter { it.role == "guest" }.forEach { p -> ListRow(p.name, "${if (p.online) "在线" else "离线"} · ${p.account}", if (p.online) Tone.Running else Tone.Quiet, tag = "peer-paired") { repo.selectPeer(p) } }
            Text("要配对的电脑", style = MaterialTheme.typography.labelSmall, color = c.dim, modifier = Modifier.padding(start = 16.dp, top = 12.dp))
            PairingList(state, repo)
            SectionHeader("更新")
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { UpdateSection(state.update, repo) }
            SectionHeader("账号")
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(account.name, style = MaterialTheme.typography.titleSmall)
                Text(account.server, style = MaterialTheme.typography.bodySmall, color = c.dim)
                Text("这台手机：${state.deviceName}", style = MaterialTheme.typography.bodySmall, color = c.dim)
                SecondaryButton("退出登录", "logout", modifier = Modifier.padding(top = 6.dp)) { repo.logout() }
            }
        }
    }
}

/** 设置 → 更新 (2026-10-31): this app's version, a newer one on the server with its notes, download progress, install. */
@Composable private fun UpdateSection(u: AppUpdate, repo: StudioRepository) {
    val c = LocalAmoColors.current
    Text("当前版本 ${repo.versionName}", color = c.dim, style = MaterialTheme.typography.bodySmall)
    val latest = u.latest
    if (latest == null) SecondaryButton(if (u.checking) "正在检查…" else "检查更新", "update-check", !u.checking) { repo.checkUpdate() }
    else {
        Text("新版本 ${latest.version} · ${"%.1f".format(latest.size / 1048576.0)} MB", style = MaterialTheme.typography.titleSmall)
        if (latest.notes.isNotBlank()) SelectionContainer { Text(latest.notes, style = MaterialTheme.typography.bodySmall) }
        when {
            u.downloading -> {
                LinearProgressIndicator(progress = { (u.downloaded.toFloat() / latest.size).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().testTag("update-progress"))
                Row(verticalAlignment = Alignment.CenterVertically) { Text("已下载 ${"%.1f".format(u.downloaded / 1048576.0)} / ${"%.1f".format(latest.size / 1048576.0)} MB", modifier = Modifier.weight(1f), color = c.dim, style = MaterialTheme.typography.bodySmall); AmoTextButton(onClick = repo::cancelUpdate) { Text("取消") } }
            }
            u.ready != null -> PrimaryButton("安装", "update-install") { repo.installUpdate() }
            else -> PrimaryButton("下载并安装", "update-download") { repo.downloadUpdate() }
        }
    }
    u.note?.let { Text(it, color = c.dim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("update-note")) }
}

// ---- 登录

@Composable private fun Login(state: StudioState, repo: StudioRepository) {
    var server by rememberSaveable { mutableStateOf("http://172.16.8.85:47120") }
    var name by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("AMO Studio", style = MaterialTheme.typography.headlineMedium)
        Text("登录团队账号，在电脑上确认配对后，就能在手机上看进度、回消息、审批。", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(4.dp))
        Field(server, { server = it }, "服务器地址", "login-server")
        Field(name, { name = it }, "账号", "login-name")
        OutlinedTextField(password, { password = it }, label = { Text("密码") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth().testTag("login-password"))
        PrimaryButton(if (state.busy) "正在登录…" else "登录", "login-submit", !state.busy && server.isNotBlank() && name.isNotBlank() && password.isNotBlank(), Modifier.fillMaxWidth()) { repo.login(server.trim(), name.trim(), password); password = "" }
        Text("在公司 Wi-Fi 或 Tailscale 上都连这个服务器地址。", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall)
    }
}
