package dev.amo.studio

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

// The phone's copy of what paired computers showed it (2026-10-31 rewrite). The old cache was one JSON of every task
// and every session's history, built on the main thread after every streamed character; past 8 MiB it stopped saving.
// Now: one file for the tasks and their snapshots, one file per session, written on a background thread and only for
// what changed. Account keys never go here (they stay in the encrypted preference).
internal class HistoryCache(root: File, account: Account) {
    private val dir = File(root, sha("${account.server}\n${account.name}")).apply { mkdirs() }
    private val sessions = File(dir, "sessions").apply { mkdirs() }

    private fun sessionFile(key: String) = File(sessions, "${sha(key)}.json")

    fun loadTasks(): JSONObject? = runCatching { File(dir, "tasks.json").takeIf { it.exists() }?.readText(Charsets.UTF_8)?.let(::JSONObject) }.getOrNull()

    fun saveTasks(root: JSONObject) = write(File(dir, "tasks.json"), root.toString())

    /** A session's items as saved, oldest first; empty when none. */
    fun loadSession(key: String): List<JSONObject> = runCatching {
        val file = sessionFile(key)
        if (!file.exists()) emptyList() else JSONArray(file.readText(Charsets.UTF_8)).let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }
    }.getOrDefault(emptyList())

    fun saveSession(key: String, items: List<JSONObject>) {
        write(sessionFile(key), JSONArray(items.takeLast(MAX_ITEMS)).toString())
        prune()
    }

    /** Only the newest sessions are kept: the computer has the rest and gives them again when asked. */
    private fun prune() {
        val files = sessions.listFiles { f -> f.name.endsWith(".json") } ?: return
        if (files.size <= MAX_SESSIONS) return
        files.sortedByDescending { it.lastModified() }.drop(MAX_SESSIONS).forEach { it.delete() }
    }

    private fun write(target: File, text: String) {
        val temporary = File(target.parentFile, target.name + ".tmp")
        temporary.writeText(text, Charsets.UTF_8)
        if (!temporary.renameTo(target)) { target.delete(); temporary.renameTo(target) }
    }

    companion object {
        const val MAX_ITEMS = 3000
        const val MAX_SESSIONS = 60
        fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
