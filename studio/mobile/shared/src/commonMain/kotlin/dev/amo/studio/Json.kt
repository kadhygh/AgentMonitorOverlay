package dev.amo.studio

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// org.json's JSONObject and JSONArray as Android has them, for code shared with iOS (2026-11-02, plans/ios.md 第 2 步).
// The Android app was written against Android's built-in org.json; rewriting its hundred-odd uses to kotlinx's immutable
// JsonObject would have changed behaviour in many small places. So: the same names and the same rules (Android's, not
// the newer Maven org.json's): optString of a JSON null is "null", optLong/optInt/optBoolean coerce strings, put(name,
// null) removes the name, integral doubles print without ".0", names keep their insertion order. Parsing and printing
// go through kotlinx.serialization. equals/hashCode stay identity (Entry relies on that).

class JSONException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

class JSONObject() {
    private val map = LinkedHashMap<String, Any>()
    /** Something computed from this object, kept with it (Markdown.kt: the parsed text). Not part of the JSON. */
    internal var memo: Any? = null

    constructor(text: String) : this() {
        val element = parse(text)
        if (element !is JsonObject) throw JSONException("Value is not a JSON object")
        for ((k, v) in element) map[k] = fromElement(v)
    }

    constructor(copyFrom: Map<*, *>) : this() {
        for ((k, v) in copyFrom) if (v != null) map[k.toString()] = wrap(v)
    }

    fun put(name: String, value: Any?): JSONObject {
        if (value == null) map.remove(name) else map[name] = wrap(value)
        return this
    }

    fun opt(name: String): Any? = map[name]
    fun get(name: String): Any = map[name] ?: throw JSONException("No value for $name")
    fun has(name: String): Boolean = map.containsKey(name)
    fun isNull(name: String): Boolean = map[name].let { it == null || it === NULL }
    fun remove(name: String): Any? = map.remove(name)
    fun keys(): Iterator<String> = map.keys.toList().iterator()
    fun length(): Int = map.size

    fun optString(name: String, fallback: String = ""): String = asString(opt(name)) ?: fallback
    fun getString(name: String): String = asString(get(name)) ?: throw JSONException("Value at $name is not a string")
    fun optBoolean(name: String, fallback: Boolean = false): Boolean = asBoolean(opt(name)) ?: fallback
    fun getBoolean(name: String): Boolean = asBoolean(get(name)) ?: throw JSONException("Value at $name is not a boolean")
    fun optInt(name: String, fallback: Int = 0): Int = asLong(opt(name))?.toInt() ?: fallback
    fun getInt(name: String): Int = asLong(get(name))?.toInt() ?: throw JSONException("Value at $name is not an int")
    fun optLong(name: String, fallback: Long = 0L): Long = asLong(opt(name)) ?: fallback
    fun getLong(name: String): Long = asLong(get(name)) ?: throw JSONException("Value at $name is not a long")
    fun optDouble(name: String, fallback: Double = Double.NaN): Double = asDouble(opt(name)) ?: fallback
    fun optJSONObject(name: String): JSONObject? = opt(name) as? JSONObject
    fun getJSONObject(name: String): JSONObject = get(name) as? JSONObject ?: throw JSONException("Value at $name is not a JSONObject")
    fun optJSONArray(name: String): JSONArray? = opt(name) as? JSONArray
    fun getJSONArray(name: String): JSONArray = get(name) as? JSONArray ?: throw JSONException("Value at $name is not a JSONArray")

    internal fun toElement(): JsonElement = JsonObject(map.mapValues { (_, v) -> toElement(v) })
    override fun toString(): String = toElement().toString()

    companion object {
        /** JSON's null as a value (Android: JSONObject.NULL; equal to null). */
        // Another name in the iOS framework's header: NULL there is C's macro and broke the Swift build (2026-11-02).
        @OptIn(kotlin.experimental.ExperimentalObjCName::class)
        @kotlin.native.ObjCName("jsonNull")
        val NULL: Any = object {
            override fun equals(other: Any?) = other == null || other === this
            override fun hashCode() = 0
            override fun toString() = "null"
        }
    }
}

class JSONArray() {
    private val list = ArrayList<Any>()

    constructor(text: String) : this() {
        val element = parse(text)
        if (element !is JsonArray) throw JSONException("Value is not a JSON array")
        for (v in element) list += fromElement(v)
    }

    constructor(items: Collection<*>) : this() {
        for (v in items) list += if (v == null) JSONObject.NULL else wrap(v)
    }

    fun put(value: Any?): JSONArray { list += if (value == null) JSONObject.NULL else wrap(value); return this }
    fun length(): Int = list.size
    fun opt(index: Int): Any? = list.getOrNull(index)
    fun get(index: Int): Any = list.getOrNull(index) ?: throw JSONException("Index $index out of range [0..${list.size})")
    fun isNull(index: Int): Boolean = opt(index).let { it == null || it === JSONObject.NULL }
    fun optString(index: Int, fallback: String = ""): String = asString(opt(index)) ?: fallback
    fun getString(index: Int): String = asString(get(index)) ?: throw JSONException("Value at $index is not a string")
    fun optBoolean(index: Int, fallback: Boolean = false): Boolean = asBoolean(opt(index)) ?: fallback
    fun optInt(index: Int, fallback: Int = 0): Int = asLong(opt(index))?.toInt() ?: fallback
    fun optLong(index: Int, fallback: Long = 0L): Long = asLong(opt(index)) ?: fallback
    fun optJSONObject(index: Int): JSONObject? = opt(index) as? JSONObject
    fun getJSONObject(index: Int): JSONObject = get(index) as? JSONObject ?: throw JSONException("Value at $index is not a JSONObject")
    fun optJSONArray(index: Int): JSONArray? = opt(index) as? JSONArray

    internal fun toElement(): JsonElement = JsonArray(list.map(::toElement))
    override fun toString(): String = toElement().toString()
}

private fun parse(text: String): JsonElement = try { Json.parseToJsonElement(text) } catch (e: Exception) { throw JSONException(e.message ?: "Not JSON", e) }

/** A parsed value as org.json keeps it: String, Boolean, Long, Double, JSONObject, JSONArray or NULL. */
private fun fromElement(e: JsonElement): Any = when (e) {
    is JsonNull -> JSONObject.NULL
    is JsonObject -> JSONObject().also { o -> for ((k, v) in e) o.put(k, fromElement(v)) }
    is JsonArray -> JSONArray().also { a -> for (v in e) a.put(fromElement(v)) }
    is JsonPrimitive -> when {
        e.isString -> e.content
        e.content == "true" -> true
        e.content == "false" -> false
        else -> e.content.let { c -> if (c.any { it == '.' || it == 'e' || it == 'E' }) c.toDouble() else c.toLongOrNull() ?: c.toDouble() }
    }
}

/** What put() stores for a value: JSON values as they are, collections and maps as JSON, anything else as its text. */
private fun wrap(v: Any): Any = when (v) {
    is JSONObject, is JSONArray, is String, is Boolean, is Long, is Double -> v
    is Int, is Short, is Byte -> (v as Number).toLong()
    is Float -> v.toDouble()
    is Collection<*> -> JSONArray(v)
    is Map<*, *> -> JSONObject(v)
    else -> if (v == JSONObject.NULL) JSONObject.NULL else v.toString()
}

private fun toElement(v: Any): JsonElement = when (v) {
    is JSONObject -> v.toElement()
    is JSONArray -> v.toElement()
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Long -> JsonPrimitive(v)
    is Double -> {
        if (v.isNaN() || v.isInfinite()) throw JSONException("Forbidden numeric value: $v")
        // Android prints an integral double as a long: 2.0 → 2.
        val l = v.toLong()
        if (l.toDouble() == v) JsonPrimitive(l) else JsonPrimitive(v)
    }
    else -> JsonNull
}

private fun asString(v: Any?): String? = when (v) {
    null -> null
    is String -> v
    else -> v.toString()
}

private fun asBoolean(v: Any?): Boolean? = when (v) {
    is Boolean -> v
    is String -> when (v.lowercase()) { "true" -> true; "false" -> false; else -> null }
    else -> null
}

private fun asLong(v: Any?): Long? = when (v) {
    is Long -> v
    is Double -> v.toLong()
    is String -> v.toDoubleOrNull()?.toLong()
    else -> null
}

private fun asDouble(v: Any?): Double? = when (v) {
    is Long -> v.toDouble()
    is Double -> v
    is String -> v.toDoubleOrNull()
    else -> null
}
