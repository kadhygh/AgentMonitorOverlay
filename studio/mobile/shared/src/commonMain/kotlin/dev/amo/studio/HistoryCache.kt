package dev.amo.studio

import okio.ByteString.Companion.encodeUtf8
import okio.FileSystem
import okio.Path

// The phone's copy of what paired computers showed it (2026-10-31 rewrite). The old cache was one JSON of every task
// and every session's history, built on the main thread after every streamed character; past 8 MiB it stopped saving.
// Now: one file for the tasks and their snapshots, one file per session, written on a background thread and only for
// what changed. Account keys never go here (they stay in the encrypted preference). 2026-11-02: okio instead of
// java.io, to be shared with iOS; the folder and file names are the same as before.
internal class HistoryCache(private val fs: FileSystem, root: Path, account: Account) {
    private val dir = (root / sha("${account.server}\n${account.name}")).also { fs.createDirectories(it) }
    private val sessions = (dir / "sessions").also { fs.createDirectories(it) }

    private fun sessionFile(key: String) = sessions / "${sha(key)}.json"

    fun loadTasks(): JSONObject? = runCatching { (dir / "tasks.json").takeIf { fs.exists(it) }?.let { JSONObject(fs.read(it) { readUtf8() }) } }.getOrNull()

    fun saveTasks(root: JSONObject) = write(dir / "tasks.json", root.toString())

    /** A session's items as saved, oldest first; empty when none. */
    fun loadSession(key: String): List<JSONObject> = runCatching {
        val file = sessionFile(key)
        if (!fs.exists(file)) emptyList() else JSONArray(fs.read(file) { readUtf8() }).let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }
    }.getOrDefault(emptyList())

    fun saveSession(key: String, items: List<JSONObject>) {
        write(sessionFile(key), JSONArray(items.takeLast(MAX_ITEMS)).toString())
        prune()
    }

    /** Only the newest sessions are kept: the computer has the rest and gives them again when asked. */
    private fun prune() {
        val files = runCatching { fs.list(sessions).filter { it.name.endsWith(".json") } }.getOrNull() ?: return
        if (files.size <= MAX_SESSIONS) return
        files.sortedByDescending { fs.metadataOrNull(it)?.lastModifiedAtMillis ?: 0L }.drop(MAX_SESSIONS).forEach { fs.delete(it, mustExist = false) }
    }

    private fun write(target: Path, text: String) {
        val temporary = target.parent!! / (target.name + ".tmp")
        fs.write(temporary) { writeUtf8(text) }
        fs.atomicMove(temporary, target)
    }

    companion object {
        const val MAX_ITEMS = 3000
        const val MAX_SESSIONS = 60
        fun sha(text: String) = text.encodeUtf8().sha256().hex()
    }
}
