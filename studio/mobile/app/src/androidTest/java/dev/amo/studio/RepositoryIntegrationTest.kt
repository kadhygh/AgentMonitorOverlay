package dev.amo.studio

import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Runs against the isolated Relay + real Host fixture; credentials are provisioned outside the APK. */
@RunWith(AndroidJUnit4::class)
class RepositoryIntegrationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)
    private suspend fun await(repository: StudioRepository, label: String, predicate: (StudioState) -> Boolean): StudioState {
        try {
            return withTimeout(180_000) {
                while (!predicate(repository.state.value)) delay(100)
                repository.state.value.also { assertTrue(label, predicate(it)) }
            }
        } catch (failure: TimeoutCancellationException) {
            val s = repository.state.value
            val safeMessage = s.message?.let { text -> s.account?.key?.takeIf { it.isNotEmpty() }?.let { text.replace(it, "[redacted]") } ?: text }
            throw AssertionError("$label timed out (connected=${s.connected}, busy=${s.busy}, message=$safeMessage)", failure)
        }
    }

    @Test fun remoteClientRoundTripAndRestore(): Unit = runBlocking {
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/amo-android-test.json")
        val credentials = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { JSONObject(it.readText()) }
        val context = instrumentation.targetContext
        lateinit var repository: StudioRepository
        main { repository = StudioRepository(context); repository.logout(); repository.login(credentials.getString("server"), credentials.getString("name"), credentials.getString("password")) }
        var primaryFailure: Throwable? = null
        try {
            val online = await(repository, "logged in and discovered remote Host") { it.connected && it.onlineDevices.isNotEmpty() }
            val host = online.onlineDevices.first()
            main { repository.requestPair(host.account, host.device) }
            val paired = await(repository, "Host allowed device pairing") { it.peers.any { p -> p.device == host.device && p.online && p.role == "guest" } }
            val peer = paired.peers.first { it.device == host.device && it.role == "guest" }
            main { repository.selectPeer(peer) }
            val catalog = await(repository, "allowed model catalog loaded") { it.catalog != null && it.profiles.isNotEmpty() }
            val profile = catalog.profiles.first().first
            val project = catalog.catalog!!.objects("projects").firstOrNull()?.str("id")
            val title = "Android repository ${System.currentTimeMillis()}"
            main { repository.createTask(title, "Reply with only this exact literal string: \"ANDROID-REPOSITORY-INITIAL\". Do not use tools.", project, null, profile) }
            await(repository, "task creation automatically selects first session") { it.selectedTask?.title == title && it.sessions.isNotEmpty() && it.selectedSession != null && !it.busy }
            val task = repository.state.value.selectedTask!!
            val first = repository.state.value.selectedSession!!
            await(repository, "initial user message synchronized") { it.items.any { row -> row.str("type") == "user" && row.str("text").contains("ANDROID-REPOSITORY-INITIAL") } }
            await(repository, "initial model reply received") { !it.busy && it.items.any { row -> row.str("type") == "agent" && row.str("markdown").contains("ANDROID-REPOSITORY-INITIAL") && !row.optBoolean("streaming") } }
            main { repository.send("Reply with only this exact literal string: \"ANDROID-REPOSITORY-FOLLOWUP\". Do not use tools.") }
            await(repository, "follow-up delivered exactly once") { it.items.count { row -> row.str("type") == "user" && row.str("text").contains("ANDROID-REPOSITORY-FOLLOWUP") } == 1 }
            await(repository, "follow-up model reply received") { !it.busy && it.items.any { row -> row.str("type") == "agent" && row.str("markdown").contains("ANDROID-REPOSITORY-FOLLOWUP") && !row.optBoolean("streaming") } }
            main { repository.startSession(profile, "Reply with only this exact literal string: \"ANDROID-REPOSITORY-SECOND\". Do not use tools.") }
            await(repository, "new session selected") { it.selectedSession?.id != first.id && it.sessions.size >= 2 }
            await(repository, "new session history loaded") { it.items.any { row -> row.str("type") == "user" && row.str("text").contains("ANDROID-REPOSITORY-SECOND") } }
            await(repository, "new session completed model reply received") { !it.busy && it.items.any { row -> row.str("type") == "agent" && row.str("markdown").contains("ANDROID-REPOSITORY-SECOND") && !row.optBoolean("streaming") } }
            val second = repository.state.value.selectedSession!!
            val file = credentials.str("file")
            if (file.isNotEmpty()) {
                main { repository.openFile(file) }
                val viewed = await(repository, "chunked file loaded and hash checked") { it.file != null }.file!!
                assertTrue(viewed.bytes.isNotEmpty())
                credentials.str("fileContains").takeIf { it.isNotEmpty() }?.let { assertTrue(String(viewed.bytes, Charsets.UTF_8).contains(it)) }
            }
            delay(1000) // Allow the bounded cache debounce to commit before simulating process death.
            main { repository.close(); repository = StudioRepository(context) }
            await(repository, "account token, cached peers and partitioned tasks restored") { it.account != null && it.peers.any { p -> p.identity == task.peer.identity } && it.tasks.any { t -> t.id == task.id && t.peer.identity == task.peer.identity } }
            val restored = repository.state.value.tasks.first { it.id == task.id && it.peer.identity == task.peer.identity }
            main { repository.selectTask(restored); repository.selectSession(second) }
            await(repository, "session history survives repository recreation") { it.items.any { row -> row.str("text").contains("ANDROID-REPOSITORY-SECOND") } }
            assertEquals(task.peer.identity, repository.state.value.selectedTask?.peer?.identity)
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            try { main { repository.close() } }
            catch (cleanupFailure: Throwable) { primaryFailure?.addSuppressed(cleanupFailure) ?: throw cleanupFailure }
        }
    }
}
