package dev.amo.studio

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FilePolicyTest {
    @Test fun linkedFilesKeepTaskRootAndRemotePlatformPaths() {
        assertEquals("sample.md", localFileTarget("sample.md", "sample.html"))
        assertEquals("reports/detail.md", localFileTarget("detail.md", "reports/summary.html"))
        assertEquals("reports/../sample.md", localFileTarget("../sample.md", "reports/summary.html"))
        assertEquals("reports/结果.md", localFileTarget("https://amo.invalid/%E7%BB%93%E6%9E%9C.md#part", "reports/summary.html"))
        assertEquals("C:\\work\\结果.md", localFileTarget("C:\\work\\结果.md", "reports/summary.html"))
        assertEquals("C:/work/结果.md", localFileTarget("file:///C:/work/%E7%BB%93%E6%9E%9C.md"))
        assertEquals("/work/result.md", localFileTarget("/work/result.md", "reports/summary.html"))
        assertEquals("/work/result.md", localFileTarget("file:///work/result.md"))
        assertNull(localFileTarget("#part", "reports/summary.html"))
        assertNull(localFileTarget("https://amo.invalid/#part", "reports/summary.html"))
    }

    @Test fun externalSchemesNeverBecomeRemoteFileRequests() {
        listOf("https://example.com/file", "https://amo.invalid.evil/file", "http://amo.invalid/file", "javascript:alert(1)", "data:text/html,hello", "content://private/file", "mailto:someone@example.com").forEach { target -> assertNull(target, localFileTarget(target, "report.html")) }
    }

    @Test fun isolatedReportsKeepInlineInteractionAndStandardsMode() {
        val input = "<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><button onclick=\"this.textContent='完成'\">切换</button><script>window.ready=true</script></body></html>"
        val output = isolatedHtml(input)
        assertTrue(output.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\""))
        assertEquals(1, Regex("(?i)<!doctype").findAll(output).count())
        assertTrue(output.contains("script-src 'unsafe-inline'"))
        listOf("connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "object-src 'none'", "base-uri 'none'").forEach { assertTrue(it, output.contains(it)) }
        assertTrue(output.indexOf("Content-Security-Policy") < output.indexOf("<script>"))
        assertTrue(output.contains("onclick=\"this.textContent='完成'\""))
        assertTrue(output.contains("<style>body{color:red}</style>"))
        val malformed = isolatedHtml("<script>window.early=true</script><head></head>")
        assertTrue(malformed.indexOf("Content-Security-Policy") < malformed.indexOf("window.early"))
    }
}
