package dev.amo.studio

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext

/**
 * The phone is only a guest device; every operation remains authorized by the remote Host.
 *
 * 2026-10-31 rewrite (plans/android-mobile-redesign.md): the connection, commands and file transfer are as before; what
 * changed is how much goes over the wire and how often. A session's history is fetched from where the phone's copy
 * ends (re-reading only what can still change: pending approvals and questions, running tools, streaming text), tasks
 * are fetched a few at a time and only on connect or coming back, pushed task and session changes are applied as they
 * come, and the copy is saved per session on a background thread (HistoryCache).
 */
class StudioRepository(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
    private val cacheRoot = File(app.filesDir, "remote-cache").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private val device = prefs.getString("device", null) ?: ("d_" + UUID.randomUUID().toString().replace("-", "").take(24)).also { prefs.edit().putString("device", it).apply() }
    private val mutable = MutableStateFlow(StudioState(theme = prefs.getString("theme", "light") ?: "light", resumeLast = prefs.getBoolean("resume-last", true)))
    val state: StateFlow<StudioState> = mutable.asStateFlow()
    private var socket: WebSocket? = null
    private var generation = 0
    private var retryJob: Job? = null
    private var attempt = 0
    private var closed = false
    private data class Pending(val peer: String, val result: CompletableDeferred<JSONObject>)
    private val pending = mutableMapOf<String, Pending>()
    /** rt.task answers by task key (peer/task). */
    private val snapshots = mutableMapOf<String, JSONObject>()
    /** Session histories in memory by peer/session; read from the cache when first opened. */
    private val histories = mutableMapOf<String, List<JSONObject>>()
    private var cache: HistoryCache? = null
    private val dirtySessions = mutableSetOf<String>()
    private var tasksDirty = false
    private var saveJob: Job? = null
    private var fileRequest = 0L
    private var mutationPending = false
    private var pushRevision = 0L
    private val itemRevisions = mutableMapOf<String, Long>()
    private var syncJob: Job? = null
    private var syncAgain = false
    private var lastSync = 0L
    private fun key(peer: Peer, id: String) = "${peer.identity}/$id"
    private fun update(f: (StudioState) -> StudioState) = mutable.update(f)
    private fun message(text: String?) = update { it.copy(message = text) }
    private class OperationEpoch(val value: Int) : AbstractCoroutineContextElement(Key) { companion object Key : CoroutineContext.Key<OperationEpoch> }
    private fun launch(block: suspend () -> Unit): Job {
        val epoch = generation
        return scope.launch(OperationEpoch(epoch)) { try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { if (epoch == generation) message(e.message ?: "操作失败") } }
    }
    private fun mutate(block: suspend () -> Unit) {
        if (mutationPending) { message("上一项操作尚未完成，请等待结果"); return }
        mutationPending = true
        update { it.copy(busy = true) }
        launch { try { block() } finally { mutationPending = false; update { it.copy(busy = false) } } }
    }

    init {
        runCatching {
            val saved = prefs.getString("account", null)?.let(::JSONObject)
            if (saved != null) {
                val account = Account(saved.getString("server"), saved.getString("name"), decrypt(saved.getString("token")))
                update { it.copy(account = account) }
                val epoch = generation
                launch { restoreCache(account); if (epoch == generation && state.value.account == account && !closed) connect() }
            }
        }.onFailure { prefs.edit().remove("account").apply(); message("保存的登录已失效，请重新登录") }
    }

    fun login(server: String, name: String, password: String) = launch {
        val epoch = generation
        update { it.copy(busy = true) }
        try {
            val entered = server.trim().trimEnd('/')
            val url = (if (entered.contains("://")) entered else "http://$entered").toHttpUrl()
            require(url.scheme in listOf("http", "https") && url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) { "服务器地址不正确" }
            val base = url.toString().trimEnd('/')
            val answer = http(base, null, "/api/login", JSONObject().put("name", name.trim()).put("password", password))
            if (epoch != generation || closed) return@launch
            val account = Account(base, answer.getString("name"), answer.getString("key"))
            val encrypted = encrypt(account.key)
            disconnect(); snapshots.clear(); histories.clear(); saveJob?.cancel()
            prefs.edit().putString("account", JSONObject().put("server", base).put("name", account.name).put("token", encrypted).toString()).apply()
            update { StudioState(account = account, theme = it.theme, resumeLast = it.resumeLast) }; restoreCache(account); connect()
        } finally { update { it.copy(busy = false) } }
    }

    // ---- updating the app from the team server (AppUpdate.kt, 2026-10-31)

    private var updateJob: Job? = null
    private fun setUpdate(f: (AppUpdate) -> AppUpdate) = update { it.copy(update = f(it.update)) }
    /** Asks the server for a newer build — only when the person taps 检查更新 (2026-10-31, the user: Tailscale on the phone is not steady enough to ask unasked). */
    fun checkUpdate() {
        val a = state.value.account ?: return
        if (state.value.update.checking || state.value.update.downloading) return
        setUpdate { it.copy(checking = true) }
        scope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { AppUpdates.latest(client, a) } }
            if (state.value.account != a) return@launch
            result.onSuccess { latest ->
                val newer = latest?.takeIf { it.versionCode > BuildConfig.VERSION_CODE }
                // Nothing newer: an APK downloaded before (now installed, or replaced on the server) is not needed.
                if (newer == null) withContext(Dispatchers.IO) { AppUpdates.dir(app).deleteRecursively() }
                setUpdate { u -> u.copy(checking = false, checkedAt = System.currentTimeMillis(), latest = newer, ready = u.ready?.takeIf { newer != null && it.name == newer.file }, note = when { newer != null -> null; latest == null -> "服务器上还没有发布安卓版"; else -> "已是最新版本" }) }
            }.onFailure { e -> setUpdate { it.copy(checking = false, checkedAt = System.currentTimeMillis(), note = e.message ?: "检查更新失败") } }
        }
    }
    fun downloadUpdate() {
        val a = state.value.account ?: return
        val latest = state.value.update.latest ?: return
        if (state.value.update.downloading) return
        setUpdate { it.copy(downloading = true, downloaded = 0, note = null) }
        updateJob = scope.launch {
            val result = runCatching { runInterruptible(Dispatchers.IO) { AppUpdates.download(client, app, a, latest) { n -> setUpdate { it.copy(downloaded = n) } } } }
            setUpdate { it.copy(downloading = false) }
            result.onSuccess { file -> setUpdate { it.copy(ready = file) }; installUpdate() }.onFailure { e -> if (e !is CancellationException) setUpdate { it.copy(note = e.message ?: "下载新版本失败") } }
        }
    }
    fun cancelUpdate() { updateJob?.cancel(); updateJob = null; setUpdate { it.copy(downloading = false, downloaded = 0) } }
    /** Android's installer for the downloaded APK — or first the page that allows this app to install apps. */
    fun installUpdate() {
        val file = state.value.update.ready ?: return
        val allowed = app.packageManager.canRequestPackageInstalls()
        setUpdate { it.copy(note = if (allowed) null else "请在打开的页面里允许 AMO Studio 安装应用，返回后再点「安装」") }
        runCatching { app.startActivity(AppUpdates.installIntent(app, file)) }.onFailure { e -> setUpdate { it.copy(note = "打不开安装界面：${e.message}") } }
    }

    fun logout() { flushNow(); disconnect(); snapshots.clear(); histories.clear(); cache = null; prefs.edit().remove("account").remove("last").apply(); update { StudioState(theme = it.theme, resumeLast = it.resumeLast) } }
    fun setTheme(theme: String) { if (theme !in listOf("light", "dark", "system")) return; prefs.edit().putString("theme", theme).apply(); update { it.copy(theme = theme) } }
    fun setResumeLast(on: Boolean) { prefs.edit().putBoolean("resume-last", on).apply(); update { it.copy(resumeLast = on) } }
    fun clearMessage() = message(null)
    fun retry() { attempt = 0; connect() }
    /** Coming back to the app, or 刷新: devices always, tasks when the last sync is a while ago (or `force`). */
    fun refresh(force: Boolean = false) = launch {
        refreshDevices()
        if (state.value.connected && (force || System.currentTimeMillis() - lastSync > 15_000)) syncAll()
    }
    fun requestPair(account: String, device: String? = null) = launch {
        val a = state.value.account ?: error("请先登录")
        val epoch = generation
        val body = JSONObject().put("device", this@StudioRepository.device).put("deviceName", state.value.deviceName).put("to", account.trim())
        if (device != null) body.put("toDevice", device)
        http(a.server, a.key, "/api/devices/pair", body)
        if (epoch != generation) return@launch
        refreshDevices()
        val paired = state.value.peers.any { it.account == account.trim() && (device == null || it.device == device) && it.role == "guest" }
        if (!paired) message("配对请求已发送，请在电脑上确认")
        else if (state.value.message == "配对请求已发送，请在电脑上确认") message(null)
    }

    private suspend fun http(server: String, token: String?, path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(server + path)
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) error(json.str("message", json.optJSONObject("error")?.str("message") ?: "服务器返回 ${response.code}"))
            json
        }
    }
    private suspend fun refreshDevices() {
        val a = state.value.account ?: return
        val epoch = generation
        val query = "?device=$device"
        val pairs = http(a.server, a.key, "/api/devices/pairs$query").objects("pairs").mapNotNull { row ->
            row.optJSONObject("peer")?.let { Peer(it.str("account"), it.str("device"), it.str("name"), row.optBoolean("online"), row.str("role", "guest")) }
        }
        val online = http(a.server, a.key, "/api/devices/online$query").objects("devices").map { Peer(a.name, it.str("device"), it.str("name"), true) }
        val requests = http(a.server, a.key, "/api/devices/pair$query").objects("outgoing")
        if (epoch != generation || state.value.account != a) return
        val wasOnline = state.value.peers.filter { it.online }.map { it.identity }.toSet()
        update { s ->
            fun refreshed(t: RemoteTask): RemoteTask = t.copy(peer = pairs.find { it.identity == t.peer.identity } ?: t.peer.copy(online = false), revoked = t.revoked || pairs.none { it.identity == t.peer.identity })
            val guests = pairs.filter { it.role == "guest" }
            // One computer: it is the one new tasks go to, without picking it first.
            val selected = pairs.find { it.identity == s.selectedPeer?.identity } ?: guests.singleOrNull()
            s.copy(peers = pairs, onlineDevices = online, pairing = requests, selectedPeer = selected, tasks = s.tasks.map(::refreshed), selectedTask = s.selectedTask?.let(::refreshed), message = if (s.message == "配对请求已发送，请在电脑上确认" && requests.none { it.str("state") == "pending" }) null else s.message)
        }
        // A computer that came online: what it granted may have changed meanwhile.
        if (state.value.connected && state.value.peers.any { it.online && it.role == "guest" && it.identity !in wasOnline }) syncAll()
        if (state.value.catalog == null) state.value.selectedPeer?.takeIf { it.online && state.value.connected }?.let { launch { fetchCatalog(it) } }
    }
    private fun disconnect() {
        generation++; retryJob?.cancel(); socket?.cancel(); socket = null; syncJob = null
        // Completing a deferred can resume its command immediately on Main.immediate; detach before callbacks run.
        val abandoned = pending.values.toList()
        pending.clear()
        abandoned.forEach { it.result.completeExceptionally(IllegalStateException("连接断了，结果未确认；请先同步状态再决定是否重试")) }
        update { it.copy(connected = false, connecting = false, loadingItems = false) }
    }
    private fun connect() {
        val a = state.value.account ?: return
        if (closed) return
        disconnect(); val epoch = generation
        update { it.copy(connecting = true) }
        val url = (a.server + "/api/devices/ws").toHttpUrl().newBuilder().addQueryParameter("device", device).addQueryParameter("name", state.value.deviceName).build()
        socket = client.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer ${a.key}").build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { scope.launch { if (epoch == generation) runCatching { take(JSONObject(text)) }.onFailure { message("收到无法处理的远程消息") } } }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { scope.launch { lost(epoch, code, null) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { scope.launch { lost(epoch, response?.code ?: 0, t.message) } }
        })
    }
    private fun lost(epoch: Int, code: Int, reason: String?) {
        if (epoch != generation || closed) return
        val unconfirmed = pending.isNotEmpty()
        disconnect()
        if (code == 401 || code == 403 || code == 4001) { message(if (code == 4001) "此设备连接被替换，请点重新连接" else "登录失效，请退出后重新登录"); return }
        if (unconfirmed) message("连接断开，操作结果未确认；正在重连，请先同步再决定是否重试")
        val wait = (1000L shl attempt.coerceAtMost(5)).coerceAtMost(30000L); attempt++
        retryJob = scope.launch { delay((wait * (0.8 + Math.random() * 0.4)).toLong()); connect() }
    }
    private suspend fun take(event: JSONObject) {
        when (event.str("type")) {
            "hello" -> {
                val me = event.optJSONObject("me") ?: return
                check(event.optInt("version") == 1 && me.str("device") == device && me.str("account") == state.value.account?.name) { "服务器设备协议不兼容" }
                attempt = 0; update { it.copy(connected = true, connecting = false, message = if (it.message?.startsWith("连接断开") == true) null else it.message) }
                launch { refreshDevices(); syncAll() }
            }
            "relay-error" -> pending.remove(event.str("id"))?.result?.completeExceptionally(IllegalStateException(event.str("message", "远端无法连接")))
            "relay" -> {
                val from = event.optJSONObject("from") ?: return
                val peer = state.value.peers.find { it.account == from.str("account") && it.device == from.str("device") && it.role == "guest" } ?: return
                val p = pending[event.str("re")]
                if (p != null && p.peer == peer.identity) {
                    pending.remove(event.str("re"))
                    if (event.str("kind") == "rt.ok") p.result.complete(event.optJSONObject("body") ?: JSONObject())
                    else p.result.completeExceptionally(IllegalStateException(event.optJSONObject("body")?.str("message", "远端操作失败") ?: "远端操作失败"))
                } else if (event.str("kind") == "rt.push") push(peer, event.optJSONObject("body") ?: return)
            }
            // Who is online changed: the device list says so; tasks are fetched again only for a computer that came back.
            "presence", "pair-request-closed" -> launch { refreshDevices() }
            "pair-answered", "unpaired" -> launch { refreshDevices(); if (state.value.connected) syncAll() }
        }
    }
    private suspend fun command(peer: Peer, kind: String, body: JSONObject = JSONObject()): JSONObject {
        val epoch = generation
        // An onResume refresh can overlap initial connection setup; discard that obsolete read silently.
        if (coroutineContext[OperationEpoch]?.value?.let { it != epoch } == true) throw CancellationException("Obsolete connection operation")
        check(state.value.connected && state.value.peers.any { it.identity == peer.identity && it.online && it.role == "guest" }) { "远端离线或配对已撤回" }
        val id = "c_" + UUID.randomUUID().toString().replace("-", "")
        val result = CompletableDeferred<JSONObject>(); pending[id] = Pending(peer.identity, result)
        val frame = JSONObject().put("type", "relay").put("to", JSONObject().put("account", peer.account).put("device", peer.device)).put("id", id).put("kind", kind).put("body", body)
        try {
            check(socket?.send(frame.toString()) == true) { "未连接团队服务器" }
            val answer = withTimeout(30000) { result.await() }
            check(epoch == generation) { "连接已切换，此操作结果未确认" }
            return answer
        } catch (e: TimeoutCancellationException) { error("远端没有回音，结果未确认；请先刷新再决定是否重试") }
        finally { pending.remove(id) }
    }

    /** Every granted task again, a few at a time; a second call while one runs makes it go once more after. */
    private suspend fun syncAll() {
        if (syncJob?.isActive == true) { syncAgain = true; syncJob?.join(); return }
        val job = launch { do { syncAgain = false; syncOnce() } while (syncAgain) }
        syncJob = job
        job.join()
    }
    private suspend fun syncOnce() {
        val epoch = generation
        lastSync = System.currentTimeMillis()
        for (peer in state.value.peers.filter { it.role == "guest" && it.online }) {
            if (epoch != generation) return
            try {
                val list = command(peer, "rt.list")
                val ids = list.objects("tasks").map { it.str("taskId") }.toSet()
                update { s -> s.copy(
                    tasks = s.tasks.map { if (it.peer.identity == peer.identity && it.id !in ids) it.copy(revoked = true) else it },
                    selectedTask = s.selectedTask?.let { if (it.peer.identity == peer.identity && it.id !in ids) it.copy(revoked = true) else it },
                ) }
                val gate = Semaphore(3)
                coroutineScope { ids.map { id -> async { gate.withPermit { fetchTask(peer, id) } } }.awaitAll() }
            } catch (e: Exception) { if (e is CancellationException) throw e; if (epoch != generation) return; message(e.message) }
        }
        if (epoch != generation) return
        state.value.selectedPeer?.takeIf { it.online }?.let { runCatching { fetchCatalog(it) } }
        state.value.selectedSession?.let { fetchItems(it.id) }
    }
    private fun session(row: JSONObject) = RemoteSession(
        row.str("id"), row.str("title"), row.str("status"), row.str("profileId"), !row.isNull("archivedAt") || row.str("writer") == "archived",
        kind = row.str("kind", "main"), parentId = row.str("startedBy").ifBlank { row.str("parentId") }.ifBlank { null }, updatedAt = row.str("updatedAt"),
    )
    private fun profiles(snapshot: JSONObject): List<Pair<String, String>> {
        val a = snapshot.optJSONArray("allowed") ?: JSONArray()
        val allowed = (0 until a.length()).map { a.optString(it) }.toSet()
        return snapshot.objects("profiles").filter { it.str("id") in allowed }.map { it.str("id") to it.str("label") }
    }
    private fun taskOf(peer: Peer, id: String, snapshot: JSONObject, revoked: Boolean = false): RemoteTask {
        val row = snapshot.optJSONObject("task") ?: JSONObject()
        return RemoteTask(id, row.str("title"), peer, revoked, row.str("description"), row.str("updatedAt"), snapshot.objects("sessions").map(::session))
    }
    /** Puts a task (new or changed) into the state, keeping what is selected in step. */
    private fun putTask(task: RemoteTask, snapshot: JSONObject?) {
        update { s ->
            val selected = s.selectedTask?.key == task.key
            s.copy(
                tasks = s.tasks.filterNot { it.key == task.key } + task,
                selectedTask = if (selected) task else s.selectedTask,
                sessions = if (selected) task.sessions else s.sessions,
                selectedSession = if (selected) task.sessions.find { it.id == s.selectedSession?.id } ?: s.selectedSession else s.selectedSession,
                profiles = if (selected && snapshot != null) profiles(snapshot) else s.profiles,
            )
        }
        markTasks()
    }
    private suspend fun fetchTask(peer: Peer, id: String) {
        val snapshot = command(peer, "rt.task", JSONObject().put("taskId", id)); snapshots[key(peer, id)] = snapshot
        putTask(taskOf(peer, id, snapshot), snapshot)
    }
    private suspend fun fetchCatalog(peer: Peer) {
        val catalog = command(peer, "rt.catalog")
        if (state.value.selectedPeer?.identity == peer.identity) update { it.copy(catalog = catalog, profiles = if (it.selectedTask == null) catalog.objects("models").map { m -> m.str("id") to m.str("label") } else it.profiles) }
    }
    fun selectPeer(peer: Peer) { update { it.copy(selectedPeer = peer, catalog = null) }; if (peer.online && state.value.connected) launch { fetchCatalog(peer) } }
    /** The home page: nothing selected, but the computer stays (new tasks go there). */
    fun leaveTask() { update { it.copy(selectedTask = null, selectedSession = null, sessions = emptyList(), items = emptyList(), profiles = it.catalog?.objects("models")?.map { m -> m.str("id") to m.str("label") } ?: emptyList()) } }
    fun selectTask(task: RemoteTask) {
        val snapshot = snapshots[key(task.peer, task.id)]
        update { it.copy(selectedPeer = task.peer, selectedTask = task, selectedSession = null, items = emptyList(), sessions = task.sessions, profiles = snapshot?.let(::profiles) ?: emptyList()) }
        if (!task.revoked && task.peer.online && state.value.connected) launch { fetchTask(task.peer, task.id) }
    }
    fun selectSession(session: RemoteSession) {
        val task = state.value.selectedTask ?: return
        val k = key(task.peer, session.id)
        val known = histories[k]
        update { it.copy(selectedSession = session, items = known ?: emptyList(), loadingItems = known == null) }
        prefs.edit().putString("last", JSONObject().put("peer", task.peer.identity).put("task", task.id).put("session", session.id).toString()).apply()
        launch {
            if (known == null) {
                val saved = cache?.let { c -> withContext(Dispatchers.IO) { c.loadSession(k) } } ?: emptyList()
                if (state.value.selectedSession?.id == session.id && state.value.items.isEmpty() && saved.isNotEmpty()) { histories[k] = saved; update { it.copy(items = saved) } }
            }
            if (state.value.connected && state.value.selectedTask?.peer?.online == true) fetchItems(session.id) else update { it.copy(loadingItems = false) }
        }
    }
    /** Opens a session of the selected task by id (a subagent row, the 等你处理 list). */
    fun openSession(sessionId: String) { state.value.sessions.find { it.id == sessionId }?.let(::selectSession) }
    /** The conversation open last time (peer identity, task id, session id), when there is one. */
    fun lastLocation(): Triple<String, String, String>? = runCatching { prefs.getString("last", null)?.let(::JSONObject)?.let { Triple(it.str("peer"), it.str("task"), it.str("session")) } }.getOrNull()

    private fun unsettled(row: JSONObject) = when (row.str("type")) {
        "approval", "question" -> row.str("state") == "pending"
        "tool" -> row.str("status") == "running"
        "agent", "reasoning" -> row.optBoolean("streaming")
        "compaction" -> row.str("state") == "running"
        else -> false
    }
    /** From where the phone's copy ends — or from the oldest item that could still have changed while it was away. */
    private suspend fun fetchItems(sessionId: String) {
        val task = state.value.selectedTask ?: return
        if (task.revoked) return
        val k = key(task.peer, sessionId)
        val known = histories[k] ?: emptyList()
        val last = known.maxOfOrNull { it.optLong("seq") } ?: 0L
        val open = known.filter(::unsettled).minOfOrNull { it.optLong("seq") }
        var since = if (open != null) maxOf(0L, open - 1) else last
        val collected = linkedMapOf<String, JSONObject>(); val revision = pushRevision
        try {
            do {
                val page = command(task.peer, "rt.items", JSONObject().put("sessionId", sessionId).put("since", since))
                val rows = page.objects("items")
                val before = since
                for (row in rows) { collected[row.str("id")] = row; since = maxOf(since, row.optLong("seq")) }
                check(!page.optBoolean("more") || since > before) { "远端历史分页没有进展" }
            } while (page.optBoolean("more"))
        } finally { if (state.value.selectedSession?.id == sessionId) update { it.copy(loadingItems = false) } }
        val current = if (state.value.selectedSession?.id == sessionId && state.value.selectedTask?.peer?.identity == task.peer.identity) state.value.items else histories[k] ?: known
        val merged = LinkedHashMap<String, JSONObject>()
        for (row in current) merged[row.str("id")] = row
        for ((id, row) in collected) {
            // A push newer than this read wins over it.
            if ((itemRevisions[key(task.peer, id)] ?: 0L) > revision && merged.containsKey(id)) continue
            merged[id] = row
        }
        val rows = merged.values.sortedBy { it.optLong("seq") }
        histories[k] = rows
        if (state.value.selectedSession?.id == sessionId && state.value.selectedTask?.peer?.identity == task.peer.identity) update { it.copy(items = rows) }
        markSession(k)
    }
    private fun active(): RemoteTask = (state.value.selectedTask ?: error("请先选择任务")).also { check(!it.revoked) { "任务授权已撤回" } }
    fun createTask(title: String, text: String, workspaceId: String?, topicId: String?, profileId: String) = mutate {
        val peer = state.value.selectedPeer ?: error("请先选择电脑")
        val answer = command(peer, "rt.create", JSONObject().put("title", title).put("text", text).put("workspaceId", workspaceId ?: JSONObject.NULL).put("topicId", topicId ?: JSONObject.NULL).put("profileId", profileId))
        if (answer.has("waiting")) message("已提交，等待电脑确认")
        else if (answer.has("error")) message(answer.str("error"))
        val id = answer.str("taskId")
        if (id.isNotEmpty()) {
            fetchTask(peer, id)
            state.value.tasks.find { it.id == id && it.peer.identity == peer.identity }?.let { created ->
                selectTask(created)
                state.value.sessions.find { it.id == answer.str("sessionId") }?.let(::selectSession)
            }
        }
    }
    fun startSession(profileId: String, text: String) = mutate {
        val task = active(); check(state.value.profiles.any { it.first == profileId }) { "这个模型未获远端允许" }
        val result = command(task.peer, "rt.start", JSONObject().put("taskId", task.id).put("profileId", profileId).put("text", text)); fetchTask(task.peer, task.id)
        if (state.value.selectedTask?.key == task.key) result.optJSONObject("session")?.let { selectSession(session(it)) }
    }
    private fun sessionCommand(kind: String, extra: JSONObject = JSONObject()) = mutate {
        val task = active(); val session = state.value.selectedSession ?: error("请先选择会话")
        check(!session.archived) { "会话已归档" }
        command(task.peer, kind, extra.put("sessionId", session.id))
        // What it changed comes back as pushes; a read from the open items on settles anything missed.
        if (state.value.selectedTask?.key == task.key && state.value.selectedSession?.id == session.id) fetchItems(session.id)
    }
    fun send(text: String) = sessionCommand("rt.send", JSONObject().put("text", text))
    fun approve(item: JSONObject, decision: String) = sessionCommand("rt.approve", JSONObject().put("approvalId", item.str("approvalId", item.str("id"))).put("decision", decision))
    fun answer(item: JSONObject, reply: JSONObject) = sessionCommand("rt.answer", JSONObject().put("itemId", item.str("id")).put("reply", reply))
    fun interrupt() = sessionCommand("rt.interrupt")

    private fun push(peer: Peer, body: JSONObject) {
        val task = state.value.selectedTask
        when (body.str("type")) {
            "revoked" -> update { s -> s.copy(tasks = s.tasks.map { if (it.id == body.str("taskId") && it.peer.identity == peer.identity) it.copy(revoked = true) else it }, selectedTask = s.selectedTask?.let { if (it.id == body.str("taskId") && it.peer.identity == peer.identity) it.copy(revoked = true) else it }, message = body.str("reason", "任务授权已撤回")).also { markTasks() } }
            "granted" -> launch { fetchTask(peer, body.str("taskId")) }
            "request" -> {
                val request = body.optJSONObject("request")
                message(when (request?.str("state")) { "accepted" -> "电脑已允许创建任务"; "refused" -> "电脑拒绝了创建请求：${request.str("reason")}"; else -> "创建任务正在等待电脑确认" })
                launch { syncAll() }
            }
            // Applied as they come (2026-10-31): no task is fetched again for a renamed task or a session's new status.
            "task" -> {
                val view = body.optJSONObject("task") ?: return
                val k = key(peer, view.str("id"))
                val snapshot = snapshots[k] ?: return
                snapshot.put("task", view); body.optJSONArray("profiles")?.let { snapshot.put("profiles", it) }; body.optJSONArray("allowed")?.let { snapshot.put("allowed", it) }
                val old = state.value.tasks.find { it.key == k } ?: return
                putTask(taskOf(peer, view.str("id"), snapshot, old.revoked), snapshot)
            }
            "session" -> {
                val row = body.optJSONObject("session") ?: return
                val k = key(peer, row.str("taskId"))
                val snapshot = snapshots[k]
                val old = state.value.tasks.find { it.key == k }
                if (snapshot == null || old == null) { if (old == null && row.str("taskId").isNotBlank()) launch { fetchTask(peer, row.str("taskId")) }; return }
                val list = snapshot.objects("sessions").filterNot { it.str("id") == row.str("id") } + row
                snapshot.put("sessions", JSONArray(list))
                putTask(taskOf(peer, old.id, snapshot, old.revoked), null)
            }
            "catalog" -> if (state.value.selectedPeer?.identity == peer.identity) {
                val catalog = body.optJSONObject("catalog") ?: return
                update { it.copy(catalog = catalog, profiles = if (it.selectedTask == null) catalog.objects("models").map { m -> m.str("id") to m.str("label") } else it.profiles) }
            }
            "item" -> {
                val row = body.optJSONObject("item") ?: return
                val k = key(peer, row.str("sessionId"))
                val open = task?.peer?.identity == peer.identity && !task.revoked && row.str("sessionId") == state.value.selectedSession?.id
                if (!open && !histories.containsKey(k)) return
                val rows = if (open) state.value.items else histories[k]!!
                val last = rows.maxOfOrNull { it.optLong("seq") } ?: 0
                itemRevisions[key(peer, row.str("id"))] = ++pushRevision
                val index = rows.indexOfFirst { it.str("id") == row.str("id") }
                val next = if (index >= 0) rows.toMutableList().also { it[index] = row } else (rows + row).let { l -> if (row.optLong("seq") >= last) l else l.sortedBy { it.optLong("seq") } }
                histories[k] = next
                if (open) update { it.copy(items = next) }
                markSession(k)
                if (open && row.optLong("seq") > last + 1) launch { fetchItems(row.str("sessionId")) }
            }
            "delta" -> {
                val sessionId = body.str("sessionId")
                if (task?.peer?.identity != peer.identity || task.revoked || sessionId != state.value.selectedSession?.id) return
                val rows = state.value.items
                val index = rows.indexOfFirst { it.str("id") == body.str("itemId") }
                if (index < 0) { launch { fetchItems(sessionId) }; return }
                itemRevisions[key(peer, body.str("itemId"))] = ++pushRevision
                val row = rows[index]
                val field = if (row.str("type") == "agent") "markdown" else "text"
                // A shallow copy: the old row stays as it was (Entry compares by identity).
                val copy = JSONObject(); for (name in row.keys()) copy.put(name, row.opt(name))
                copy.put(field, row.str(field) + body.str("append"))
                val next = rows.toMutableList().also { it[index] = copy }
                histories[key(peer, sessionId)] = next
                update { it.copy(items = next) }
                markSession(key(peer, sessionId))
            }
        }
    }
    fun openFile(path: String, cwd: String? = null) = launch {
        val fileEpoch = ++fileRequest
        update { it.copy(fileLoading = path) }
        try {
        require(path.isNotBlank() && path.length <= 2000) { "文件路径不正确" }
        val task = active(); val output = ByteArrayOutputStream(); var meta: JSONObject? = null; var hash = ""
        do {
            val ask = JSONObject().put("taskId", task.id).put("path", path).put("offset", output.size())
            cwd?.takeIf { it.isNotBlank() }?.let { ask.put("cwd", it) }
            meta?.let { ask.put("expect", JSONObject().put("size", it.getLong("size")).put("mtime", it.getLong("mtime"))) }
            val chunk = command(task.peer, "rt.file", ask)
            val size = chunk.getLong("size"); val rel = chunk.getString("rel")
            check(size in 0..(20L * 1024 * 1024) && !rel.startsWith('/') && !rel.contains('\\') && rel.split('/').none { it == ".." || it.contains(':') }) { "远端文件超出允许范围" }
            check(chunk.optInt("offset", -1) == output.size()) { "远端文件分块顺序不正确" }
            if (meta == null) { meta = chunk; hash = chunk.str("sha256") }
            else check(size == meta!!.getLong("size") && rel == meta!!.str("rel") && chunk.getLong("mtime") == meta!!.getLong("mtime")) { "传输中文件发生变化，请重新打开" }
            val bytes = Base64.decode(chunk.getString("data"), Base64.DEFAULT)
            check(bytes.size <= 512 * 1024 && output.size() + bytes.size <= size && (bytes.isNotEmpty() || size == 0L)) { "远端文件分块不正确" }
            output.write(bytes)
        } while (output.size().toLong() < meta!!.getLong("size"))
        val bytes = output.toByteArray(); val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        check(hash == digest) { "文件完整性校验失败" }
        val rel = meta!!.str("rel"); val kind = meta!!.str("kind")
        check(kind in listOf("html", "markdown", "image", "text")) { "不支持这个文件类型" }
        val mime = when (kind) { "html" -> "text/html"; "markdown" -> "text/markdown"; "image" -> when(rel.substringAfterLast('.').lowercase()) { "svg" -> "image/svg+xml"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"; else -> "image/png" }; else -> "text/plain" }
        if (fileEpoch == fileRequest && state.value.selectedTask?.let { it.id == task.id && it.peer.identity == task.peer.identity && !it.revoked } == true) update { it.copy(file = ViewedFile(rel.substringAfterLast('/'), kind, mime, bytes, rel)) }
        } finally { if (fileEpoch == fileRequest) update { it.copy(fileLoading = null) } }
    }
    fun closeFile() { fileRequest++; update { it.copy(file = null, fileLoading = null) } }
    fun close() { flushNow(); closed = true; disconnect(); scope.cancel(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }

    // ---- the phone's copy (HistoryCache)

    private fun markSession(k: String) { dirtySessions += k; scheduleSave() }
    private fun markTasks() { tasksDirty = true; scheduleSave() }
    /** Saved a while after the last change (a streamed reply saves once it pauses), on a background thread. */
    private fun scheduleSave() {
        if (saveJob?.isActive == true) return
        saveJob = scope.launch { delay(1500); flush() }
    }
    private fun pendingWrites(): Pair<JSONObject?, List<Pair<String, List<JSONObject>>>> {
        // The lists and rows are never changed in place, so they can be written from another thread.
        val tasksRoot = if (tasksDirty) tasksJson() else null
        val sessions = dirtySessions.mapNotNull { k -> histories[k]?.let { k to it } }
        tasksDirty = false; dirtySessions.clear()
        return tasksRoot to sessions
    }
    private suspend fun flush() {
        val c = cache ?: return
        val (tasksRoot, sessions) = pendingWrites()
        withContext(Dispatchers.IO) { runCatching { tasksRoot?.let(c::saveTasks); sessions.forEach { (k, rows) -> c.saveSession(k, rows) } } }
    }
    private fun flushNow() {
        val c = cache ?: return
        saveJob?.cancel()
        val (tasksRoot, sessions) = pendingWrites()
        if (tasksRoot == null && sessions.isEmpty()) return
        // Going away: written on a thread of its own, so leaving the app is not held up.
        Thread { runCatching { tasksRoot?.let(c::saveTasks); sessions.forEach { (k, rows) -> c.saveSession(k, rows) } } }.start()
    }
    /** Called when the app goes to the background. */
    fun persist() = flushNow()
    private fun tasksJson(): JSONObject {
        val root = JSONObject().put("version", 2)
        root.put("tasks", JSONArray(state.value.tasks.map { t -> JSONObject().put("id", t.id).put("revoked", t.revoked).put("account", t.peer.account).put("device", t.peer.device).put("name", t.peer.name).put("role", t.peer.role) }))
        root.put("snapshots", JSONObject(snapshots.toMap()))
        return root
    }
    private suspend fun restoreCache(account: Account) {
        val epoch = generation
        val c = HistoryCache(cacheRoot, account); cache = c
        val root = withContext(Dispatchers.IO) { c.loadTasks() } ?: return
        if (epoch != generation || state.value.account != account || closed) return
        runCatching {
            root.optJSONObject("snapshots")?.let { o -> for (id in o.keys()) o.optJSONObject(id)?.let { snapshots[id] = it } }
            val tasks = root.objects("tasks").mapNotNull { t ->
                val peer = Peer(t.str("account"), t.str("device"), t.str("name"), false, t.str("role", "guest"))
                snapshots[key(peer, t.str("id"))]?.let { taskOf(peer, t.str("id"), it, t.optBoolean("revoked")) }
            }
            val cachedPeers = tasks.map { it.peer }.filter { it.role == "guest" }.distinctBy { it.identity }
            update { it.copy(tasks = tasks, peers = if (it.peers.isEmpty()) cachedPeers else it.peers) }
        }
    }

    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("amo-studio-token", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("amo-studio-token", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }
    private fun decrypt(text: String): String {
        val bytes = Base64.decode(text, Base64.NO_WRAP); require(bytes.size > 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
}
