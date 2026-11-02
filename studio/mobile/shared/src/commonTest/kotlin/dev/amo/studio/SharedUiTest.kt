package dev.amo.studio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

// What 2b (2026-11-02, plans/ios.md) wrote anew in place of Android-only calls: Uri.decode, "%.1f", the WeakHashMap.
class SharedUiTest {
    @Test fun percentDecodeAsAndroidUri() {
        assertEquals("结果.md", percentDecode("%E7%BB%93%E6%9E%9C.md"))
        assertEquals("a+b c", percentDecode("a+b%20c"))
        assertEquals("plain", percentDecode("plain"))
        assertEquals("x\uFFFDz", percentDecode("x%zz"))
        assertEquals("end\uFFFD", percentDecode("end%2"))
        assertEquals("\uFFFD", percentDecode("%FF"))
    }

    @Test fun linksAsBefore() {
        // The same cases as the app's FilePolicyTest (on the emulator), here on the JVM.
        assertEquals("reports/结果.md", localFileTarget("https://amo.invalid/%E7%BB%93%E6%9E%9C.md#part", "reports/summary.html"))
        assertEquals("C:/work/结果.md", localFileTarget("file:///C:/work/%E7%BB%93%E6%9E%9C.md"))
        assertEquals("reports/../sample.md", localFileTarget("../sample.md", "reports/summary.html"))
        assertNull(localFileTarget("https://amo.invalid/#part", "reports/summary.html"))
        assertNull(localFileTarget("javascript:alert(1)", "report.html"))
    }

    @Test fun megabytesWithOneDecimal() {
        assertEquals("0.0", megabytes(0))
        assertEquals("1.0", megabytes(1048576))
        assertEquals("12.3", megabytes(12_900_000))
        assertEquals("1.5", megabytes(1572864))
    }

    @Test fun markdownParsedOncePerText() {
        val item = JSONObject().put("text", "**粗体**")
        val first = markdownOf(item, "text")
        assertSame(first, markdownOf(item, "text"))
        item.put("text", "改了")
        assertEquals(false, first === markdownOf(item, "text"))
    }
}
