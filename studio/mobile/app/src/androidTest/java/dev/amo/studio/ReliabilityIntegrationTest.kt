package dev.amo.studio

import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest

/** Explicitly mock-only: invoke this class separately from the real-model round trip. */
@RunWith(AndroidJUnit4::class)
class ReliabilityIntegrationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)
    private suspend fun await(repository: StudioRepository, label: String, predicate: (StudioState) -> Boolean): StudioState {
        try {
            return withTimeout(60_000) { while (!predicate(repository.state.value)) delay(50); repository.state.value }
        } catch (failure: TimeoutCancellationException) {
            val s = repository.state.value
            val safe = s.message?.let { text -> s.account?.key?.takeIf { it.isNotEmpty() }?.let { text.replace(it, "[redacted]") } ?: text }
            throw AssertionError("$label timed out (connected=${s.connected}, busy=${s.busy}, revoked=${s.selectedTask?.revoked}, message=$safe)", failure)
        }
    }

    @Test fun mockApprovalQuestionReconnectRevocationAndFiles(): Unit = runBlocking {
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/amo-android-test.json")
        val credentials = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { JSONObject(it.readText()) }
        val client = OkHttpClient()
        val control = credentials.getString("control").trimEnd('/')
        fun call(path: String, post: Boolean = true): JSONObject {
            val request = Request.Builder().url(control + path)
            if (post) request.post("{}".toRequestBody("application/json".toMediaType()))
            return client.newCall(request.build()).execute().use { response ->
                check(response.isSuccessful) { "Mock control $path failed (${response.code})" }
                JSONObject(response.body?.string() ?: "{}")
            }
        }
        val fixture = call("/status", false)
        check(fixture.str("modelMode") == "mock") { "Reliability controls require an isolated mock fixture" }
        check(credentials.getString("name").startsWith("android-")) { "Reliability controls require a disposable fixture account" }
        val taskId = fixture.getString("taskId")
        val sessionId = fixture.getString("sessionId")
        lateinit var repository: StudioRepository
        main { repository = StudioRepository(instrumentation.targetContext); repository.logout(); repository.login(credentials.getString("server"), credentials.getString("name"), credentials.getString("password")) }
        var primaryFailure: Throwable? = null
        try {
            val ready = await(repository, "login and peer discovery") { it.connected && it.onlineDevices.isNotEmpty() }
            val device = fixture.getJSONObject("device").str("id")
            val host = ready.onlineDevices.first { it.device == device }
            main { repository.requestPair(host.account, host.device) }
            await(repository, "fixture granted task") { it.tasks.any { t -> t.id == taskId && !t.revoked } }
            main { repository.selectTask(repository.state.value.tasks.first { it.id == taskId }) }
            await(repository, "fixture session discovered") { it.sessions.any { s -> s.id == sessionId } }
            main { repository.selectSession(repository.state.value.sessions.first { it.id == sessionId }) }
            await(repository, "fixture initial history") { it.items.any { row -> row.str("type") == "agent" && !row.optBoolean("streaming") } }

            call("/approval")
            val approval = await(repository, "pending approval pushed") { it.items.any { row -> row.str("type") == "approval" && row.str("state") == "pending" } }.items.first { it.str("type") == "approval" && it.str("state") == "pending" }
            main { repository.approve(approval, "accept") }
            await(repository, "approval accepted and model resumed") { !it.busy && it.items.any { row -> row.str("type") == "agent" && row.str("markdown").contains("FAKE-RAN") && !row.optBoolean("streaming") } }

            call("/question")
            val question = await(repository, "pending question pushed") { it.items.any { row -> row.str("type") == "question" && row.str("state") == "pending" } }.items.first { it.str("type") == "question" && it.str("state") == "pending" }
            val answers = question.objects("questions").map { prompt -> JSONObject().put("id", prompt.str("id")).put("selected", JSONArray()).put("other", if (prompt.optBoolean("secret")) "fixture-placeholder" else "Android reliability answer") }
            main { repository.answer(question, JSONObject().put("action", "answer").put("answers", JSONArray(answers))) }
            await(repository, "question answered and model resumed") { !it.busy && it.items.any { row -> row.str("type") == "agent" && row.str("markdown").contains("FAKE-ANSWERS:") && !row.optBoolean("streaming") } }

            for ((path, expectedKind) in listOf("sample.md" to "markdown", "sample.png" to "image", "sample.html" to "html")) {
                main { repository.closeFile(); repository.openFile(path) }
                val viewed = await(repository, "$path file preview") { it.file?.path == path }.file!!
                assertEquals(expectedKind, viewed.kind)
                assertTrue(viewed.bytes.isNotEmpty())
            }
            // A relative path can name the tool's working folder; absolute A paths stay on A.
            main { repository.closeFile(); repository.openFile("sample.txt", "任务文件夹") }
            await(repository, "cwd-relative file preview") { it.file?.kind == "text" }
            val absolute = fixture.getString("workspace").trimEnd('/', '\\') + "/sample.txt"
            main { repository.closeFile(); repository.openFile(absolute) }
            assertTrue(String(await(repository, "absolute remote file path") { it.file?.path == "sample.txt" && it.fileLoading == null }.file!!.bytes, Charsets.UTF_8).contains("Android fixture text"))
            main { repository.closeFile(); repository.openFile("large.txt") }
            val large = await(repository, "multiple file chunks assembled") { it.file?.path == "large.txt" && it.fileLoading == null }.file!!
            assertEquals(1_048_600, large.bytes.size)
            val largeHash = MessageDigest.getInstance("SHA-256").digest(large.bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
            assertEquals("e6c85f03a311ea263bf066423c7ac53286cac1b59fab425ab38623862184af4a", largeHash)
            main { repository.closeFile(); repository.openFile("readme.md", "任务文件夹/nested") }
            val nested = await(repository, "nested cwd file canonical path") { it.file?.path == "nested/readme.md" && it.fileLoading == null }.file!!
            assertEquals("markdown", nested.kind)
            main { repository.openFile("nested/../sample.png") }
            await(repository, "nested parent image canonical path") { it.file?.path == "sample.png" && it.fileLoading == null }

            call("/reconnect")
            await(repository, "remote peer went offline") { it.selectedTask?.peer?.online == false }
            await(repository, "remote peer reconnected and history synchronized") { it.selectedTask?.peer?.online == true && it.items.any { row -> row.str("type") == "question" && row.str("state") == "answered" } }

            call("/revoke")
            await(repository, "selected task authorization revoked") { it.selectedTask?.revoked == true }
            val count = repository.state.value.items.count { it.str("type") == "user" }
            main { repository.clearMessage(); repository.send("This message must not reach the revoked task") }
            await(repository, "revoked mutation rejected") { !it.busy && it.message?.contains("撤回") == true }
            assertEquals(count, repository.state.value.items.count { it.str("type") == "user" })
            call("/regrant")
            await(repository, "selected task authorization restored") { it.selectedTask?.revoked == false }
            main { repository.refresh() }
            await(repository, "restored history preserved without revoked mutation") { it.selectedTask?.revoked == false && it.selectedTask?.peer?.online == true && it.items.none { row -> row.str("text").contains("must not reach") } }
        } catch (failure: Throwable) { primaryFailure = failure; throw failure }
        finally {
            try { main { repository.close() } } catch (cleanupFailure: Throwable) { primaryFailure?.addSuppressed(cleanupFailure) ?: throw cleanupFailure }
            client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
        }
    }
}
