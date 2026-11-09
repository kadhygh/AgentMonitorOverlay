package dev.amo.studio

import androidx.compose.runtime.Immutable
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.daysUntil
import kotlinx.datetime.number
import kotlinx.datetime.toLocalDateTime

data class Account(val server: String, val name: String, val key: String)
data class Peer(val account: String, val device: String, val name: String, val online: Boolean, val role: String = "guest") {
    val identity: String get() = "$account/$device"
}
/** A task a paired computer granted this phone; `sessions` from its last snapshot (2026-10-31: the home list shows their state). */
data class RemoteTask(
    val id: String,
    val title: String,
    val peer: Peer,
    val revoked: Boolean = false,
    val description: String = "",
    val updatedAt: String = "",
    val sessions: List<RemoteSession> = emptyList(),
    /** Its project on the computer, as shown (2026-11-09): the name, 「未指定项目」 for the common folder; null where an older computer does not say. */
    val project: String? = null,
) {
    val key: String get() = "${peer.identity}/$id"
    /** Newest activity of the task or any of its sessions (ISO times compare as text). */
    val activeAt: String get() = (sessions.map { it.updatedAt } + updatedAt).maxOrNull() ?: ""
}
data class RemoteSession(
    val id: String,
    val title: String,
    val state: String,
    val profileId: String,
    val archived: Boolean = false,
    val kind: String = "main",
    /** The session it hangs under: a subagent's or fork's parent, or the one that started it (session_start). */
    val parentId: String? = null,
    val updatedAt: String = "",
    /** The project it works in, as shown (2026-11-09); null where the computer does not say. */
    val project: String? = null,
)
data class StudioState(
    val account: Account? = null,
    val deviceName: String = "Android 手机",
    val connected: Boolean = false,
    val connecting: Boolean = false,
    val busy: Boolean = false,
    val message: String? = null,
    val peers: List<Peer> = emptyList(),
    val onlineDevices: List<Peer> = emptyList(),
    val pairing: List<JSONObject> = emptyList(),
    val tasks: List<RemoteTask> = emptyList(),
    val selectedPeer: Peer? = null,
    val selectedTask: RemoteTask? = null,
    val sessions: List<RemoteSession> = emptyList(),
    val selectedSession: RemoteSession? = null,
    val items: List<JSONObject> = emptyList(),
    /** The selected session's history is being fetched (shown while there is nothing cached yet). */
    val loadingItems: Boolean = false,
    val catalog: JSONObject? = null,
    val profiles: List<Pair<String, String>> = emptyList(),
    val file: ViewedFile? = null,
    val fileLoading: String? = null,
    val theme: String = "light",
    val update: AppUpdate = AppUpdate(),
    /** Open the last conversation when the app starts (设置). */
    val resumeLast: Boolean = true,
)
data class ViewedFile(val name: String, val kind: String, val mime: String, val bytes: ByteArray, val path: String)

/**
 * One session item for the screen. The JSON is never changed after it arrives (a streamed delta makes a new one), so
 * comparing by identity is enough for Compose to skip rows that did not change (2026-10-31: the old list redrew every
 * row on every streamed character).
 */
@Immutable class Entry(val json: JSONObject) {
    val id: String = json.str("id")
    val type: String = json.str("type")
    val seq: Long = json.optLong("seq")
    override fun equals(other: Any?) = other is Entry && other.json === json
    // JSONObject keeps identity equality (Json.kt), so its hashCode is the identity one.
    override fun hashCode() = json.hashCode()
}

fun JSONObject.str(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
fun JSONObject.objects(key: String): List<JSONObject> = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } } ?: emptyList()

fun sessionStatusLabel(status: String): String = when (status) {
    "running" -> "进行中"
    "awaiting-approval" -> "等你审批"
    "awaiting-answer" -> "等你回答"
    "awaiting-review" -> "等你查看"
    "idle" -> "空闲"
    "completed" -> "已完成"
    "interrupted" -> "已中断"
    "error" -> "出错"
    else -> status
}

/** What a session's status asks of the person: attention, running, error or nothing. */
enum class Tone { Attention, Running, Error, Quiet }
fun toneOf(status: String): Tone = when (status) {
    "awaiting-approval", "awaiting-answer", "awaiting-review" -> Tone.Attention
    "running" -> Tone.Running
    "error" -> Tone.Error
    else -> Tone.Quiet
}
fun needsYou(status: String) = status == "awaiting-approval" || status == "awaiting-answer"

fun toolStatusLabel(status: String): String = when (status) {
    "running" -> "进行中"
    "completed" -> "完成"
    "failed" -> "失败"
    "declined" -> "被拒绝"
    else -> status
}
fun approvalStateLabel(state: String): String = when (state) {
    "pending" -> "等你审批"
    "accepted" -> "已允许"
    "declined" -> "已拒绝"
    "resolved-elsewhere" -> "在别处处理了"
    else -> state
}
fun questionStateLabel(state: String): String = when (state) {
    "pending" -> "等你回答"
    "answered" -> "已回答"
    "dismissed" -> "暂不回答"
    "cancelled" -> "已取消"
    else -> state
}

/** "10:42", "昨天 10:42" or "10-29" for an ISO time; "" when there is none. */
@OptIn(ExperimentalTime::class)
fun shortTime(iso: String, now: Instant = Clock.System.now(), zone: TimeZone = TimeZone.currentSystemDefault()): String {
    if (iso.isBlank()) return ""
    val at = runCatching { Instant.parse(iso) }.getOrNull()?.toLocalDateTime(zone) ?: return ""
    val days = at.date.daysUntil(now.toLocalDateTime(zone).date)
    fun two(n: Int) = n.toString().padStart(2, '0')
    val hm = "${two(at.hour)}:${two(at.minute)}"
    return when (days) { 0 -> hm; 1 -> "昨天 $hm"; else -> "${two(at.month.number)}-${two(at.day)}" }
}
