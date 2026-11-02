package dev.amo.studio

import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.view.KeyEvent
import android.view.inputmethod.InputMethodManager
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.util.Log
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises only the public phone UI against the isolated fixture, never a real model. */
@RunWith(AndroidJUnit4::class)
class UiFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun phase(label: String) { Log.i("AmoUiFlow", label) }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun waitFor(matcher: SemanticsMatcher) { compose.waitUntil(60_000) { exists(matcher) } }
    private fun waitEnabled(tag: String) { compose.waitUntil(60_000) { exists(hasTestTag(tag) and isEnabled()) } }
    private fun hideKeyboard() { compose.runOnIdle { val activity = compose.activity; (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(activity.window.decorView.windowToken, 0) }; compose.waitForIdle() }
    private fun screenshot(name: String, hideIme: Boolean = true) {
        phase("screenshot start: $name")
        if (hideIme) hideKeyboard()
        compose.waitForIdle()
        val target = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots/$name.png")
        target.parentFile!!.mkdirs()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        checkNotNull(bitmap) { "Screenshot unavailable" }
        target.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
        phase("screenshot saved: $name")
    }
    private fun fill(tag: String, value: String) { compose.onNodeWithTag(tag).performScrollTo().performTextReplacement(value) }
    private fun clickLink(paragraph: String, label: String) {
        waitFor(hasText(paragraph, substring = true))
        val node = compose.onNodeWithText(paragraph, substring = true)
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> action(layouts) }
        val layout = layouts.first()
        val offset = layout.layoutInput.text.text.indexOf(label)
        check(offset >= 0) { "Link label missing from laid out paragraph" }
        val hit = layout.getBoundingBox(offset + label.length / 2).center
        node.performTouchInput { click(hit) }
    }
    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findWebView(view.getChildAt(i))?.let { return it }
        return null
    }
    private fun webScript(script: String): String {
        val completed = CountDownLatch(1)
        var result = "null"
        instrumentation.runOnMainSync {
            val web = checkNotNull(findWebView(compose.activity.window.decorView)) { "No native WebView in viewer" }
            web.evaluateJavascript(script) { value -> result = value ?: "null"; completed.countDown() }
        }
        assertTrue("WebView JavaScript callback", completed.await(15, TimeUnit.SECONDS))
        return result
    }
    private fun awaitWebContent(expected: String) {
        waitFor(hasTestTag("file-html-ready"))
        val text = JSONTokener(webScript("document.body.innerText")).nextValue().toString()
        assertTrue("Rendered HTML contains $expected", text.contains(expected))
        val visual = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val web = checkNotNull(findWebView(compose.activity.window.decorView))
            web.postVisualStateCallback(System.nanoTime(), object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) { web.postInvalidateOnAnimation(); web.postOnAnimation { web.postOnAnimation { visual.countDown() } } }
            })
        }
        assertTrue("WebView produced a drawable frame", visual.await(15, TimeUnit.SECONDS))
        instrumentation.waitForIdleSync()
    }
    private fun rotateAndAwait(requested: Int, expected: Int) {
        phase("rotation request: $expected")
        compose.runOnIdle { compose.activity.requestedOrientation = requested }
        compose.waitUntil(30_000) {
            val activity = runCatching { compose.activity }.getOrNull()
            if (activity == null || activity.isChangingConfigurations || activity.isFinishing) false else {
                val decor = activity.window.decorView
                activity.resources.configuration.orientation == expected && decor.isAttachedToWindow &&
                    if (expected == Configuration.ORIENTATION_LANDSCAPE) decor.width > decor.height else decor.height > decor.width
            }
        }
        // A semantic node can survive while SurfaceFlinger still displays the old
        // orientation. Wait for the new window's frames and settled accessibility.
        val drawn = CountDownLatch(1)
        instrumentation.runOnMainSync { val decor = compose.activity.window.decorView; decor.postInvalidateOnAnimation(); decor.postOnAnimation { decor.postOnAnimation { drawn.countDown() } } }
        assertTrue("Rotated window produced frames", drawn.await(10, TimeUnit.SECONDS))
        instrumentation.uiAutomation.waitForIdle(500, 10_000)
        compose.waitForIdle()
        waitFor(hasTestTag("chat-input"))
        compose.onNodeWithTag("chat-input").assertIsDisplayed()
        compose.onNodeWithTag("chat-send").assertIsDisplayed()
        phase("rotation ready: $expected")
    }

    private fun back() { compose.onNodeWithTag("back").performClick(); compose.waitForIdle() }
    private fun pressBack() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }

    @Test fun loginPairCreateChatViewAndThemes() {
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/amo-android-test.json")
        val credentials = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { JSONObject(it.readText()) }
        compose.waitUntil(60_000) { exists(hasTestTag("login-server")) || exists(hasTestTag("settings")) || exists(hasTestTag("back")) }
        // A signed-in phone reopens the last conversation (2026-10-31); give the cached tasks a moment, then go home.
        Thread.sleep(1500); compose.waitForIdle()
        repeat(4) { if (!exists(hasTestTag("settings")) && !exists(hasTestTag("login-server")) && exists(hasTestTag("back"))) back() }
        if (exists(hasTestTag("settings"))) {
            compose.onNodeWithTag("settings").performClick()
            compose.onNodeWithTag("theme-light").performScrollTo().performClick()
            compose.onNodeWithTag("logout").performScrollTo().performClick()
        }
        waitFor(hasTestTag("login-server"))
        screenshot("login-light")
        fill("login-server", credentials.getString("server"))
        fill("login-name", credentials.getString("name"))
        fill("login-password", credentials.getString("password"))
        hideKeyboard()
        compose.onNodeWithTag("login-submit").performScrollTo().performClick()
        waitFor(hasTestTag("tasks"))
        val online = hasText("Android fixture host · 在线")
        val availableHost = hasTestTag("peer-available") and hasText("Android fixture host")
        phase("waiting for paired or available fixture host")
        waitFor(online or availableHost)
        if (!exists(online)) {
            phase("request fixture pairing")
            runCatching { compose.onNode(availableHost).performClick() }.getOrElse { error -> if (!exists(online)) throw error }
        }
        phase("waiting for paired fixture host online")
        waitFor(online)
        waitFor(hasTestTag("task-row"))
        screenshot("home-light")
        waitEnabled("task-create")
        compose.onNodeWithTag("task-create").performClick()
        val title = "手机界面验收 ${System.currentTimeMillis()}"
        val initial = "请检查手机端任务流程，并用中文回复。"
        waitFor(hasTestTag("create-title"))
        fill("create-title", title)
        fill("create-text", initial)
        hideKeyboard()
        screenshot("create-task-light")
        waitEnabled("create-submit")
        compose.onNodeWithTag("create-submit").performScrollTo().performClick()
        waitFor(hasTestTag("chat-input"))
        waitFor(hasText("FAKE: $initial", substring = true))
        screenshot("chat-light")

        compose.onNodeWithTag("chat-input").performClick().performTextReplacement("继续检查消息发送和同步。")
        compose.waitUntil(10_000) {
            var visible = false
            compose.runOnIdle { visible = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
            visible
        }
        compose.onNodeWithTag("chat-input").assertIsDisplayed()
        compose.onNodeWithTag("chat-send").assertIsDisplayed()
        screenshot("chat-keyboard-light", hideIme = false)
        hideKeyboard(); waitEnabled("chat-send"); compose.onNodeWithTag("chat-send").performClick()
        waitFor(hasText("FAKE: 继续检查消息发送和同步。", substring = true))
        compose.onNodeWithTag("chat-input").performTextReplacement("\n[查看报告](sample.html)")
        hideKeyboard(); waitEnabled("chat-send"); compose.onNodeWithTag("chat-send").performClick()
        clickLink("FAKE: 查看报告", "查看报告")
        waitFor(hasText("sample.html"))
        awaitWebContent("Android viewer fixture")
        assertEquals("Inline report button exists", "true", webScript("document.getElementById('fixture-toggle') !== null"))
        webScript("document.getElementById('fixture-toggle').click()")
        awaitWebContent("已切换")
        screenshot("viewer-light")
        webScript("document.querySelector('a[href=\"nested/view.html\"]').click()")
        waitFor(hasText("view.html"))
        awaitWebContent("Nested fixture page")
        screenshot("viewer-nested-html-light")
        webScript("document.querySelector('a[href=\"readme.md\"]').click()")
        waitFor(hasText("readme.md"))
        waitFor(hasText("Nested fixture Markdown"))
        screenshot("viewer-nested-markdown-light")
        back()

        // Rotation must preserve both selected session and the draft.
        compose.onNodeWithTag("chat-input").performTextReplacement("旋转屏幕后保留这份草稿")
        hideKeyboard()
        rotateAndAwait(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, Configuration.ORIENTATION_LANDSCAPE)
        waitFor(hasTestTag("chat-input")); compose.onNodeWithTag("chat-input").assertTextContains("旋转屏幕后保留这份草稿")
        screenshot("chat-landscape")
        rotateAndAwait(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT)
        waitFor(hasTestTag("chat-input")); compose.onNodeWithTag("chat-input").assertTextContains("旋转屏幕后保留这份草稿")
        compose.onNodeWithTag("chat-input").performTextReplacement("")
        back()
        waitFor(hasTestTag("session-create"))
        waitEnabled("session-create")
        screenshot("sessions-light")
        compose.onNodeWithTag("session-create").performClick()
        waitFor(hasTestTag("create-text"))
        fill("create-text", "这是同一任务下的第二个会话。")
        hideKeyboard(); waitEnabled("create-submit"); compose.onNodeWithTag("create-submit").performScrollTo().performClick()
        waitFor(hasText("FAKE: 这是同一任务下的第二个会话。", substring = true))

        back(); waitFor(hasTestTag("session-create")); back()
        waitFor(hasTestTag("settings"))
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithTag("theme-dark").performScrollTo().performClick()
        screenshot("settings-dark")
        back()
        waitFor(hasTestTag("tasks")); screenshot("home-dark")
        compose.onNodeWithTag("tasks").performScrollToNode(hasText(title))
        compose.onNodeWithText(title).performClick()
        waitFor(hasTestTag("session-row")); screenshot("sessions-dark")
        compose.onAllNodesWithTag("session-row")[0].performClick()
        waitFor(hasTestTag("chat-input")); screenshot("chat-dark")
        back(); waitFor(hasTestTag("session-create")); back(); waitFor(hasTestTag("tasks"))

        // The long simulated session (fixture --seed-long): folded tool calls, Markdown, pending approval and question.
        val long = hasText("手机端改版：长会话（模拟）")
        if (exists(long)) {
            compose.onNodeWithTag("tasks").performScrollToNode(long)
            compose.onNode(long).performClick()
            waitFor(hasText("重做手机端对话页")); screenshot("task-long-dark")
            compose.onNodeWithText("重做手机端对话页").performClick()
            waitFor(hasTestTag("approval") or hasTestTag("question") or hasTestTag("chat-pinned"))
            screenshot("chat-long-dark")
            compose.onNodeWithTag("chat-messages").performScrollToIndex(6)
            compose.waitForIdle(); screenshot("chat-long-history-dark")
            val running = hasTestTag("ops-row") and hasText("1 个操作", substring = true)
            compose.onNodeWithTag("chat-messages").performScrollToNode(running)
            compose.onNode(running).performClick()
            waitFor(hasTestTag("tool-row")); screenshot("chat-long-ops-dark")
            compose.onAllNodesWithTag("tool-row")[0].performClick()
            waitFor(hasTestTag("tool-detail")); screenshot("chat-long-detail-dark")
            pressBack()
            compose.waitUntil(10_000) { !exists(hasTestTag("tool-detail")) }
            back(); back(); waitFor(hasTestTag("settings"))
            compose.onNodeWithTag("settings").performClick()
            compose.onNodeWithTag("theme-light").performScrollTo().performClick()
            back(); waitFor(hasTestTag("tasks"))
            compose.onNodeWithTag("tasks").performScrollToNode(long)
            compose.onNode(long).performClick()
            compose.onNodeWithText("重做手机端对话页").performClick()
            waitFor(hasTestTag("chat-messages")); screenshot("chat-long-light")
            compose.onNodeWithTag("chat-messages").performScrollToIndex(6)
            compose.waitForIdle(); screenshot("chat-long-history-light")
            back(); back(); waitFor(hasTestTag("tasks"))
        }
        compose.onNodeWithTag("settings").performClick()
        compose.onNodeWithTag("theme-light").performScrollTo().performClick()
        screenshot("settings-light")
    }
}
