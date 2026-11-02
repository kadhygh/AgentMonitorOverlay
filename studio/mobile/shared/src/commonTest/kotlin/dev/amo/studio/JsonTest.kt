package dev.amo.studio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone

// Json.kt promises Android's org.json rules (2026-11-02, plans/ios.md 第 2 步): the app's code relies on them.
class JsonTest {
    @Test fun keepsOrderAndPrintsCompact() {
        val o = JSONObject("""{"b":1,"a":"x","c":{"d":[1,"two",true,null]}}""")
        assertEquals("""{"b":1,"a":"x","c":{"d":[1,"two",true,null]}}""", o.toString())
        assertEquals(listOf("b", "a", "c"), o.keys().asSequence().toList())
    }

    @Test fun nullAndMissingAsAndroidHasThem() {
        val o = JSONObject("""{"n":null,"s":"v"}""")
        assertEquals("null", o.optString("n"))
        assertEquals("fallback", o.str("n", "fallback"))
        assertEquals("", o.optString("missing"))
        assertTrue(o.isNull("n")); assertTrue(o.isNull("missing")); assertFalse(o.isNull("s"))
        assertTrue(o.has("n")); assertFalse(o.has("missing"))
        assertTrue(o.opt("n") == JSONObject.NULL)
        assertNull(o.opt("missing"))
    }

    @Test fun coercesLikeAndroid() {
        val o = JSONObject("""{"num":"12","dbl":3.9,"t":"TRUE","f":"false","int":7,"big":12345678901,"txt":"abc"}""")
        assertEquals(12L, o.optLong("num"))
        assertEquals(3L, o.optLong("dbl"))
        assertEquals(3, o.optInt("dbl"))
        assertTrue(o.optBoolean("t")); assertFalse(o.optBoolean("f", true))
        assertEquals(7, o.optInt("int"))
        assertEquals(12345678901L, o.getLong("big"))
        assertEquals(-1, o.optInt("missing", -1))
        assertEquals(5L, o.optLong("txt", 5L))
        assertEquals("7", o.getString("int"))
        assertEquals("3.9", o.optString("dbl"))
        assertFailsWith<JSONException> { o.getLong("missing") }
        assertFailsWith<JSONException> { o.getBoolean("txt") }
    }

    @Test fun putFollowsAndroid() {
        val o = JSONObject().put("a", 1).put("b", "x").put("c", true).put("d", 2.0).put("e", 2.5).put("f", JSONObject.NULL)
        assertEquals("""{"a":1,"b":"x","c":true,"d":2,"e":2.5,"f":null}""", o.toString())
        o.put("b", null)
        assertFalse(o.has("b"))
        o.put("list", listOf(JSONObject().put("k", 1), "s"))
        assertEquals("""[{"k":1},"s"]""", o.optJSONArray("list").toString())
        assertFailsWith<JSONException> { JSONObject().put("x", Double.NaN).toString() }
    }

    @Test fun escapesRoundTrip() {
        val text = "引号\" 反斜杠\\ 换行\n 制表\t 控制\u0001 表情😀 斜杠/"
        val o = JSONObject().put("t", text)
        assertEquals(text, JSONObject(o.toString()).getString("t"))
    }

    @Test fun arraysAndHelpers() {
        val a = JSONArray("""[{"id":"1"},{"id":"2"},3,"x"]""")
        assertEquals(4, a.length())
        assertEquals("2", a.optJSONObject(1)?.str("id"))
        assertNull(a.optJSONObject(2))
        assertEquals("x", a.optString(3))
        assertEquals("3", a.optString(2))
        val o = JSONObject().put("items", a)
        assertEquals(listOf("1", "2"), o.objects("items").map { it.str("id") })
        assertEquals(emptyList(), o.objects("missing"))
        val copy = JSONArray(listOf(JSONObject().put("x", 1), null))
        assertEquals("""[{"x":1},null]""", copy.toString())
    }

    @Test fun mapsAndCopies() {
        val inner = JSONObject().put("v", 1)
        val o = JSONObject(mapOf("k" to inner))
        assertSame(inner, o.optJSONObject("k"))
        // A shallow copy (StudioRepository's delta): the old row stays as it was.
        val copy = JSONObject(); for (name in o.keys()) copy.put(name, o.opt(name))
        copy.put("extra", 1)
        assertFalse(o.has("extra"))
    }

    @Test fun identityEquality() {
        val a = JSONObject("""{"x":1}"""); val b = JSONObject("""{"x":1}""")
        assertNotEquals(a, b)
        assertEquals(a, a)
        assertNotEquals(Entry(a), Entry(b))
        assertEquals(Entry(a), Entry(a))
    }

    @Test fun rejectsWhatIsNotJson() {
        assertFailsWith<JSONException> { JSONObject("not json") }
        assertFailsWith<JSONException> { JSONObject("[1]") }
        assertFailsWith<JSONException> { JSONArray("{}") }
    }

    @OptIn(ExperimentalTime::class)
    @Test fun shortTimes() {
        val now = Instant.parse("2026-11-02T10:00:00Z")
        assertEquals("09:05", shortTime("2026-11-02T09:05:00.123Z", now, TimeZone.UTC))
        assertEquals("昨天 23:59", shortTime("2026-11-01T23:59:00Z", now, TimeZone.UTC))
        assertEquals("10-29", shortTime("2026-10-29T08:00:00Z", now, TimeZone.UTC))
        assertEquals("", shortTime("", now, TimeZone.UTC))
        assertEquals("", shortTime("garbage", now, TimeZone.UTC))
    }
}
